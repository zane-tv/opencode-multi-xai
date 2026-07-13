import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { MAX_ACCOUNTS } from "../constants.js";
import type { AccountManager } from "../accounts.js";
import type { AccountMetadata } from "../schemas.js";
import {
  accountDisplayName,
  resolveAccount,
  shortId,
} from "./resolve.js";
import { fetchGrokUserProfile } from "../request/user-profile.js";
import {
  formatAge,
  formatDateTime,
  formatUntil,
} from "../format-time.js";
import { renderStatusLine } from "../tui-status.js";
import {
  formatCostUsd,
  formatRemaining,
  probeAccountRateLimit,
} from "../request/rate-limit.js";
import { fetchGrokBillingQuota } from "../request/billing-quota.js";
import {
  deriveRemainingFromPlanUsage,
  fetchGrokPlan,
  formatPlanLimit,
  planFromAccessToken,
} from "../request/plan.js";

/**
 * CLI management tools registered via the plugin `tool` hook.
 *
 * Kept in a SEPARATE module from the plugin entry on purpose: OpenCode's
 * plugin loader (legacy path) iterates every export of the plugin module and
 * may invoke each function as a Plugin. A non-plugin function export like
 * buildTools can throw under that path and silently drop the whole plugin
 * (auth methods included). Do not re-export this from the plugin entry file.
 */

const { schema } = tool;

/** Args accepted by any tool that targets a single account. */
const selectorArgs = {
  index: schema
    .number()
    .int()
    .optional()
    .describe("0-based position of the account (see xai-list)"),
  id: schema
    .string()
    .optional()
    .describe("account id (a unique prefix is accepted)"),
};

/** A short, log-safe identifier for an account (never a token). */
function identify(a: AccountMetadata): string {
  const who = accountDisplayName(a);
  if (who === shortId(a.accountId)) return who;
  return `${who}  (${shortId(a.accountId)})`;
}

/**
 * Why an account is prune-eligible. ONLY two criteria (oracle B1): a terminally
 * dead subscription, or a manual removal flag. Quota-exhaustion is recoverable
 * and never a prune reason. Prefers "dead" when both hold.
 */
function pruneReason(a: AccountMetadata): string {
  if (a.subscriptionStatus === "dead") return "dead (subscription terminated)";
  return "flagged for removal";
}

/** Human-readable one-line state for an account. */
function describeState(a: AccountMetadata, now: number): string {
  const parts: string[] = [];
  if (!a.enabled) parts.push("disabled");
  if (a.subscriptionStatus === "dead") parts.push("DEAD");
  if (a.entitlementBlocked) parts.push("entitlement-blocked");
  if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
    parts.push(`quota-exhausted ${formatUntil(a.quotaResetAt)}`);
  }
  if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
    const why = a.cooldownReason ? ` (${a.cooldownReason})` : "";
    parts.push(
      `cooling down${why} ${formatUntil(a.coolingDownUntil)}`,
    );
  }
  if (a.flaggedForRemoval) parts.push("flagged-for-removal");
  if (parts.length === 0) parts.push("ready");
  return parts.join(", ");
}

/** Render the pool as a readable, plain-text listing. */
function renderList(manager: AccountManager): string {
  const accounts = manager.list();
  if (accounts.length === 0) {
    return "No xAI accounts. Run `opencode auth login` and pick a SuperGrok OAuth method to add one.";
  }
  const activeIndex = manager.activeIndex();
  const now = Date.now();

  const lines = accounts.map((a, i) => {
    const marker = i === activeIndex ? "*" : " ";
    const who = accountDisplayName(a);
    const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
    return (
      `${marker} ${i}  ${who}${tags}\n` +
      `     id=${shortId(a.accountId)}  plan=${a.planName ?? (a.planTier !== undefined ? `tier ${a.planTier}` : "—")}  sub=${a.subscriptionStatus}  ` +
      `state=${describeState(a, now)}`
    );
  });

  return (
    `xAI accounts (${accounts.length}/${MAX_ACCOUNTS}) — * = active:\n` +
    lines.join("\n")
  );
}

/**
 * Build the tool map for the plugin `tool` hook. Each tool resolves its target
 * via the shared `resolveAccount` helper, mutates through the manager, and
 * returns a concise confirmation string.
 */
export function buildTools(
  manager: AccountManager,
): Record<string, ToolDefinition> {
  const target = (args: { index?: number; id?: string }): AccountMetadata =>
    resolveAccount(manager.list(), args);

  return {
    "xai-status": tool({
      description:
        "Show a compact one-line status of the xAI account pool: the active " +
        "account plus counts of ready / quota-exhausted / cooling / " +
        "entitlement-blocked / dead accounts, and a warning badge when any " +
        "account is dead or flagged for removal.",
      args: {},
      async execute() {
        return renderStatusLine(manager.list(), manager.activeIndex(), Date.now());
      },
    }),

    "xai-list": tool({
      description:
        "List all configured xAI accounts, their state, and which is active. " +
        "Optional tag filter.",
      args: {
        tag: schema
          .string()
          .optional()
          .describe("only list accounts whose tags include this tag"),
      },
      async execute(args) {
        const tag = args.tag?.trim();
        if (!tag) return renderList(manager);
        const accounts = manager.list().filter((a) => a.tags.includes(tag));
        if (accounts.length === 0) {
          return `No xAI accounts with tag "${tag}".`;
        }
        const activeIndex = manager.activeIndex();
        const all = manager.list();
        const now = Date.now();
        const lines = accounts.map((a) => {
          const i = all.findIndex((x) => x.accountId === a.accountId);
          const marker = i === activeIndex ? "*" : " ";
          const who = accountDisplayName(a);
          const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
          return (
            `${marker} ${i}  ${who}${tags}\n` +
            `     id=${shortId(a.accountId)}  plan=${a.planName ?? (a.planTier !== undefined ? `tier ${a.planTier}` : "—")}  sub=${a.subscriptionStatus}  ` +
            `state=${describeState(a, now)}`
          );
        });
        return (
          `xAI accounts with tag "${tag}" (${accounts.length}):\n` +
          lines.join("\n")
        );
      },
    }),

    "xai-add": tool({
      description:
        "How to add another SuperGrok account to the pool. " +
        "Accounts are only created via SuperGrok OAuth (no raw token paste).",
      args: {},
      async execute() {
        const n = manager.list().length;
        return [
          `Add SuperGrok account (pool ${n}/${MAX_ACCOUNTS}):`,
          "",
          "Recommended:",
          "  op-xai tui          → press +  (device OAuth inside TUI)",
          "  op-xai add          → device OAuth in terminal",
          "  op-xai add --browser",
          "",
          "Or via OpenCode:",
          "  opencode auth login → xai-multi → SuperGrok OAuth",
          "",
          "Re-login of an existing account refreshes its tokens.",
          "Then: xai-list / xai-switch / xai-label / xai-health / xai-limits",
        ].join("\n");
      },
    }),

    "xai-switch": tool({
      description:
        "Switch the active xAI account by index or id. Selection is sticky, so " +
        "subsequent requests drain the chosen account first.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        await manager.switchTo(account.accountId);
        return `Active account is now ${shortId(account.accountId)}${
          account.label ? ` (${account.label})` : ""
        }.`;
      },
    }),

    "xai-priority": tool({
      description:
        "Change account rotation priority (list order). Higher priority is " +
        "preferred earlier when the sticky active account is not usable. " +
        "direction: up | down | top, or set absolute priority number.",
      args: {
        ...selectorArgs,
        direction: schema
          .enum(["up", "down", "top"])
          .optional()
          .describe("move one step up/down or to top of the queue"),
        priority: schema
          .number()
          .int()
          .optional()
          .describe("absolute priority value (higher = earlier)"),
      },
      async execute(args) {
        const account = target(args);
        if (args.priority !== undefined) {
          await manager.setPriority(account.accountId, args.priority);
        } else if (args.direction === "top") {
          await manager.moveToFront(account.accountId);
        } else if (args.direction === "up" || args.direction === "down") {
          await manager.movePriority(account.accountId, args.direction);
        } else {
          return (
            "xai-priority needs direction=up|down|top or priority=<int>. " +
            "Example: direction=up index=2"
          );
        }
        const list = manager.list();
        const idx = list.findIndex((a) => a.accountId === account.accountId);
        const fresh = list[idx];
        return (
          `Priority updated for ${shortId(account.accountId)}: ` +
          `now list #${idx}. Order is rotation preference after sticky active fails.`
        );
      },
    }),

    "xai-remove": tool({
      description:
        "Remove one xAI account from the pool by index or id. " +
        "Requires confirm=true (destructive; OAuth credentials cannot be recovered).",
      args: {
        ...selectorArgs,
        confirm: schema
          .boolean()
          .optional()
          .describe(
            "must be true to delete; omit/false is a no-op with guidance",
          ),
      },
      async execute(args) {
        if (args.confirm !== true) {
          return (
            "xai-remove requires confirm=true. " +
            "Removing deletes OAuth credentials and cannot be undone. " +
            "Re-run as: xai-remove index=<N> confirm=true  (or id=<prefix> confirm=true)"
          );
        }
        const account = target(args);
        await manager.remove(account.accountId);
        return `Removed account ${shortId(account.accountId)}.`;
      },
    }),

    "xai-enable": tool({
      description: "Enable an xAI account so selection may use it.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        await manager.setEnabled(account.accountId, true);
        return `Enabled account ${shortId(account.accountId)}.`;
      },
    }),

    "xai-disable": tool({
      description: "Disable an xAI account so selection skips it.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        await manager.setEnabled(account.accountId, false);
        return `Disabled account ${shortId(account.accountId)}.`;
      },
    }),

    "xai-label": tool({
      description:
        "Set (or clear) a friendly label on an xAI account. Omit `label` to clear.",
      args: {
        ...selectorArgs,
        label: schema
          .string()
          .optional()
          .describe("label text; omit or empty to clear"),
      },
      async execute(args) {
        const account = target(args);
        const label = args.label && args.label.length > 0 ? args.label : undefined;
        await manager.setLabel(account.accountId, label);
        return label
          ? `Set label of ${shortId(account.accountId)} to "${label}".`
          : `Cleared label of ${shortId(account.accountId)}.`;
      },
    }),

    "xai-tag": tool({
      description:
        "Replace the tags on an xAI account with a comma-separated list. " +
        "Pass an empty string to clear all tags.",
      args: {
        ...selectorArgs,
        tags: schema
          .string()
          .describe("comma-separated tags, e.g. 'work, primary'"),
      },
      async execute(args) {
        const account = target(args);
        const tags = args.tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        await manager.setTags(account.accountId, tags);
        return tags.length > 0
          ? `Set tags of ${shortId(account.accountId)} to [${tags.join(", ")}].`
          : `Cleared tags of ${shortId(account.accountId)}.`;
      },
    }),

    "xai-note": tool({
      description:
        "Set (or clear) a free-form note on an xAI account. Omit `note` to clear.",
      args: {
        ...selectorArgs,
        note: schema.string().optional().describe("note text; omit to clear"),
      },
      async execute(args) {
        const account = target(args);
        const note = args.note && args.note.length > 0 ? args.note : undefined;
        await manager.setNote(account.accountId, note);
        return note
          ? `Set note on ${shortId(account.accountId)}.`
          : `Cleared note on ${shortId(account.accountId)}.`;
      },
    }),

    "xai-refresh": tool({
      description:
        "Force a token refresh for an xAI account (bypasses the fast path). " +
        "Reports success or failure without ever printing token values.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        try {
          await manager.ensureFreshToken(account.accountId, true);
          return `Refreshed tokens for ${shortId(account.accountId)}.`;
        } catch (err) {
          return `Failed to refresh ${shortId(account.accountId)}: ${
            (err as Error).message
          }`;
        }
      },
    }),

    "xai-health": tool({
      description:
        "Check health of all SuperGrok accounts by validating refresh tokens " +
        "(force refresh). Reports healthy vs failed without printing tokens. " +
        "Similar to codex-health in oc-codex-multi-auth.",
      args: {},
      async execute() {
        const accounts = manager.list();
        if (accounts.length === 0) {
          return "No xAI accounts. Run xai-add (or opencode auth login) first.";
        }
        const lines: string[] = [
          `Health check (${accounts.length} account(s)):`,
          "",
        ];
        let ok = 0;
        let bad = 0;
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i]!;
          const who = accountDisplayName(a);
          try {
            await manager.ensureFreshToken(a.accountId, true);
            lines.push(`  OK   ${i}  ${who}  id=${shortId(a.accountId)}`);
            ok++;
          } catch (err) {
            lines.push(
              `  FAIL ${i}  ${who}  id=${shortId(a.accountId)}  ${(err as Error).message}`,
            );
            bad++;
          }
        }
        lines.push("", `Summary: ${ok} healthy, ${bad} failed.`);
        return lines.join("\n");
      },
    }),

    "xai-limits": tool({
      description:
        "Show SuperGrok remaining quota: (1) monthly credits % from grok.com " +
        "GetGrokCreditsConfig (same as opencode-bar), (2) API rate-limit " +
        "remaining requests/tokens from x-ratelimit headers. " +
        "probe=true refreshes both (billing + tiny chat). Alias: xai-quota.",
      args: {
        id: selectorArgs.id,
        index: selectorArgs.index,
        probe: schema
          .boolean()
          .optional()
          .describe(
            "when true, refresh monthly credits (grok.com) and API rate-limit headers",
          ),
      },
      async execute(args) {
        const now = Date.now();
        let accounts = manager.list();
        if (accounts.length === 0) {
          return "No xAI accounts. Run xai-add (or opencode auth login) first.";
        }
        if (args.id !== undefined || args.index !== undefined) {
          accounts = [target(args)];
        }
        const doProbe = args.probe === true;
        const activeIndex = manager.activeIndex();
        const all = manager.list();
        const lines: string[] = [
          `SuperGrok quota (${accounts.length} account(s))` +
            `${doProbe ? " [live]" : ""}:`,
          "Sources: grok.com billing %  +  api.x.ai x-ratelimit headers",
          "",
        ];

        for (const a of accounts) {
          const i = all.findIndex((x) => x.accountId === a.accountId);
          const marker = i === activeIndex ? "*" : " ";
          const who = accountDisplayName(a);
          lines.push(`${marker} [${i}] ${who}  id=${shortId(a.accountId)}`);
          lines.push(`    enabled=${a.enabled}  sub=${a.subscriptionStatus}`);
          {
            const plan =
              a.planName ??
              (a.planTier !== undefined ? `tier ${a.planTier}` : "—");
            const lim =
              a.planMonthlyLimit !== undefined
                ? formatPlanLimit(a.planMonthlyLimit)
                : "—";
            const used =
              a.planUsed !== undefined ? formatPlanLimit(a.planUsed) : "—";
            lines.push(`    plan=${plan}  monthly ${used}/${lim}`);
          }

          if (doProbe) {
            try {
              const tokens = await manager.ensureFreshToken(a.accountId);
              try {
                if (!a.email) {
                  try {
                    const profile = await fetchGrokUserProfile(tokens.accessToken);
                    if (profile.email) {
                      await manager.setEmail(a.accountId, profile.email);
                    }
                  } catch {
                    // optional
                  }
                }
                const jwtPlan = planFromAccessToken(tokens.accessToken);
                await manager.recordPlan(a.accountId, {
                  planTier: jwtPlan.planTier,
                  planName: jwtPlan.planName,
                  observedAt: jwtPlan.observedAt,
                });
                const plan = await fetchGrokPlan(tokens.accessToken);
                await manager.recordPlan(a.accountId, plan);
              } catch {
                // plan optional
              }

              try {
                const bill = await fetchGrokBillingQuota(tokens.accessToken);
                await manager.recordBillingQuota(a.accountId, bill);
              } catch (err) {
                // Fallback remaining % from absolute plan used/limit
                const freshPlan = manager.get(a.accountId);
                const derived = deriveRemainingFromPlanUsage(
                  freshPlan?.planUsed,
                  freshPlan?.planMonthlyLimit,
                );
                if (derived) {
                  await manager.recordBillingQuota(a.accountId, {
                    monthlyUsedPercent: derived.monthlyUsedPercent,
                    remainingPercent: derived.remainingPercent,
                    resetsAtMs: freshPlan?.planPeriodEndMs,
                    observedAt: Date.now(),
                  });
                  lines.push(
                    `    billing probe: FAIL (used plan fallback) ${(err as Error).message}`,
                  );
                } else {
                  lines.push(
                    `    billing probe: FAIL ${(err as Error).message}`,
                  );
                }
              }
              try {
                const snap = await probeAccountRateLimit(tokens.accessToken);
                await manager.recordRateLimit(a.accountId, snap);
              } catch (err) {
                lines.push(
                  `    API rate-limit probe: FAIL ${(err as Error).message}`,
                );
              }
            } catch (err) {
              lines.push(`    token: FAIL ${(err as Error).message}`);
            }
          }

          const fresh = manager.get(a.accountId) ?? a;

          // (1) Monthly SuperGrok / Grok Build credits — opencode-bar style
          {
            const derived = deriveRemainingFromPlanUsage(
              fresh.planUsed,
              fresh.planMonthlyLimit,
            );
            const rem =
              fresh.billingRemainingPercent ?? derived?.remainingPercent;
            const usedNum =
              fresh.billingMonthlyUsedPercent ?? derived?.monthlyUsedPercent;
            if (rem !== undefined) {
              const used =
                usedNum !== undefined ? usedNum.toFixed(1) : "?";
              lines.push(
                `    credits:  ${rem}% remaining` + ` (used ${used}%)`,
              );
              if (typeof fresh.billingResetsAt === "number") {
                lines.push(
                  `    resets:   ${formatUntil(fresh.billingResetsAt, now)}`,
                );
              } else if (typeof fresh.planPeriodEndMs === "number") {
                lines.push(
                  `    resets:   ${formatUntil(fresh.planPeriodEndMs, now)}`,
                );
              }
              if (fresh.billingObservedAt || fresh.planObservedAt) {
                lines.push(
                  `    billing@: ${formatAge(
                    fresh.billingObservedAt ?? fresh.planObservedAt,
                    now,
                  )}`,
                );
              }
            } else {
              lines.push(
                "    credits:  unknown (run xai-limits --probe)",
              );
            }
          }

          // (2) API technical rate limits
          if (
            fresh.rateLimitRemainingRequests !== undefined ||
            fresh.rateLimitRemainingTokens !== undefined
          ) {
            lines.push(
              `    requests: ${formatRemaining(
                fresh.rateLimitRemainingRequests,
                fresh.rateLimitLimitRequests,
              )}`,
            );
            lines.push(
              `    tokens:   ${formatRemaining(
                fresh.rateLimitRemainingTokens,
                fresh.rateLimitLimitTokens,
              )}`,
            );
            if (fresh.lastCostInUsdTicks !== undefined) {
              lines.push(
                `    last cost: ${formatCostUsd(fresh.lastCostInUsdTicks)}`,
              );
            }
          } else {
            lines.push(
              "    API RPS/TPM: unknown (probe or use the model once)",
            );
          }

          if (fresh.entitlementBlocked) {
            lines.push("    entitlement: BLOCKED (xAI allowlist gate)");
          }
          if (typeof fresh.quotaResetAt === "number" && fresh.quotaResetAt > now) {
            lines.push(
              `    exhausted ${formatUntil(fresh.quotaResetAt, now)}`,
            );
          }
          if (
            typeof fresh.coolingDownUntil === "number" &&
            fresh.coolingDownUntil > now
          ) {
            lines.push(
              `    cooldown: ${fresh.cooldownReason ?? "unknown"} ` +
                `${formatUntil(fresh.coolingDownUntil, now)}`,
            );
          }
          lines.push("");
        }
        lines.push(
          "Tip: xai-limits --probe refreshes SuperGrok credits % + API remaining.",
        );
        return lines.join("\n");
      },
    }),

    "xai-flag": tool({
      description:
        "Flag an xAI account for removal (marks it prunable by xai-prune). " +
        "Does NOT delete anything on its own.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        await manager.setFlaggedForRemoval(account.accountId, true);
        return `Flagged ${identify(account)} for removal.`;
      },
    }),

    "xai-unflag": tool({
      description: "Clear the removal flag on an xAI account.",
      args: selectorArgs,
      async execute(args) {
        const account = target(args);
        await manager.setFlaggedForRemoval(account.accountId, false);
        return `Cleared the removal flag on ${identify(account)}.`;
      },
    }),

    "xai-prune": tool({
      description:
        "Bulk-remove xAI accounts whose subscription is terminated (dead) or " +
        "that were manually flagged for removal. DRY-RUN BY DEFAULT: with no " +
        "arguments (or dryRun=true) it only REPORTS what would be pruned and " +
        "deletes nothing. Pass dryRun=false to actually delete (a one-time " +
        "backup is taken first). Quota-exhausted accounts are recoverable and " +
        "are NEVER pruned. Optionally restrict to accounts carrying a given tag.",
      args: {
        dryRun: schema
          .boolean()
          .optional()
          .describe(
            "when true (the default), only report; pass false to actually delete",
          ),
        tag: schema
          .string()
          .optional()
          .describe("only prune accounts whose tags include this tag"),
      },
      async execute(args) {
        const dryRun = args.dryRun ?? true;
        const tag = args.tag && args.tag.length > 0 ? args.tag : undefined;

        let targets = manager.prunableAccounts();
        if (tag) targets = targets.filter((a) => a.tags.includes(tag));

        const total = manager.list().length;
        if (targets.length === 0) {
          const scope = tag ? ` with tag "${tag}"` : "";
          return `Nothing to prune${scope}: no accounts are dead or flagged for removal. (${total} account(s) in the pool.)`;
        }

        const listing = targets
          .map((a) => `  - ${identify(a)}: ${pruneReason(a)}`)
          .join("\n");

        if (dryRun) {
          const remaining = total - targets.length;
          return (
            `DRY RUN — would prune ${targets.length} of ${total} account(s)` +
            `${tag ? ` (tag "${tag}")` : ""}, leaving ${remaining}:\n` +
            `${listing}\n` +
            `Nothing was deleted. Re-run with dryRun=false to delete.`
          );
        }

        const ids = targets.map((a) => a.accountId);
        const { removed } = await manager.pruneAccounts(ids);
        return (
          `Pruned ${removed.length} of ${total} account(s)` +
          `${tag ? ` (tag "${tag}")` : ""}, ${total - removed.length} remaining. ` +
          `A backup was taken before deleting.\n` +
          `${listing}`
        );
      },
    }),
  };
}
