import type { AccountMetadata } from "./schemas.js";
import { isSelectable } from "./accounts.js";
import { accountDisplayName } from "./tools/resolve.js";

/**
 * Pure status-line renderer for the account pool.
 *
 * WHY THIS IS A STANDALONE PURE FUNCTION (Phase 6 discovery outcome):
 * The installed `@opencode-ai/plugin` (v1.17.18) `Hooks` interface exposes NO
 * statusline / prompt-status hook to a SERVER plugin — only `event`, `tool`,
 * `auth`, `provider`, `chat.*`, etc. The rich persistent-slot TUI API
 * (`session_prompt_right`, `ui.Slot`, `TuiPromptRef`) lives ONLY in the
 * separate `@opencode-ai/plugin/tui` `TuiPlugin` module type, which requires
 * SolidJS/JSX + the `@opentui/*` peer deps (NOT installed here) and is a
 * different module shape than our `server` Plugin. The only status surface
 * reachable from the server plugin is on-demand (`client.tui.showToast` and our
 * own `tool` hook). So we build the status content as a pure, side-effect-free
 * function over read-only AccountManager state; it is rendered on demand by the
 * `xai-status` tool and is ready to wire into a real status-line slot if/when
 * one lands in the plugin API.
 *
 * INVARIANTS:
 *   - PURE: no I/O, no logging, no Date.now() (the caller passes `now`).
 *   - NEVER emits a token value (only ids/labels/emails/counts).
 */

/** A structured summary of pool state (also useful for tests / future slots). */
export interface PoolStatusSummary {
  /** Total accounts in the pool. */
  total: number;
  /** Accounts currently selectable (enabled, not dead/blocked/quota/cooling). */
  ready: number;
  /** Accounts with a future quotaResetAt. */
  quotaExhausted: number;
  /** Accounts with a future coolingDownUntil. */
  cooling: number;
  /** Accounts hit by the xAI allowlist gate (#26847). */
  entitlementBlocked: number;
  /** Accounts whose subscription is terminally dead. */
  dead: number;
  /** Accounts explicitly flagged for removal. */
  flagged: number;
  /** Accounts disabled by the user. */
  disabled: number;
}

/**
 * Compute a structured status summary over a pool snapshot. Pure: pass the
 * current epoch ms as `now`.
 */
export function summarizePool(
  accounts: AccountMetadata[],
  now: number,
): PoolStatusSummary {
  const summary: PoolStatusSummary = {
    total: accounts.length,
    ready: 0,
    quotaExhausted: 0,
    cooling: 0,
    entitlementBlocked: 0,
    dead: 0,
    flagged: 0,
    disabled: 0,
  };

  for (const a of accounts) {
    if (isSelectable(a, now)) summary.ready++;
    if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
      summary.quotaExhausted++;
    }
    if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
      summary.cooling++;
    }
    if (a.entitlementBlocked) summary.entitlementBlocked++;
    if (a.subscriptionStatus === "dead") summary.dead++;
    if (a.flaggedForRemoval) summary.flagged++;
    if (!a.enabled) summary.disabled++;
  }

  return summary;
}

function accountName(a: AccountMetadata): string {
  return accountDisplayName(a);
}

/**
 * Render a compact one-line status string for the account pool.
 *
 * Shape (empty pool):        `xai: no accounts`
 * Shape (normal):            `xai: <active> · 3 ready · 1 quota · 1 cooling`
 * Shape (with warning):      `xai: <active> · 2 ready · ⚠ 1 dead, 1 flagged`
 *
 * `activeIndex` selects the active account label; an out-of-range index (e.g.
 * the pool changed) degrades gracefully to no active-name segment.
 */
export function renderStatusLine(
  accounts: AccountMetadata[],
  activeIndex: number,
  now: number,
): string {
  if (accounts.length === 0) return "xai: no accounts";

  const summary = summarizePool(accounts, now);
  const segments: string[] = [];

  const active = accounts[activeIndex];
  if (active) segments.push(accountName(active));

  segments.push(`${summary.ready} ready`);
  if (summary.quotaExhausted > 0) {
    segments.push(`${summary.quotaExhausted} quota`);
  }
  if (summary.cooling > 0) segments.push(`${summary.cooling} cooling`);
  if (summary.entitlementBlocked > 0) {
    segments.push(`${summary.entitlementBlocked} blocked`);
  }
  if (summary.disabled > 0) segments.push(`${summary.disabled} disabled`);

  // Warning badge ties to the prune feature: dead subscriptions or manual flags
  // are the two prune criteria, so surface them prominently.
  const warnParts: string[] = [];
  if (summary.dead > 0) warnParts.push(`${summary.dead} dead`);
  if (summary.flagged > 0) warnParts.push(`${summary.flagged} flagged`);
  if (warnParts.length > 0) {
    segments.push(`⚠ ${warnParts.join(", ")} (run xai-prune)`);
  }

  return `xai: ${segments.join(" · ")}`;
}
