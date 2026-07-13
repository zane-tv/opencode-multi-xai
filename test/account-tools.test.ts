import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshTokensMock } = vi.hoisted(() => ({
  refreshTokensMock: vi.fn(),
}));

vi.mock("../lib/auth/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth/oauth.js")>();
  return { ...actual, refreshTokens: refreshTokensMock };
});

import { AccountManager } from "../lib/accounts.js";
import { resetRefreshState } from "../lib/auth/refresh.js";
import { buildTools } from "../lib/tools/registry.js";
import { saveAccounts } from "../lib/storage.js";
import type { AccountMetadata, AccountStorage } from "../lib/schemas.js";
import type { ToolContext } from "@opencode-ai/plugin";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-tools-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  id: string,
  overrides: Partial<AccountMetadata> = {},
): AccountMetadata {
  return {
    accountId: id,
    tags: [],
    refreshToken: `rt-${id}`,
    enabled: true,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
}

async function writeStore(
  storePath: string,
  accounts: AccountMetadata[],
  activeIndex = 0,
): Promise<void> {
  const storage: AccountStorage = { version: 1, accounts, activeIndex };
  await saveAccounts(storage, storePath);
}

function ctx(): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe("account management tools", () => {
  let storePath: string;
  let manager: AccountManager;

  beforeEach(async () => {
    storePath = tmpStorePath();
    resetRefreshState();
    refreshTokensMock.mockReset();
    await writeStore(storePath, [
      makeAccount("acc-a", {
        email: "a@x.ai",
        label: "Alpha",
        tags: ["work"],
        quotaResetAt: Date.now() + 30 * 60_000,
      }),
      makeAccount("acc-b", {
        email: "b@x.ai",
        label: "Beta",
        tags: ["personal"],
      }),
    ]);
    manager = new AccountManager(storePath);
    await manager.load();
  });

  afterEach(async () => {
    await fs.unlink(storePath).catch(() => {});
  });

  it("xai-add explains OAuth login flow", async () => {
    const tools = buildTools(manager);
    const out = await tools["xai-add"]!.execute({}, ctx());
    expect(out).toContain("opencode auth login");
    expect(out).toContain("xai-multi");
  });

  it("xai-remove requires confirm=true", async () => {
    const tools = buildTools(manager);
    const denied = await tools["xai-remove"]!.execute({ index: 0 }, ctx());
    expect(denied).toContain("confirm=true");
    expect(manager.list()).toHaveLength(2);

    const ok = await tools["xai-remove"]!.execute(
      { index: 0, confirm: true },
      ctx(),
    );
    expect(ok).toContain("Removed");
    expect(manager.list()).toHaveLength(1);
  });

  it("xai-list can filter by tag", async () => {
    const tools = buildTools(manager);
    const out = await tools["xai-list"]!.execute({ tag: "work" }, ctx());
    expect(out).toContain("Alpha");
    expect(out).not.toContain("Beta");
  });

  it("xai-limits shows remaining or unknown without probe data", async () => {
    const tools = buildTools(manager);
    const out = await tools["xai-limits"]!.execute({}, ctx());
    expect(out).toContain("Alpha");
    expect(out).toMatch(/credits:|unknown/);
    expect(out).toContain("exhausted until");
  });

  it("xai-limits probe=true refreshes billing + API remaining", async () => {
    refreshTokensMock.mockResolvedValue({
      accessToken: "at-probe",
      refreshToken: "rt-probe",
      expiresAt: Date.now() + 3_600_000,
    });

    // Minimal grpc-web billing body: used 25% at path [1,1]
    function encVarint(v: number): number[] {
      const b: number[] = [];
      let x = v >>> 0;
      while (x >= 0x80) {
        b.push((x & 0x7f) | 0x80);
        x >>>= 7;
      }
      b.push(x);
      return b;
    }
    function f32(field: number, val: number): Uint8Array {
      const key = encVarint((field << 3) | 5);
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, val, true);
      return Uint8Array.from([...key, ...new Uint8Array(buf)]);
    }
    function ld(field: number, payload: Uint8Array): Uint8Array {
      const key = encVarint((field << 3) | 2);
      const len = encVarint(payload.length);
      return Uint8Array.from([...key, ...len, ...payload]);
    }
    const inner = f32(1, 25);
    const msg = ld(1, inner);
    const frame = Uint8Array.from([
      0,
      0,
      0,
      0,
      msg.length,
      ...msg,
    ]);

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("GetGrokCreditsConfig")) {
        return new Response(frame, {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto" },
        });
      }
      return new Response(JSON.stringify({ usage: { cost_in_usd_ticks: 1000 } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit-requests": "8300",
          "x-ratelimit-remaining-requests": "8123",
          "x-ratelimit-limit-tokens": "53000000",
          "x-ratelimit-remaining-tokens": "52000000",
        },
      });
    }) as typeof fetch;

    const tools = buildTools(manager);
    const out = await tools["xai-limits"]!.execute(
      { index: 0, probe: true },
      ctx(),
    );
    expect(out).toMatch(/credits:.*75% remaining|used 25/);
    expect(out).toContain("requests:");
    const a = manager.list()[0]!;
    expect(a.billingRemainingPercent).toBe(75);
    expect(a.rateLimitRemainingRequests).toBe(8123);
  });

  it("xai-health probes refresh for every account", async () => {
    refreshTokensMock.mockResolvedValue({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: Date.now() + 3_600_000,
    });
    const tools = buildTools(manager);
    const out = await tools["xai-health"]!.execute({}, ctx());
    expect(out).toContain("healthy");
    expect(refreshTokensMock).toHaveBeenCalled();
  });

  it("xai-label / xai-tag / xai-note edit metadata", async () => {
    const tools = buildTools(manager);
    await tools["xai-label"]!.execute({ index: 1, label: "Home" }, ctx());
    await tools["xai-tag"]!.execute({ index: 1, tags: "vip, home" }, ctx());
    await tools["xai-note"]!.execute({ index: 1, note: "backup" }, ctx());
    const b = manager.list()[1]!;
    expect(b.label).toBe("Home");
    expect(b.tags).toEqual(["vip", "home"]);
    expect(b.note).toBe("backup");
  });
});
