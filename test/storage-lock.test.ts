import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STALE_LOCK_MS,
  loadAccounts,
  saveAccounts,
  withCrossProcessTransaction,
} from "../lib/storage.js";
import type { AccountStorage } from "../lib/schemas.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-lock-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function seedStorage(): AccountStorage {
  return {
    version: 1,
    accounts: [],
    activeIndex: 0,
  };
}

let storePath: string;

beforeEach(async () => {
  storePath = tmpStorePath();
  await saveAccounts(seedStorage(), storePath);
});

afterEach(async () => {
  delete process.env.MULTI_XAI_LOCK_TIMEOUT_MS;
  // Clean the store, its lock, and any tmp/backup siblings.
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

describe("withCrossProcessTransaction", () => {
  it("serializes overlapping transactions (mutual exclusion, no interleave)", async () => {
    const events: string[] = [];

    const tx = (label: string) =>
      withCrossProcessTransaction(async (storage) => {
        events.push(`${label}:enter`);
        // Yield so a naive implementation would interleave here.
        await new Promise((r) => setTimeout(r, 20));
        events.push(`${label}:exit`);
        return storage;
      }, storePath);

    await Promise.all([tx("A"), tx("B")]);

    // Whichever ran first must fully finish before the other enters.
    const first = events[0].split(":")[0];
    const second = first === "A" ? "B" : "A";
    expect(events).toEqual([
      `${first}:enter`,
      `${first}:exit`,
      `${second}:enter`,
      `${second}:exit`,
    ]);
  });

  it("re-reads latest state from disk under the lock before writing", async () => {
    // Simulate another writer rotating a value on disk while our tx callback
    // has NOT yet run. Because the tx loads fresh under the lock, it sees it.
    await withCrossProcessTransaction((storage) => {
      storage.accounts.push({
        accountId: "acct-1",
        tags: [],
        refreshToken: "rt-original",
        enabled: true,
        priority: 0,
        addedAt: Date.now(),
        lastUsed: 0,
        lastSwitchReason: "initial",
        subscriptionStatus: "unknown",
        flaggedForRemoval: false,
        entitlementBlocked: false,
      });
    }, storePath);

    const seen: string[] = [];
    await withCrossProcessTransaction((storage) => {
      seen.push(storage.accounts[0].refreshToken);
    }, storePath);

    expect(seen).toEqual(["rt-original"]);
  });

  it("reclaims a stale lock older than STALE_LOCK_MS", async () => {
    const lockPath = `${storePath}.lock`;
    // Create a lockfile and backdate its mtime beyond the stale window.
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: 0 }));
    const old = new Date(Date.now() - (STALE_LOCK_MS + 5_000));
    await fs.utimes(lockPath, old, old);

    // Should reclaim and complete rather than block until the acquire bound.
    let ran = false;
    await withCrossProcessTransaction(() => {
      ran = true;
    }, storePath);
    expect(ran).toBe(true);

    // Lock released after the tx.
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws when the lock cannot be acquired within the bound", async () => {
    process.env.MULTI_XAI_LOCK_TIMEOUT_MS = "200";
    const lockPath = `${storePath}.lock`;
    // A FRESH foreign lock (recent mtime) is not stale, so it will not be
    // reclaimed within the tiny bound → acquisition must throw.
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));

    await expect(
      withCrossProcessTransaction(() => {
        /* should never run */
      }, storePath),
    ).rejects.toThrow(/could not acquire/i);

    // Clean up the foreign lock we planted.
    await fs.rm(lockPath, { force: true });
  });

  it("releases the lock even when the callback throws", async () => {
    const lockPath = `${storePath}.lock`;
    await expect(
      withCrossProcessTransaction(() => {
        throw new Error("boom");
      }, storePath),
    ).rejects.toThrow("boom");

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The lock is free: a subsequent tx acquires without issue.
    let ran = false;
    await withCrossProcessTransaction(() => {
      ran = true;
    }, storePath);
    expect(ran).toBe(true);
  });

  it("does NOT delete another holder's lock on release (owner-token mismatch)", async () => {
    const lockPath = `${storePath}.lock`;

    // Inside the tx callback we simulate a concurrent process reclaiming the
    // lock: overwrite the lockfile with a DIFFERENT owner token. When our tx
    // then releases, it must see the mismatch and leave the foreign lock alone
    // (deleting it would free a live lock held by someone else — a cascade).
    await withCrossProcessTransaction(async () => {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 999999, at: Date.now(), owner: "someone-else" }),
      );
    }, storePath);

    // The foreign lock must still be present with the other owner's token.
    const text = await fs.readFile(lockPath, "utf8");
    expect(JSON.parse(text).owner).toBe("someone-else");

    // Clean up the foreign lock we planted.
    await fs.rm(lockPath, { force: true });
  });

  it("persists the callback's mutation to disk", async () => {
    await withCrossProcessTransaction((storage) => {
      storage.accounts.push({
        accountId: "persist-check",
        tags: [],
        refreshToken: "rt",
        enabled: true,
        priority: 0,
        addedAt: Date.now(),
        lastUsed: 0,
        lastSwitchReason: "initial",
        subscriptionStatus: "unknown",
        flaggedForRemoval: false,
        entitlementBlocked: false,
      });
    }, storePath);

    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["persist-check"]);
  });
});
