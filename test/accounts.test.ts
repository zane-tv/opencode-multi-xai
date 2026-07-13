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

import {
  AccountManager,
  getAccountManager,
  resetAccountManager,
} from "../lib/accounts.js";
import { resetRefreshState } from "../lib/auth/refresh.js";
import { loadAccounts, saveAccounts } from "../lib/storage.js";
import type { AccountMetadata, AccountStorage } from "../lib/schemas.js";

const HOUR = 3_600_000;

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-accts-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
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

let storePath: string;

beforeEach(() => {
  storePath = tmpStorePath();
  refreshTokensMock.mockReset();
  resetRefreshState();
  resetAccountManager();
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

describe("selectAccount (sticky / drain-first)", () => {
  it("skips disabled / entitlementBlocked / quota-exhausted / cooling-down and picks lowest eligible", async () => {
    const now = Date.now();
    await writeStore(storePath, [
      makeAccount("a0", { enabled: false }),
      makeAccount("a1", { entitlementBlocked: true }),
      makeAccount("a2", { quotaResetAt: now + HOUR }),
      makeAccount("a3", { coolingDownUntil: now + HOUR }),
      makeAccount("a4"),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const picked = mgr.selectAccount(new Set());
    expect(picked?.accountId).toBe("a4");
    // activeIndex moved to the eligible account.
    expect(mgr.list()[mgr["storage"]!.activeIndex].accountId).toBe("a4");
  });

  it("skips already-attempted accounts", async () => {
    await writeStore(storePath, [makeAccount("a0"), makeAccount("a1")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const picked = mgr.selectAccount(new Set(["a0"]));
    expect(picked?.accountId).toBe("a1");
  });

  it("skips a dead account even when it is the current activeIndex / lowest index", async () => {
    // a0 is dead AND the current sticky activeIndex. A dead credential fires
    // invalid_grant on every request, so selection must skip it in favor of a
    // healthy one rather than parking on it.
    await writeStore(
      storePath,
      [
        makeAccount("a0", { subscriptionStatus: "dead" }),
        makeAccount("a1"),
      ],
      0,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const picked = mgr.selectAccount(new Set());
    expect(picked?.accountId).toBe("a1");
    expect(mgr["storage"]!.activeIndex).toBe(1);
  });

  it("returns null when every account is skipped", async () => {
    const now = Date.now();
    await writeStore(storePath, [
      makeAccount("a0", { enabled: false }),
      makeAccount("a1", { quotaResetAt: now + HOUR }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    expect(mgr.selectAccount(new Set())).toBeNull();
  });

  it("treats an expired quotaResetAt as eligible again", async () => {
    const now = Date.now();
    await writeStore(storePath, [
      makeAccount("a0", { quotaResetAt: now - 1_000 }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    expect(mgr.selectAccount(new Set())?.accountId).toBe("a0");
  });

  it("sticky: prefers the current activeIndex account when it is eligible", async () => {
    await writeStore(
      storePath,
      [makeAccount("a0"), makeAccount("a1"), makeAccount("a2")],
      1,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    // a1 (activeIndex) is eligible → return it without scanning down to a0.
    const picked = mgr.selectAccount(new Set());
    expect(picked?.accountId).toBe("a1");
    expect(mgr["storage"]!.activeIndex).toBe(1);
  });
});

describe("add / remove", () => {
  it("adds an account and persists it, updating canonical", async () => {
    const mgr = new AccountManager(storePath);
    await mgr.add(makeAccount("a0"));

    expect(mgr.get("a0")?.accountId).toBe("a0");
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["a0"]);
  });

  it("rejects duplicate account ids", async () => {
    const mgr = new AccountManager(storePath);
    await mgr.add(makeAccount("a0"));
    await expect(mgr.add(makeAccount("a0"))).rejects.toThrow(/already exists/);
  });

  it("removes an account and fixes activeIndex", async () => {
    await writeStore(
      storePath,
      [makeAccount("a0"), makeAccount("a1")],
      1,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.remove("a1");
    expect(mgr.get("a1")).toBeUndefined();
    // activeIndex pointed at the removed last entry → reset to 0.
    expect(mgr["storage"]!.activeIndex).toBe(0);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["a0"]);
  });
});

describe("ensureFreshToken", () => {
  it("fast path: returns a still-valid token with NO network call", async () => {
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at-valid",
        refreshToken: "rt-current",
        expiresAt: Date.now() + HOUR,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const tokens = await mgr.ensureFreshToken("a0");
    expect(tokens.accessToken).toBe("at-valid");
    expect(refreshTokensMock).not.toHaveBeenCalled();
  });

  it("refreshes when the token is expired and persists the rotated token", async () => {
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1_000,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    refreshTokensMock.mockResolvedValueOnce({
      accessToken: "at-new",
      refreshToken: "rt-rotated",
      expiresAt: Date.now() + HOUR,
    });

    const tokens = await mgr.ensureFreshToken("a0");
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    // Grant was sent the current on-disk refresh token.
    expect(refreshTokensMock).toHaveBeenCalledWith("rt-old");
    expect(tokens.refreshToken).toBe("rt-rotated");

    // Canonical + disk both hold the rotated token.
    expect(mgr.get("a0")?.refreshToken).toBe("rt-rotated");
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].refreshToken).toBe("rt-rotated");
  });

  it("CRUX 1: reload-under-lock skips the network refresh when disk is already rotated", async () => {
    // Canonical (in memory) has an expired token; another process has since
    // rotated a fresh token onto disk.
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at-expired",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1_000,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load(); // canonical now holds the expired token

    // "Another process" rotates the token durably on disk.
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at-fresh-from-other-proc",
        refreshToken: "rt-rotated-elsewhere",
        expiresAt: Date.now() + HOUR,
      }),
    ]);

    const tokens = await mgr.ensureFreshToken("a0");

    // The winner reloaded under the lock, saw a fresh token, and SKIPPED the
    // network grant entirely.
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(tokens.accessToken).toBe("at-fresh-from-other-proc");
    expect(tokens.refreshToken).toBe("rt-rotated-elsewhere");
    // Canonical adopted the disk token.
    expect(mgr.get("a0")?.refreshToken).toBe("rt-rotated-elsewhere");
  });

  it("single-flight: concurrent callers share one refresh (grant fires once)", async () => {
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1_000,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    refreshTokensMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        accessToken: "at-new",
        refreshToken: "rt-rotated",
        expiresAt: Date.now() + HOUR,
      };
    });

    const [t1, t2] = await Promise.all([
      mgr.ensureFreshToken("a0"),
      mgr.ensureFreshToken("a0"),
    ]);
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(t1.refreshToken).toBe("rt-rotated");
    expect(t2.refreshToken).toBe("rt-rotated");
  });
});

describe("mutation API (locked read-modify-write, never clobbers tokens)", () => {
  it("CRUX 2: a snapshot-based non-token mutation does NOT clobber a freshly rotated refresh token", async () => {
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at",
        refreshToken: "rt-old",
        expiresAt: Date.now() + HOUR,
      }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load(); // canonical holds rt-old (the stale snapshot)

    // "Another process" rotates the refresh token durably on disk.
    await writeStore(storePath, [
      makeAccount("a0", {
        accessToken: "at",
        refreshToken: "rt-rotated",
        expiresAt: Date.now() + HOUR,
      }),
    ]);

    // A non-token mutation issued from the manager whose canonical copy still
    // holds rt-old. Because it re-reads under the lock and only patches its own
    // field, it must NOT regress the on-disk token back to rt-old.
    await mgr.markQuotaExhausted("a0", Date.now() + HOUR);

    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].refreshToken).toBe("rt-rotated");
    expect(onDisk.accounts[0].quotaResetAt).toBeGreaterThan(Date.now());
    expect(onDisk.accounts[0].lastSwitchReason).toBe("quota-exhausted");
  });

  it("markEntitlementBlocked persists and updates canonical", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.markEntitlementBlocked("a0");
    expect(mgr.get("a0")?.entitlementBlocked).toBe(true);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].entitlementBlocked).toBe(true);
    // Selection now skips it.
    expect(mgr.selectAccount(new Set())).toBeNull();
  });

  it("markDeadCandidate sets subscriptionStatus=dead", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.markDeadCandidate("a0");
    expect(mgr.get("a0")?.subscriptionStatus).toBe("dead");
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].subscriptionStatus).toBe("dead");
  });

  it("recordCooldown sets coolingDownUntil + reason and selection skips it", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const until = Date.now() + HOUR;
    await mgr.recordCooldown("a0", "network-error", until);
    expect(mgr.get("a0")?.coolingDownUntil).toBe(until);
    expect(mgr.get("a0")?.cooldownReason).toBe("network-error");
    expect(mgr.selectAccount(new Set())).toBeNull();
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].cooldownReason).toBe("network-error");
  });

  it("touchLastUsed updates lastUsed on disk and canonical", async () => {
    await writeStore(storePath, [makeAccount("a0", { lastUsed: 0 })]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.touchLastUsed("a0");
    expect(mgr.get("a0")?.lastUsed).toBeGreaterThan(0);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].lastUsed).toBeGreaterThan(0);
  });
});

describe("management API (switchTo / setEnabled / setLabel / setTags / setNote)", () => {
  it("switchTo moves activeIndex to the target account", async () => {
    await writeStore(
      storePath,
      [makeAccount("a0"), makeAccount("a1"), makeAccount("a2")],
      0,
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.switchTo("a2");
    expect(mgr.activeIndex()).toBe(2);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.activeIndex).toBe(2);
  });

  it("switchTo throws on an unknown id", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await expect(mgr.switchTo("nope")).rejects.toThrow(/unknown account/);
  });

  it("setEnabled toggles enabled on disk + canonical without clobbering the token", async () => {
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

    await mgr.setEnabled("a0", false);
    expect(mgr.get("a0")?.enabled).toBe(false);
    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts[0].enabled).toBe(false);
    // The non-token mutation must NOT regress the rotated refresh token.
    expect(onDisk.accounts[0].refreshToken).toBe("rt-rotated");
  });

  it("setLabel sets and clears the label", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.setLabel("a0", "work");
    expect(mgr.get("a0")?.label).toBe("work");
    expect((await loadAccounts(storePath)).accounts[0].label).toBe("work");

    await mgr.setLabel("a0", undefined);
    expect(mgr.get("a0")?.label).toBeUndefined();
    expect((await loadAccounts(storePath)).accounts[0].label).toBeUndefined();
  });

  it("setTags replaces the tag list wholesale", async () => {
    await writeStore(storePath, [makeAccount("a0", { tags: ["old"] })]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.setTags("a0", ["work", "primary"]);
    expect(mgr.get("a0")?.tags).toEqual(["work", "primary"]);
    expect((await loadAccounts(storePath)).accounts[0].tags).toEqual([
      "work",
      "primary",
    ]);

    await mgr.setTags("a0", []);
    expect(mgr.get("a0")?.tags).toEqual([]);
  });

  it("setNote sets and clears the note", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.setNote("a0", "spare account");
    expect(mgr.get("a0")?.note).toBe("spare account");
    expect((await loadAccounts(storePath)).accounts[0].note).toBe(
      "spare account",
    );

    await mgr.setNote("a0", undefined);
    expect(mgr.get("a0")?.note).toBeUndefined();
  });
});

describe("prune API (setFlaggedForRemoval / prunableAccounts / pruneAccounts)", () => {
  it("setFlaggedForRemoval sets the flag on disk + canonical without clobbering the token", async () => {
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

    await mgr.setFlaggedForRemoval("a0", false);
    expect(mgr.get("a0")?.flaggedForRemoval).toBe(false);
  });

  it("prunableAccounts returns dead + flagged and EXCLUDES healthy and quota-exhausted (B1 guard)", async () => {
    const now = Date.now();
    await writeStore(storePath, [
      makeAccount("healthy"),
      makeAccount("dead", { subscriptionStatus: "dead" }),
      makeAccount("flagged", { flaggedForRemoval: true }),
      // A quota-exhausted-but-ALIVE account is RECOVERABLE — must NOT be prunable.
      makeAccount("quota", { quotaResetAt: now + HOUR }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const ids = mgr.prunableAccounts().map((a) => a.accountId).sort();
    expect(ids).toEqual(["dead", "flagged"]);
    // Explicit B1 assertions.
    expect(ids).not.toContain("quota");
    expect(ids).not.toContain("healthy");
  });

  it("pruneAccounts removes only targets, keeps others, fixes activeIndex, and preserves a rotated token", async () => {
    await writeStore(
      storePath,
      [
        makeAccount("a0", { subscriptionStatus: "dead" }),
        makeAccount("a1", {
          accessToken: "at",
          refreshToken: "rt-old",
          expiresAt: Date.now() + HOUR,
        }),
        makeAccount("a2", { flaggedForRemoval: true }),
      ],
      2, // activeIndex points at the last account, which will be removed
    );
    const mgr = new AccountManager(storePath);
    await mgr.load();

    // Another process rotates the surviving account's refresh token on disk.
    await writeStore(
      storePath,
      [
        makeAccount("a0", { subscriptionStatus: "dead" }),
        makeAccount("a1", {
          accessToken: "at",
          refreshToken: "rt-rotated",
          expiresAt: Date.now() + HOUR,
        }),
        makeAccount("a2", { flaggedForRemoval: true }),
      ],
      2,
    );

    const { removed } = await mgr.pruneAccounts(["a0", "a2"]);
    expect(removed.sort()).toEqual(["a0", "a2"]);

    // Only a1 survives.
    expect(mgr.list().map((a) => a.accountId)).toEqual(["a1"]);
    // activeIndex was past the end (2) → reset to 0.
    expect(mgr.activeIndex()).toBe(0);

    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["a1"]);
    expect(onDisk.activeIndex).toBe(0);
    // Surviving account's rotated token was preserved (adopt-from-disk invariant).
    expect(onDisk.accounts[0].refreshToken).toBe("rt-rotated");
  });

  it("pruneAccounts takes exactly ONE backup for a bulk delete", async () => {
    await writeStore(storePath, [
      makeAccount("a0", { subscriptionStatus: "dead" }),
      makeAccount("a1", { flaggedForRemoval: true }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    await mgr.pruneAccounts(["a0", "a1"]);

    // Exactly one `${base}.bak-*` backup was written (not N).
    const dir = path.dirname(storePath);
    const base = path.basename(storePath);
    const entries = await fs.readdir(dir);
    const backups = entries.filter((e) => e.startsWith(`${base}.bak-`));
    expect(backups.length).toBe(1);
  });

  it("pruneAccounts skips ids absent from the pool (not an error)", async () => {
    await writeStore(storePath, [
      makeAccount("a0", { subscriptionStatus: "dead" }),
    ]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const { removed } = await mgr.pruneAccounts(["a0", "ghost"]);
    expect(removed).toEqual(["a0"]);
    expect(mgr.list()).toEqual([]);
  });

  it("pruneAccounts with no ids is a no-op (no backup)", async () => {
    await writeStore(storePath, [makeAccount("a0")]);
    const mgr = new AccountManager(storePath);
    await mgr.load();

    const { removed } = await mgr.pruneAccounts([]);
    expect(removed).toEqual([]);

    const dir = path.dirname(storePath);
    const base = path.basename(storePath);
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.startsWith(`${base}.bak-`)).length).toBe(0);
  });
});

describe("getAccountManager singleton", () => {
  it("returns the same instance and rejects a conflicting path", () => {
    const a = getAccountManager(storePath);
    const b = getAccountManager(storePath);
    expect(a).toBe(b);
    expect(() => getAccountManager("/some/other/path.json")).toThrow(
      /different storagePath/,
    );
  });
});
