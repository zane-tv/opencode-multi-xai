import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AccountManager } from "../lib/accounts.js";
import type { AccountMetadata, AccountStorage } from "../lib/schemas.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-prio-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
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

describe("account priority order", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpStorePath();
  });

  afterEach(async () => {
    await fs.unlink(storePath).catch(() => {});
  });

  it("sorts higher priority first and move up/down works", async () => {
    const a = makeAccount("a", { priority: 0, addedAt: 1 });
    const b = makeAccount("b", { priority: 0, addedAt: 2 });
    const c = makeAccount("c", { priority: 5, addedAt: 3 });
    const storage: AccountStorage = {
      version: 1,
      accounts: [a, b, c],
      activeIndex: 0,
    };
    await fs.writeFile(storePath, JSON.stringify(storage), "utf8");

    const m = new AccountManager(storePath);
    await m.load();
    expect(m.list().map((x) => x.accountId)).toEqual(["c", "a", "b"]);

    await m.movePriority("a", "up"); // a above c? up from #1 toward #0
    // after load order c,a,b — a is index 1, up swaps with c
    const ids = m.list().map((x) => x.accountId);
    expect(ids[0]).toBe("a");
    expect(ids).toContain("c");

    await m.moveToFront("b");
    expect(m.list()[0]!.accountId).toBe("b");
  });

  it("selectAccount prefers sticky then lower index (priority order)", async () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [
        makeAccount("low", { priority: 0, enabled: true, addedAt: 1 }),
        makeAccount("high", { priority: 10, enabled: true, addedAt: 2 }),
      ],
      activeIndex: 0,
    };
    await fs.writeFile(storePath, JSON.stringify(storage), "utf8");
    const m = new AccountManager(storePath);
    await m.load();
    // sorted: high, low — activeId was low at index0 before sort → still low sticky
    // after sortAccountsByPriority activeIndex rebinds to low's new index
    const sticky = m.selectAccount(new Set());
    expect(sticky?.accountId).toBe("low");

    // if sticky not eligible, pick first eligible = high (index 0 after sort)
    await m.setEnabled("low", false);
    const next = m.selectAccount(new Set());
    expect(next?.accountId).toBe("high");
  });
});
