import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the network grant (refreshTokens); keep the rest of oauth intact.
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
import { loadAccounts, saveAccounts } from "../lib/storage.js";
import type { AccountMetadata, AccountStorage } from "../lib/schemas.js";
import type { ToolContext } from "@opencode-ai/plugin";

const HOUR = 3_600_000;

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-prune-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
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
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
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

/** Minimal ToolContext stub — the tools here never touch context. */
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

/** Count `${store}.bak-*` sibling backups. */
async function countBackups(storePath: string): Promise<number> {
  const dir = path.dirname(storePath);
  const base = `${path.basename(storePath)}.bak-`;
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((e) => e.startsWith(base)).length;
}

let storePath: string;

beforeEach(() => {
  storePath = tmpStorePath();
  refreshTokensMock.mockReset();
  resetRefreshState();
});

afterEach(async () => {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(base))
      .map((e) => fs.rm(path.join(dir, e), { force: true }).catch(() => {})),
  );
});

async function managerWith(
  accounts: AccountMetadata[],
  activeIndex = 0,
): Promise<AccountManager> {
  await writeStore(storePath, accounts, activeIndex);
  const mgr = new AccountManager(storePath);
  await mgr.load();
  return mgr;
}

describe("setFlaggedForRemoval", () => {
  it("sets the flag on disk + canonical without clobbering a rotated token", async () => {
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at",
        refreshToken: "rt-old",
        expiresAt: Date.now() + HOUR,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load(); // canonical holds rt-old

    // Another process rotates the refresh token durably on disk.
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at",
        refreshToken: "rt-rotated",
        expiresAt: Date.now() + HOUR,
      }),
    ]);

    await mgr.setFlaggedForRemoval("a0", true);
    expect(mgr.get("a0")?.flaggedForRemoval).toBe(true);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].flaggedForRemoval).toBe(true);
    // The non-token mutation must NOT regress the rotated refresh token.
    expect(onDisk.accounts[0].refreshToken).toBe("rt-rotated");
  });

  it("clears the flag", async () => {
    const mgr = await managerWith([
      makeAccount("a0", { flaggedForRemoval: true }),
    ]);
    await mgr.setFlaggedForRemoval("a0", false);
    expect(mgr.get("a0")?.flaggedForRemoval).toBe(false);
    expect((await loadAccounts(storePath)).accounts[0].flaggedForRemoval).toBe(
      false,
    );
  });
});

describe("prunableAccounts", () => {
  it("returns dead + flagged, excludes healthy AND quota-exhausted (B1 guard)", async () => {
    const now = Date.now();
    const mgr = await managerWith([
      makeAccount("healthy"),
      makeAccount("dead", { subscriptionStatus: "dead" }),
      makeAccount("flagged", { flaggedForRemoval: true }),
      // CRITICAL B1: quota-exhausted is RECOVERABLE, not expired subscription.
      makeAccount("quota", { quotaResetAt: now + HOUR }),
    ]);

    const ids = mgr.prunableAccounts().map((a) => a.accountId).sort();
    expect(ids).toEqual(["dead", "flagged"]);
    // The quota-exhausted-but-alive account must NOT be prunable.
    expect(ids).not.toContain("quota");
    expect(ids).not.toContain("healthy");
  });

  it("returns an empty list when nothing is prunable", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    expect(mgr.prunableAccounts()).toEqual([]);
  });
});

describe("pruneAccounts", () => {
  it("removes only targets, keeps others, fixes activeIndex, takes ONE backup, preserves rotated tokens", async () => {
    // activeIndex points at the last account (a2), which will be removed.
    await writeStore(
      storePath,
      [
        makeAccount("a0"),
        makeAccount("a1", { subscriptionStatus: "dead" }),
        makeAccount("a2", { flaggedForRemoval: true }),
      ],
      2,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load(); // canonical holds rt-a0 for a0

    // Another process rotates the SURVIVING account's refresh token on disk.
    const disk = await loadAccounts(storePath);
    disk.accounts[0].refreshToken = "rt-a0-rotated";
    await saveAccounts(disk, storePath);

    const { removed } = await mgr.pruneAccounts(["a1", "a2"]);
    expect(removed.sort()).toEqual(["a1", "a2"]);

    // Only a0 survives.
    expect(mgr.list().map((a) => a.accountId)).toEqual(["a0"]);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["a0"]);

    // activeIndex was pointing past the new end (2 → reset to 0).
    expect(onDisk.activeIndex).toBe(0);
    expect(mgr.activeIndex()).toBe(0);

    // Exactly one backup was taken for the whole bulk delete.
    expect(await countBackups(storePath)).toBe(1);

    // The surviving account's rotated refresh token was NOT clobbered.
    expect(onDisk.accounts[0].refreshToken).toBe("rt-a0-rotated");
  });

  it("skips ids not present without erroring", async () => {
    const mgr = await managerWith([
      makeAccount("a0", { subscriptionStatus: "dead" }),
    ]);
    const { removed } = await mgr.pruneAccounts(["a0", "ghost"]);
    expect(removed).toEqual(["a0"]);
    expect(mgr.list()).toHaveLength(0);
  });

  it("no-ops (no backup) on an empty id list", async () => {
    const mgr = await managerWith([makeAccount("a0")]);
    const { removed } = await mgr.pruneAccounts([]);
    expect(removed).toEqual([]);
    expect(await countBackups(storePath)).toBe(0);
    expect(mgr.list()).toHaveLength(1);
  });

  it("keeps activeIndex on the SAME account when lower-indexed accounts are pruned", async () => {
    // Pool [dead0, activeA, dead2, healthyB], draining activeA at index 1.
    // Pruning the lower-indexed dead0 shifts activeA to index 0; activeIndex
    // must follow the account, not stay at 1 (which would point at healthyB).
    await writeStore(
      storePath,
      [
        makeAccount("dead0", { subscriptionStatus: "dead" }),
        makeAccount("activeA"),
        makeAccount("dead2", { subscriptionStatus: "dead" }),
        makeAccount("healthyB"),
      ],
      1,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const { removed } = await mgr.pruneAccounts(["dead0", "dead2"]);
    expect(removed.sort()).toEqual(["dead0", "dead2"]);

    // Survivors [activeA, healthyB]; the active account is still activeA.
    expect(mgr.list().map((a) => a.accountId)).toEqual(["activeA", "healthyB"]);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.activeIndex).toBe(0);
    expect(onDisk.accounts[onDisk.activeIndex].accountId).toBe("activeA");
    expect(mgr.activeIndex()).toBe(0);
  });
});

describe("xai-prune tool", () => {
  it("dry-run (default) deletes nothing and lists targets with reasons", async () => {
    const mgr = await managerWith([
      makeAccount("keep"),
      makeAccount("dead", { subscriptionStatus: "dead" }),
      makeAccount("flag", { flaggedForRemoval: true }),
    ]);
    const tools = buildTools(mgr);

    // Default: no dryRun arg → dry-run.
    const out = await tools["xai-prune"].execute({}, ctx());
    const text = typeof out === "string" ? out : out.output;

    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/would prune 2 of 3/);
    expect(text).toMatch(/dead \(subscription terminated\)/);
    expect(text).toMatch(/flagged for removal/);

    // Nothing was deleted.
    expect(mgr.list()).toHaveLength(3);
    expect(await countBackups(storePath)).toBe(0);
  });

  it("real run (dryRun=false) deletes prunable accounts and takes a backup", async () => {
    const mgr = await managerWith([
      makeAccount("keep"),
      makeAccount("dead", { subscriptionStatus: "dead" }),
      makeAccount("flag", { flaggedForRemoval: true }),
    ]);
    const tools = buildTools(mgr);

    const out = await tools["xai-prune"].execute({ dryRun: false }, ctx());
    const text = typeof out === "string" ? out : out.output;

    expect(text).toMatch(/Pruned 2 of 3/);
    expect(text).toMatch(/backup was taken/);

    // Only the healthy account survives.
    expect(mgr.list().map((a) => a.accountId)).toEqual(["keep"]);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["keep"]);
    expect(await countBackups(storePath)).toBe(1);
  });

  it("tag filter only prunes matching-tag prunable accounts", async () => {
    const mgr = await managerWith([
      makeAccount("dead-old", {
        subscriptionStatus: "dead",
        tags: ["old"],
      }),
      makeAccount("dead-keep", {
        subscriptionStatus: "dead",
        tags: ["keep"],
      }),
      makeAccount("flag-old", {
        flaggedForRemoval: true,
        tags: ["old"],
      }),
    ]);
    const tools = buildTools(mgr);

    const out = await tools["xai-prune"].execute(
      { dryRun: false, tag: "old" },
      ctx(),
    );
    const text = typeof out === "string" ? out : out.output;
    expect(text).toMatch(/Pruned 2 of 3/);

    // Only the two "old"-tagged prunable accounts were removed; the
    // "keep"-tagged dead account stays (tag filter narrowed the set).
    expect(mgr.list().map((a) => a.accountId)).toEqual(["dead-keep"]);
  });

  it("reports a clean no-op when nothing is prunable", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const tools = buildTools(mgr);

    const out = await tools["xai-prune"].execute({ dryRun: false }, ctx());
    const text = typeof out === "string" ? out : out.output;
    expect(text).toMatch(/Nothing to prune/);
    expect(mgr.list()).toHaveLength(2);
    expect(await countBackups(storePath)).toBe(0);
  });
});

describe("xai-flag / xai-unflag tools", () => {
  it("xai-flag sets flaggedForRemoval; xai-unflag clears it", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const tools = buildTools(mgr);

    await tools["xai-flag"].execute({ index: 1 }, ctx());
    expect(mgr.get("a1")?.flaggedForRemoval).toBe(true);
    expect(mgr.prunableAccounts().map((a) => a.accountId)).toEqual(["a1"]);

    await tools["xai-unflag"].execute({ id: "a1" }, ctx());
    expect(mgr.get("a1")?.flaggedForRemoval).toBe(false);
    expect(mgr.prunableAccounts()).toEqual([]);
  });
});
