import { MAX_ACCOUNTS, TOKEN_REFRESH_SKEW_MS } from "./constants.js";
import { logger } from "./logger.js";
import {
  backupAccounts,
  loadAccounts,
  saveAccounts,
  withCrossProcessTransaction,
} from "./storage.js";
import {
  type AccountMetadata,
  type AccountStorage,
  type CooldownReason,
} from "./schemas.js";
import { getFreshTokens } from "./auth/refresh.js";
import type { Tokens } from "./auth/oauth.js";

/**
 * AccountManager — the process singleton that owns the ONE canonical in-memory
 * account pool.
 *
 * WHY A SINGLETON CANONICAL POOL (the B-2 brick):
 * If callers "load per request → mutate → save" they each capture a detached
 * snapshot of storage. A refresh rotates the refresh token (xAI rotates on
 * every grant), but a concurrent request that saves an older snapshot then
 * clobbers the freshly rotated token → the account is bricked. AccountManager
 * prevents this two ways:
 *   1. All requests select and mutate the SAME account objects in memory.
 *   2. Every persistence goes through `withCrossProcessTransaction`, which
 *      RE-READS the latest tokens from disk under a cross-process lock before
 *      writing, so a write can never overwrite a token another writer (in this
 *      process or another OpenCode process) just rotated.
 *
 * No caller ever calls saveAccounts with a snapshot captured earlier. fix-B
 * should call ONLY AccountManager methods and never touch storage directly.
 *
 * YAGNI (deliberately NOT here): HealthScore, TokenBucket, PID offset,
 * retry-budget categories, circuit breaker, per-model index. Single
 * activeIndex, sticky-only selection, timestamp-based cooldowns.
 */

/** True if the account's access token is still valid past the refresh skew. */
function accessTokenValid(account: AccountMetadata, now: number): boolean {
  if (!account.accessToken) return false;
  if (typeof account.expiresAt !== "number") return false;
  return account.expiresAt > now + TOKEN_REFRESH_SKEW_MS;
}

/**
 * The single source of truth for whether an account is selectable for a
 * request RIGHT NOW, independent of the per-request `attempted` set.
 *
 * An account is NOT selectable if ANY of:
 *   - not enabled
 *   - subscriptionStatus === "dead" (refresh grant returned invalid_grant; the
 *     credential is terminally dead and would fire invalid_grant every request)
 *   - entitlementBlocked (hit the xAI per-account allowlist gate #26847)
 *   - quota-exhausted (quotaResetAt set AND still in the future)
 *   - cooling down (coolingDownUntil in the future)
 *
 * `selectAccount` composes this with the per-request `attempted` set; the TUI
 * status summary calls it directly. Keeping it here as the ONE predicate
 * prevents the status line from drifting out of sync with actual selection.
 */
export function isSelectable(account: AccountMetadata, now: number): boolean {
  if (!account.enabled) return false;
  if (account.subscriptionStatus === "dead") return false;
  if (account.entitlementBlocked) return false;
  if (typeof account.quotaResetAt === "number" && account.quotaResetAt > now) {
    return false;
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    return false;
  }
  return true;
}

/**
 * Sort pool in place: higher priority first, then older accounts first.
 * Rebinds activeIndex so it still points at the same accountId.
 */
function sortAccountsByPriority(storage: AccountStorage): void {
  const activeId = storage.accounts[storage.activeIndex]?.accountId;
  storage.accounts.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return (a.addedAt ?? 0) - (b.addedAt ?? 0);
  });
  if (activeId) {
    const idx = storage.accounts.findIndex((x) => x.accountId === activeId);
    storage.activeIndex = idx >= 0 ? idx : 0;
  } else {
    storage.activeIndex = 0;
  }
}


export class AccountManager {
  private readonly storagePath: string | undefined;

  /** The canonical in-memory pool. Null until first load(). */
  private storage: AccountStorage | null = null;

  /** Lazy-load promise so concurrent first-callers share one load. */
  private loadPromise: Promise<void> | null = null;

  /**
   * In-process single-flight for ensureFreshToken, keyed by accountId. Joiners
   * await the shared promise WITHOUT taking the cross-process file lock; only
   * the winner touches the lock + network.
   */
  private readonly freshInFlight = new Map<string, Promise<Tokens>>();

  constructor(storagePath?: string) {
    this.storagePath = storagePath;
  }

  /** Load the canonical pool from storage. Idempotent (dedupes concurrent). */
  async load(): Promise<void> {
    if (this.storage) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      this.storage = await loadAccounts(this.storagePath);
      // Normalize list order by priority (in-memory only until next mutation).
      sortAccountsByPriority(this.storage);
      logger.debug(
        `AccountManager loaded ${this.storage.accounts.length} account(s)`,
      );
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  /** Drop in-memory pool and re-read from disk (for TUI/CLI reload). */
  async reloadFromDisk(): Promise<void> {
    this.storage = null;
    this.loadPromise = null;
    await this.load();
  }

  private async ensureLoaded(): Promise<AccountStorage> {
    if (!this.storage) await this.load();
    // load() always assigns storage on success.
    return this.storage as AccountStorage;
  }

  /**
   * Snapshot of the canonical account list. Returns a shallow copy of the array
   * so a caller cannot splice/reorder the canonical pool; the element objects
   * are still the live canonical references (mutating a returned account still
   * mutates canonical — use the mutation API for persisted changes).
   */
  list(): AccountMetadata[] {
    return this.storage ? [...this.storage.accounts] : [];
  }

  /** Get the canonical account object by id (mutations to it are canonical). */
  get(id: string): AccountMetadata | undefined {
    return this.storage?.accounts.find((a) => a.accountId === id);
  }

  /** The current sticky active index (0 when the pool is unloaded/empty). */
  activeIndex(): number {
    return this.storage?.activeIndex ?? 0;
  }

  /**
   * Add an account. Enforces MAX_ACCOUNTS, persists under the cross-process
   * lock, then syncs the in-memory canonical pool to match what was persisted.
   */
  async add(account: AccountMetadata): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      if (storage.accounts.some((a) => a.accountId === account.accountId)) {
        throw new Error(`account ${account.accountId} already exists`);
      }
      if (storage.accounts.length >= MAX_ACCOUNTS) {
        throw new Error(
          `cannot add account: pool is at the maximum of ${MAX_ACCOUNTS} accounts`,
        );
      }
      storage.accounts.push(account);
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /**
   * OAuth login upsert: add a new account, or refresh tokens on an existing one
   * (same accountId). Used by TUI/CLI add and plugin finalizeLogin.
   */
  async upsertFromOAuth(
    account: AccountMetadata,
  ): Promise<"added" | "updated"> {
    await this.ensureLoaded();
    let outcome: "added" | "updated" = "added";
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      const idx = storage.accounts.findIndex(
        (a) => a.accountId === account.accountId,
      );
      if (idx >= 0) {
        outcome = "updated";
        const prev = storage.accounts[idx]!;
        storage.accounts[idx] = {
          ...prev,
          refreshToken: account.refreshToken,
          accessToken: account.accessToken,
          expiresAt: account.expiresAt,
          email: account.email ?? prev.email,
          oauthScope: account.oauthScope ?? prev.oauthScope,
          subscriptionStatus: "active",
          entitlementBlocked: false,
          enabled: true,
          planTier: account.planTier ?? prev.planTier,
          planName: account.planName ?? prev.planName,
          planMonthlyLimit: account.planMonthlyLimit ?? prev.planMonthlyLimit,
          planUsed: account.planUsed ?? prev.planUsed,
          planPeriodStartMs:
            account.planPeriodStartMs ?? prev.planPeriodStartMs,
          planPeriodEndMs: account.planPeriodEndMs ?? prev.planPeriodEndMs,
          planObservedAt: account.planObservedAt ?? prev.planObservedAt,
        };
        return storage;
      }
      if (storage.accounts.length >= MAX_ACCOUNTS) {
        throw new Error(
          `cannot add account: pool is at the maximum of ${MAX_ACCOUNTS} accounts`,
        );
      }
      storage.accounts.push(account);
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
    return outcome;
  }

  /**
   * Remove an account by id. Takes a backup first (removal drops the account's
   * stored refresh token, so a mistyped id is at least recoverable from the
   * backup), then persists under the lock, syncs canonical, and fixes
   * activeIndex if it now points past the end.
   */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    await backupAccounts(this.storagePath);
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      const idx = storage.accounts.findIndex((a) => a.accountId === id);
      if (idx === -1) return storage;
      storage.accounts.splice(idx, 1);
      if (storage.activeIndex >= storage.accounts.length) {
        storage.activeIndex = 0;
      }
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /**
   * STICKY / drain-first selection.
   *
   * Prefer the current activeIndex account if it passes the predicate; else
   * scan for the lowest-index eligible account and move activeIndex to it.
   * Returns null if no account is eligible.
   *
   * Eligibility = isSelectable(account, now) AND not already attempted this
   * request. isSelectable is the shared predicate (see its doc for the skip
   * conditions); keeping the gate there prevents the TUI status line from
   * drifting out of sync with actual selection.
   */
  selectAccount(attempted: Set<string>): AccountMetadata | null {
    const storage = this.storage;
    if (!storage || storage.accounts.length === 0) return null;
    const now = Date.now();

    const eligible = (a: AccountMetadata): boolean =>
      isSelectable(a, now) && !attempted.has(a.accountId);

    // Sticky: keep draining the current account while it is eligible.
    const current = storage.accounts[storage.activeIndex];
    if (current && eligible(current)) return current;

    // Otherwise scan for the lowest-index eligible account.
    for (let i = 0; i < storage.accounts.length; i++) {
      const a = storage.accounts[i];
      if (eligible(a)) {
        storage.activeIndex = i;
        logger.debug(
          `selectAccount switched activeIndex to ${i} (${a.accountId})`,
        );
        return a;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Mutation API.
  //
  // Every mutator goes through a read-modify-write under the cross-process lock
  // that RE-READS the latest state from disk, touches ONLY the specific fields
  // it owns, and then updates the in-memory canonical object in place. None of
  // these ever write refreshToken / accessToken / expiresAt, so they can never
  // clobber a token another writer just rotated.
  // ---------------------------------------------------------------------------

  /** Mark an account quota-exhausted until `resetAt` (epoch ms). */
  async markQuotaExhausted(id: string, resetAt: number): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.quotaResetAt = resetAt;
      a.lastSwitchReason = "quota-exhausted";
    });
  }

  /**
   * Mark an account as blocked by the xAI per-account allowlist gate (#26847).
   * Selection will skip it. Distinct from flaggedForRemoval (prune semantics).
   */
  async markEntitlementBlocked(id: string): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.entitlementBlocked = true;
    });
  }

  /**
   * Mark an account's subscription as dead.
   *
   * CALLER CONTRACT: only call this on InvalidGrantError from the REFRESH
   * grant. Never call it on an inference-side 401 — those are recoverable
   * quota/entitlement signals, not terminal subscription death.
   */
  async markDeadCandidate(id: string): Promise<void> {
    const now = Date.now();
    await this.mutateNonToken(id, (a) => {
      a.subscriptionStatus = "dead";
      a.subscriptionCheckedAt = now;
    });
  }

  /** Put an account into cooldown until `until` (epoch ms) for `reason`. */
  async recordCooldown(
    id: string,
    reason: CooldownReason,
    until: number,
  ): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.coolingDownUntil = until;
      a.cooldownReason = reason;
    });
  }

  /** Update an account's lastUsed timestamp to now. */
  async touchLastUsed(id: string): Promise<void> {
    const now = Date.now();
    await this.mutateNonToken(id, (a) => {
      a.lastUsed = now;
    });
  }

  /**
   * Persist the latest API rate-limit remaining snapshot from inference headers.
   * Only overwrites fields that are present on the snapshot.
   */
  async recordRateLimit(
    id: string,
    snap: {
      limitRequests?: number;
      remainingRequests?: number;
      limitTokens?: number;
      remainingTokens?: number;
      costInUsdTicks?: number;
      observedAt?: number;
    },
  ): Promise<void> {
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(id, (a) => {
      if (snap.limitRequests !== undefined) {
        a.rateLimitLimitRequests = snap.limitRequests;
      }
      if (snap.remainingRequests !== undefined) {
        a.rateLimitRemainingRequests = snap.remainingRequests;
      }
      if (snap.limitTokens !== undefined) {
        a.rateLimitLimitTokens = snap.limitTokens;
      }
      if (snap.remainingTokens !== undefined) {
        a.rateLimitRemainingTokens = snap.remainingTokens;
      }
      if (snap.costInUsdTicks !== undefined) {
        a.lastCostInUsdTicks = snap.costInUsdTicks;
      }
      a.rateLimitObservedAt = observedAt;
      a.lastUsed = observedAt;
    });
  }

  /** Persist SuperGrok monthly credits snapshot from grok.com billing. */
  async recordBillingQuota(
    id: string,
    snap: {
      monthlyUsedPercent: number;
      remainingPercent: number;
      resetsAtMs?: number;
      observedAt?: number;
    },
  ): Promise<void> {
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(id, (a) => {
      a.billingMonthlyUsedPercent = snap.monthlyUsedPercent;
      a.billingRemainingPercent = snap.remainingPercent;
      if (snap.resetsAtMs !== undefined) a.billingResetsAt = snap.resetsAtMs;
      a.billingObservedAt = observedAt;
    });
  }

  /** Persist SuperGrok plan snapshot (JWT tier + absolute monthly limit). */
  async recordPlan(
    id: string,
    snap: {
      planTier?: number;
      planName: string;
      planMonthlyLimit?: number;
      planUsed?: number;
      planPeriodStartMs?: number;
      planPeriodEndMs?: number;
      observedAt?: number;
    },
  ): Promise<void> {
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(id, (a) => {
      if (snap.planTier !== undefined) a.planTier = snap.planTier;
      a.planName = snap.planName;
      if (snap.planMonthlyLimit !== undefined) {
        a.planMonthlyLimit = snap.planMonthlyLimit;
      }
      if (snap.planUsed !== undefined) a.planUsed = snap.planUsed;
      if (snap.planPeriodStartMs !== undefined) {
        a.planPeriodStartMs = snap.planPeriodStartMs;
      }
      if (snap.planPeriodEndMs !== undefined) {
        a.planPeriodEndMs = snap.planPeriodEndMs;
      }
      a.planObservedAt = observedAt;
    });
  }

  /**
   * Set the active account to `id`. activeIndex lives in storage (not on a
   * per-account object), so this goes through a cross-process transaction and
   * adopts the reloaded storage — mirroring add/remove. Throws if `id` is
   * unknown so a CLI caller gets a clear error rather than a silent no-op.
   */
  async switchTo(id: string): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      const idx = storage.accounts.findIndex((a) => a.accountId === id);
      if (idx === -1) {
        throw new Error(`cannot switch: unknown account ${id}`);
      }
      storage.activeIndex = idx;
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /** Enable or disable an account (selection skips disabled accounts). */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.enabled = enabled;
    });
  }

  /** Set (or clear, when `label` is undefined) an account's display label. */
  async setLabel(id: string, label?: string): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.label = label;
    });
  }

  /** Replace an account's tag list wholesale. */
  async setTags(id: string, tags: string[]): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.tags = [...tags];
    });
  }

  /** Set (or clear, when `note` is undefined) an account's free-form note. */
  async setNote(id: string, note?: string): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.note = note;
    });
  }

  /**
   * Explicit priority value (higher = preferred earlier in list / rotation
   * scan). Re-sorts the pool after update.
   */
  async setPriority(id: string, priority: number): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      const acct = storage.accounts.find((a) => a.accountId === id);
      if (!acct) {
        throw new Error(`cannot set priority: unknown account ${id}`);
      }
      acct.priority = Math.trunc(priority);
      sortAccountsByPriority(storage);
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /**
   * Move account one slot toward the front of the list (higher priority).
   * List order is the rotation preference order after sticky current fails.
   */
  async movePriority(id: string, direction: "up" | "down"): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      sortAccountsByPriority(storage);
      const idx = storage.accounts.findIndex((a) => a.accountId === id);
      if (idx === -1) {
        throw new Error(`cannot move: unknown account ${id}`);
      }
      const swapWith = direction === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= storage.accounts.length) {
        return storage; // already at edge
      }
      const a = storage.accounts[idx]!;
      const b = storage.accounts[swapWith]!;
      // Swap priorities so stable sort keeps the new order.
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa === pb) {
        // Adjacent same priority: bump mover past neighbor.
        if (direction === "up") a.priority = pb + 1;
        else a.priority = pb - 1;
      } else {
        a.priority = pb;
        b.priority = pa;
      }
      sortAccountsByPriority(storage);
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /** Move account to the front of the priority list (highest priority). */
  async moveToFront(id: string): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      const max = storage.accounts.reduce(
        (m, a) => Math.max(m, a.priority ?? 0),
        0,
      );
      const acct = storage.accounts.find((a) => a.accountId === id);
      if (!acct) {
        throw new Error(`cannot move: unknown account ${id}`);
      }
      acct.priority = max + 1;
      sortAccountsByPriority(storage);
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);
  }

  /**
   * Flag (or unflag) an account for manual pruning. Purely a bookkeeping flag —
   * selection ignores it; only `pruneAccounts` acts on it. Goes through the
   * same non-token read-modify-write as every other field mutator, so it can
   * never clobber a token another writer just rotated.
   */
  async setFlaggedForRemoval(id: string, flagged: boolean): Promise<void> {
    await this.mutateNonToken(id, (a) => {
      a.flaggedForRemoval = flagged;
    });
  }

  /**
   * Read-only view of the accounts eligible for pruning.
   *
   * PRUNE CRITERIA (the ONLY two — oracle B1):
   *   - subscriptionStatus === "dead": set ONLY by markDeadCandidate on an
   *     InvalidGrantError from the refresh grant (terminal credential death).
   *   - flaggedForRemoval === true: an explicit manual flag.
   *
   * A quota-exhausted account is a RECOVERABLE monthly-quota signal, NOT an
   * expired subscription, and must never appear here.
   *
   * Returns a shallow array copy holding live canonical element references
   * (like list()); callers must only read it and route deletions through
   * pruneAccounts.
   */
  prunableAccounts(): AccountMetadata[] {
    if (!this.storage) return [];
    return this.storage.accounts.filter(
      (a) => a.subscriptionStatus === "dead" || a.flaggedForRemoval === true,
    );
  }

  /**
   * Bulk-remove accounts by id (the manual prune feature).
   *
   * UNCONDITIONAL: removes whatever ids it is handed. The B1 safety guard
   * (never delete a recoverable quota-exhausted account) lives in the CALLER —
   * the `xai-prune` tool sources ids only from prunableAccounts(). Do not call
   * this with an unfiltered id set.
   *
   * Takes ONE backup up front (a bulk delete drops several refresh tokens; the
   * backup makes a mistake recoverable), then removes ALL matching ids in a
   * SINGLE cross-process transaction — NOT a loop of remove() (that would take
   * N backups + N transactions). Preserves the active account across the splice
   * by re-deriving activeIndex from its id (falls back to 0 if the active
   * account was itself pruned), then adopts the reloaded storage wholesale
   * (same token-safety invariant as add/remove/switchTo — disk is the source of
   * truth for tokens).
   *
   * Returns the ids that were actually removed (a requested id absent from the
   * pool is simply skipped, not an error).
   */
  async pruneAccounts(ids: string[]): Promise<{ removed: string[] }> {
    await this.ensureLoaded();
    const wanted = new Set(ids);
    if (wanted.size === 0) return { removed: [] };

    // One backup up front, before any structural mutation.
    await backupAccounts(this.storagePath);

    const removed: string[] = [];
    const next = await withCrossProcessTransaction<AccountStorage>((storage) => {
      // Remember the active account's id so we can preserve it across the
      // splice: removing a LOWER-indexed account would otherwise silently shift
      // activeIndex onto a different (surviving) account.
      const activeId = storage.accounts[storage.activeIndex]?.accountId;

      const survivors: AccountMetadata[] = [];
      for (const a of storage.accounts) {
        if (wanted.has(a.accountId)) {
          removed.push(a.accountId);
        } else {
          survivors.push(a);
        }
      }
      storage.accounts = survivors;

      // Re-derive activeIndex from the remembered id; if the active account was
      // itself pruned (or vanished), reset to 0.
      const idx = activeId
        ? survivors.findIndex((a) => a.accountId === activeId)
        : -1;
      storage.activeIndex = idx >= 0 ? idx : 0;
      return storage;
    }, this.storagePath);
    this.adoptStorage(next);

    return { removed };
  }

  /**
   * Shared read-modify-write for non-token fields. Loads the latest storage
   * under the lock, applies `patch` to the on-disk entry (touching ONLY the
   * fields `patch` sets), persists, then applies the same patch to the
   * canonical in-memory object so the two stay in sync — WITHOUT ever touching
   * token fields.
   */
  private async mutateNonToken(
    id: string,
    patch: (account: AccountMetadata) => void,
  ): Promise<void> {
    await this.ensureLoaded();
    await withCrossProcessTransaction((storage) => {
      const acct = storage.accounts.find((a) => a.accountId === id);
      if (!acct) {
        logger.warn(`mutateNonToken: account ${id} not found; skipping`);
        return;
      }
      patch(acct);
    }, this.storagePath);

    // Apply the same field changes to the canonical in-memory object. We do NOT
    // adopt the reloaded storage wholesale here: another writer may have rotated
    // this account's token on disk and our in-memory copy is the source of truth
    // for the live token until ensureFreshToken adopts a rotation.
    const canonical = this.get(id);
    if (canonical) patch(canonical);
  }

  /**
   * Replace the canonical in-memory storage wholesale with `next` (the disk
   * state loaded fresh under the cross-process lock by the transaction). Used by
   * add / remove / switchTo, which change pool structure or activeIndex.
   *
   * WHY A WHOLESALE REPLACE IS SAFE (no token clobber): tokens are ALWAYS
   * persisted durable-first — getFreshTokens writes the rotated refresh token to
   * disk BEFORE it resolves, so canonical never holds an unpersisted token. That
   * means `next` (read from disk under the lock) already carries the latest
   * tokens, and adopting it cannot regress a rotation. Do NOT weaken this
   * invariant: if a future change let canonical hold a token not yet on disk,
   * this replace would silently lose it.
   */
  private adoptStorage(next: AccountStorage): void {
    this.storage = next;
  }

  /**
   * Adopt token fields from a reloaded account into the canonical in-memory
   * account object (in place), so future selection/refresh checks see them.
   */
  private adoptTokens(canonical: AccountMetadata, from: AccountMetadata): void {
    canonical.accessToken = from.accessToken;
    canonical.refreshToken = from.refreshToken;
    canonical.expiresAt = from.expiresAt;
  }

  /**
   * ensureFreshToken — the S4 crux.
   *
   * Layered composition:
   *   1. FAST PATH: if the canonical account's access token is still valid past
   *      the skew, return it with NO lock and NO network.
   *   2. In-process single-flight per accountId: concurrent callers in this
   *      process join one shared promise. Joiners do NOT take the file lock.
   *   3. The WINNER runs the refresh under the cross-process lock:
   *        acquire lock
   *        → RELOAD storage from disk under the lock
   *        → if the reloaded account's token is now valid (another process
   *          already rotated it), ADOPT it into canonical and RETURN it,
   *          SKIPPING the network refresh entirely
   *        → else getFreshTokens(canonicalAccount, persist), where `persist` is
   *          a load-modify-save that re-reads the latest storage under the SAME
   *          transaction lock and writes ONLY this account's token fields back,
   *          so it never clobbers other accounts' tokens
   *      release lock (in finally, inside withCrossProcessTransaction)
   *
   * getFreshTokens does the grant + atomic-persist-before-resolve + in-place
   * mutation of the canonical account; we layer the lock/reload around its
   * winner path rather than duplicating its logic.
   *
   * @param force when true, SKIP the top fast-path so a still-valid-looking but
   *   server-side-revoked access token is genuinely re-granted. Used by the
   *   auth-dead recovery path in the fetch pipeline: an inference 401 means the
   *   current access token is dead even though it has not locally expired, so
   *   returning it unchanged would loop. Everything else (single-flight join,
   *   refreshUnderLock, and its own reload-under-lock reconciliation) is
   *   unchanged — under force we still adopt a fresh token another process
   *   rotated while we waited for the lock, avoiding a redundant grant.
   */
  async ensureFreshToken(id: string, force = false): Promise<Tokens> {
    await this.ensureLoaded();
    const canonical = this.get(id);
    if (!canonical) {
      throw new Error(`ensureFreshToken: unknown account ${id}`);
    }

    // Capture the access token we are about to treat as KNOWN-BAD, so the
    // winner path can tell "the disk still holds this same bad token" (must
    // grant) from "another process rotated a genuinely different fresh token"
    // (adopt, no redundant grant). Only meaningful under force.
    const staleAccessToken = force ? canonical.accessToken : undefined;

    // 1. Fast path: token still valid — no lock, no network. Bypassed under
    //    `force` (auth-dead recovery), where a locally-valid token is known bad.
    if (!force && accessTokenValid(canonical, Date.now())) {
      return {
        accessToken: canonical.accessToken as string,
        refreshToken: canonical.refreshToken,
        expiresAt: canonical.expiresAt as number,
      };
    }

    // 2. In-process single-flight: joiners share the winner's promise.
    const existing = this.freshInFlight.get(id);
    if (existing) {
      logger.debug(`ensureFreshToken joining in-flight refresh for ${id}`);
      return existing;
    }

    const run = this.refreshUnderLock(id, force, staleAccessToken);
    this.freshInFlight.set(id, run);
    try {
      return await run;
    } finally {
      this.freshInFlight.delete(id);
    }
  }

  /**
   * The single-flight WINNER path. Runs the whole refresh critical section
   * inside one cross-process transaction so the disk lock is held across the
   * reload-check AND the network grant + persist.
   *
   * Under `force` (auth-dead recovery) the reload-check is NARROWED: we only
   * adopt the disk token WITHOUT a grant if it DIFFERS from `staleAccessToken`
   * (the token we already know inference rejected). A genuine cross-process
   * rotation always mints a different access token, so this still avoids a
   * redundant grant when another process legitimately refreshed — but when disk
   * holds the SAME known-bad token, we fall through and force a real grant
   * (oracle S-1). We also clear the stale `expiresAt` on canonical before the
   * grant so getFreshTokens' own internal fast-path cannot short-circuit it.
   */
  private async refreshUnderLock(
    id: string,
    force = false,
    staleAccessToken?: string,
  ): Promise<Tokens> {
    return withCrossProcessTransaction<Tokens>(async (storage) => {
      const reloaded = storage.accounts.find((a) => a.accountId === id);
      if (!reloaded) {
        throw new Error(`ensureFreshToken: account ${id} vanished from storage`);
      }

      // Re-fetch the canonical object INSIDE the transaction. A concurrent
      // add/remove calls adoptStorage() which replaces this.storage wholesale,
      // so a reference captured before the transaction could have detached from
      // the live pool. Fetching here guarantees we mutate the current canonical
      // object, not a stale one.
      const canonical = this.get(id);
      if (!canonical) {
        throw new Error(
          `ensureFreshToken: account ${id} vanished from canonical pool`,
        );
      }

      // Another process may have rotated the token while we waited for the
      // lock. If the reloaded token is now valid, adopt it and SKIP the grant.
      // Under force, only do so when the disk token DIFFERS from the known-bad
      // one — a same-token "valid" disk entry is exactly what force must ignore.
      const diskDiffersFromStale =
        !force || reloaded.accessToken !== staleAccessToken;
      if (accessTokenValid(reloaded, Date.now()) && diskDiffersFromStale) {
        logger.debug(
          `ensureFreshToken: disk token for ${id} already fresh; skipping refresh`,
        );
        this.adoptTokens(canonical, reloaded);
        return {
          accessToken: reloaded.accessToken as string,
          refreshToken: reloaded.refreshToken,
          expiresAt: reloaded.expiresAt as number,
        };
      }

      // The reloaded entry holds the latest refresh token on disk — feed THAT
      // into the canonical object before refreshing so we never send a
      // rotated-away token.
      this.adoptTokens(canonical, reloaded);

      // Under force, neutralize getFreshTokens' internal fast-path: a
      // locally-valid `expiresAt` on the known-bad token would otherwise make it
      // return the same dead token without a grant. Expiring it forces the grant.
      if (force) {
        canonical.expiresAt = 0;
      }

      // getFreshTokens performs the grant, mutates `canonical` in place with the
      // rotated tokens, and awaits this `persist` callback BEFORE resolving. To
      // honor its HARD CONTRACT (the rotated refresh token must be DURABLE before
      // the refresh is treated as complete — otherwise a crash loses it and
      // bricks the account) the callback writes to disk itself, while we still
      // hold the cross-process lock. It writes ONLY this account's token fields
      // into `storage` (loaded fresh under this same lock), so it never clobbers
      // other accounts. The transaction's trailing saveAccounts then re-persists
      // the same state idempotently.
      const tokens = await getFreshTokens(canonical, async (fresh) => {
        const target = storage.accounts.find((a) => a.accountId === id);
        if (!target) {
          throw new Error(
            `ensureFreshToken persist: account ${id} vanished from storage`,
          );
        }
        target.accessToken = fresh.accessToken;
        target.refreshToken = fresh.refreshToken;
        target.expiresAt = fresh.expiresAt;
        // Durable write BEFORE getFreshTokens resolves (contract), under lock.
        await saveAccounts(storage, this.storagePath);
      });

      return tokens;
    }, this.storagePath);
  }
}

// -----------------------------------------------------------------------------
// Process singleton accessor.
// -----------------------------------------------------------------------------

let singleton: AccountManager | null = null;
let singletonPath: string | undefined;

/**
 * Get the process-wide AccountManager singleton. The first call fixes the
 * storage path; passing a different path afterwards is a programming error.
 */
export function getAccountManager(storagePath?: string): AccountManager {
  if (!singleton) {
    singleton = new AccountManager(storagePath);
    singletonPath = storagePath;
    return singleton;
  }
  if (storagePath !== undefined && storagePath !== singletonPath) {
    throw new Error(
      "getAccountManager called with a different storagePath than the existing singleton",
    );
  }
  return singleton;
}

/** Reset the singleton (test helper). */
export function resetAccountManager(): void {
  singleton = null;
  singletonPath = undefined;
}
