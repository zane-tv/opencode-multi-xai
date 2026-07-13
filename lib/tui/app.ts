/**
 * OpenTUI account manager for SuperGrok multi-account pool.
 * Run via: op-xai tui
 *
 * Visual language: OpenCode default theme (warm orange primary, purple accent,
 * neutral gray steps). Dense operator layout for account + quota management.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  parseColor,
  stringToStyledText,
  type SelectOption,
} from "@opentui/core";

import { AccountManager } from "../accounts.js";
import type { AccountMetadata } from "../schemas.js";
import { shortId } from "../tools/resolve.js";
import {
  formatCostUsd,
  formatRemaining,
  probeAccountRateLimit,
} from "../request/rate-limit.js";
import { fetchGrokBillingQuota } from "../request/billing-quota.js";
import {
  fetchGrokPlan,
  formatPlanLimit,
  planFromAccessToken,
} from "../request/plan.js";
import {
  browserLogin,
  deviceCodeLoginFlow,
  openInBrowser,
} from "../auth/login.js";

/**
 * Design tokens — OpenCode default TUI palette
 * (opencode theme: warm orange primary, purple accent, neutral gray steps)
 * Source: OpenCode built-in `opencode` theme / public palette dumps.
 */
const T = {
  bg: "#0a0a0a", // darkStep1
  surface: "#141414", // darkStep2 / backgroundPanel
  surfaceRaised: "#1e1e1e", // darkStep3
  surfaceInput: "#1e1e1e",
  border: "#484848", // darkStep7
  borderSoft: "#282828", // darkStep4
  borderFocus: "#fab283", // primary warm orange
  accent: "#fab283", // primary
  accentDim: "#c48a62",
  secondary: "#5c9cf5", // blue
  purple: "#9d7cd8", // accent
  text: "#eeeeee", // darkStep12
  textSoft: "#c8c8c8",
  textMuted: "#808080", // darkStep11
  textDim: "#606060", // darkStep8
  success: "#7fd88f",
  warn: "#f5a742",
  danger: "#e06c75",
  info: "#5c9cf5",
  cyan: "#56b6c2",
  selectedBg: "#282828", // darkStep4
  selectedText: "#fab283",
  actionSelectedBg: "#1e1e1e",
} as const;

type ActionId =
  | "add"
  | "add-device"
  | "add-browser"
  | "refresh"
  | "refresh-all"
  | "live-toggle"
  | "switch"
  | "enable"
  | "disable"
  | "label"
  | "tags"
  | "note"
  | "flag"
  | "unflag"
  | "remove"
  | "prune-dead"
  | "reload"
  | "quit";

type EditField = "label" | "tags" | "note";

function isExpiredPlan(a: AccountMetadata): boolean {
  if (a.subscriptionStatus === "dead") return true;
  if (a.flaggedForRemoval) return true;
  if (
    typeof a.billingRemainingPercent === "number" &&
    a.billingRemainingPercent <= 0
  ) {
    return true;
  }
  if (
    typeof a.billingMonthlyUsedPercent === "number" &&
    a.billingMonthlyUsedPercent >= 99.5
  ) {
    return true;
  }
  return false;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Smooth quota bar (full + partial block glyphs).
 * width = number of cells.
 */
function meter(pct: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const frac = exact - full;
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const pi = Math.min(7, Math.floor(frac * 8));
  const cells: string[] = [];
  for (let i = 0; i < full; i++) cells.push("█");
  if (full < width) {
    if (pi > 0) cells.push(partials[pi]!);
    while (cells.length < width) cells.push("░");
  }
  return cells.slice(0, width).join("");
}

function meterBracket(pct: number, width = 16): string {
  return `│${meter(pct, width)}│`;
}

function ratioPct(remaining?: number, limit?: number): number | undefined {
  if (
    remaining === undefined ||
    limit === undefined ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

function creditColor(pct: number | undefined): string {
  if (pct === undefined) return T.textDim;
  if (pct <= 0) return T.danger;
  if (pct < 15) return T.danger;
  if (pct < 40) return T.warn;
  return T.success;
}

function formatAge(ms: number | undefined, now: number): string {
  if (ms === undefined) return "never";
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function stateChips(a: AccountMetadata): string[] {
  const bits: string[] = [];
  if (a.planName) bits.push(a.planName);
  else if (a.planTier !== undefined) bits.push(`tier ${a.planTier}`);
  if (!a.enabled) bits.push("off");
  if (a.subscriptionStatus === "dead") bits.push("DEAD");
  if (a.flaggedForRemoval) bits.push("flagged");
  if (isExpiredPlan(a) && a.subscriptionStatus !== "dead") bits.push("EXPIRED");
  if (a.entitlementBlocked) bits.push("blocked");
  return bits;
}

function accountTitle(
  a: AccountMetadata,
  index: number,
  active: boolean,
): string {
  const mark = active ? "*" : " ";
  const who = a.label ?? a.email ?? shortId(a.accountId);
  const chips = stateChips(a);
  const extra = chips.length ? `  ${chips.join(" · ")}` : "";
  return `${mark} ${index}  ${who}${extra}`;
}

function accountSubtitle(a: AccountMetadata): string {
  const parts: string[] = [];
  if (a.planName) parts.push(a.planName);
  else if (a.planTier !== undefined) parts.push(`t${a.planTier}`);
  if (typeof a.billingRemainingPercent === "number") {
    parts.push(
      `${meterBracket(a.billingRemainingPercent, 10)} ${Math.round(a.billingRemainingPercent)}%`,
    );
  } else {
    parts.push("│░░░░░░░░░░│  ?%");
  }
  const reqPct = ratioPct(
    a.rateLimitRemainingRequests,
    a.rateLimitLimitRequests,
  );
  if (reqPct !== undefined) {
    parts.push(`req ${Math.round(reqPct)}%`);
  } else if (typeof a.rateLimitRemainingRequests === "number") {
    parts.push(`${formatCompact(a.rateLimitRemainingRequests)} req`);
  }
  if (a.tags.length) parts.push(`#${a.tags.slice(0, 2).join(",")}`);
  return parts.join("  ");
}

function accountDetail(
  a: AccountMetadata,
  index: number,
  active: boolean,
  now: number,
): string {
  const who = a.label ?? a.email ?? shortId(a.accountId);
  const planLabel =
    a.planName ??
    (a.planTier !== undefined ? `SuperGrok (tier ${a.planTier})` : "—");
  const planLimit =
    a.planMonthlyLimit !== undefined
      ? formatPlanLimit(a.planMonthlyLimit)
      : "—";
  const planUsed =
    a.planUsed !== undefined ? formatPlanLimit(a.planUsed) : "—";
  const planPeriod =
    typeof a.planPeriodEndMs === "number"
      ? new Date(a.planPeriodEndMs).toISOString().slice(0, 10)
      : "—";

  const lines: string[] = [
    `${active ? "* ACTIVE" : "  idle"}   #${index}   ${who}`,
    `id     ${shortId(a.accountId)}`,
    `email  ${a.email ?? "—"}`,
    `label  ${a.label ?? "—"}`,
    `tags   ${a.tags.length ? a.tags.map((t) => `#${t}`).join(" ") : "—"}`,
    `state  ${a.enabled ? "enabled" : "disabled"}  ·  sub ${a.subscriptionStatus}`,
    "",
    "── Plan ──────────────────────────────",
    `  ${planLabel}` +
      (a.planTier !== undefined ? `  (tier ${a.planTier})` : ""),
    `  monthly   ${planUsed} / ${planLimit} used`,
    `  period →  ${planPeriod}`,
    `  checked   ${formatAge(a.planObservedAt, now)}`,
    "",
    "── SuperGrok credits ─────────────────",
  ];

  if (a.billingRemainingPercent !== undefined) {
    const used =
      a.billingMonthlyUsedPercent !== undefined
        ? a.billingMonthlyUsedPercent.toFixed(1)
        : "?";
    const rem = Math.round(a.billingRemainingPercent * 10) / 10;
    lines.push(`  ${meterBracket(a.billingRemainingPercent, 20)}`);
    lines.push(`  remaining  ${rem}%    used ${used}%`);
    if (typeof a.billingResetsAt === "number") {
      const mins = Math.max(0, Math.ceil((a.billingResetsAt - now) / 60_000));
      lines.push(
        `  resets     ${new Date(a.billingResetsAt).toISOString()}` +
          (a.billingResetsAt > now ? `  (~${mins}m)` : ""),
      );
    }
    lines.push(`  checked    ${formatAge(a.billingObservedAt, now)}`);
  } else {
    lines.push(`  ${meterBracket(0, 20)}`);
    lines.push("  unknown — live refresh or press r");
  }

  lines.push("", "── API rate limits ────────────────────");
  if (
    a.rateLimitRemainingRequests !== undefined ||
    a.rateLimitRemainingTokens !== undefined
  ) {
    const reqPct = ratioPct(
      a.rateLimitRemainingRequests,
      a.rateLimitLimitRequests,
    );
    const tokPct = ratioPct(
      a.rateLimitRemainingTokens,
      a.rateLimitLimitTokens,
    );
    if (reqPct !== undefined) {
      lines.push(
        `  requests  ${meterBracket(reqPct, 16)}  ${Math.round(reqPct)}%`,
      );
      lines.push(
        `            ${formatRemaining(a.rateLimitRemainingRequests, a.rateLimitLimitRequests)}`,
      );
    } else {
      lines.push(
        `  requests  ${formatRemaining(a.rateLimitRemainingRequests, a.rateLimitLimitRequests)}`,
      );
    }
    if (tokPct !== undefined) {
      lines.push(
        `  tokens    ${meterBracket(tokPct, 16)}  ${Math.round(tokPct)}%`,
      );
      lines.push(
        `            ${formatRemaining(a.rateLimitRemainingTokens, a.rateLimitLimitTokens)}`,
      );
    } else {
      lines.push(
        `  tokens    ${formatRemaining(a.rateLimitRemainingTokens, a.rateLimitLimitTokens)}`,
      );
    }
    if (a.lastCostInUsdTicks !== undefined) {
      lines.push(`  last cost ${formatCostUsd(a.lastCostInUsdTicks)}`);
    }
    lines.push(`  checked   ${formatAge(a.rateLimitObservedAt, now)}`);
  } else {
    lines.push("  unknown — live refresh or press r");
  }

  const alerts: string[] = [];
  if (a.flaggedForRemoval) alerts.push("flagged for prune");
  if (isExpiredPlan(a)) alerts.push("EXPIRED / dead / 0% credits");
  if (a.entitlementBlocked) alerts.push("entitlement BLOCKED");
  if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
    alerts.push(`exhausted until ${new Date(a.quotaResetAt).toISOString()}`);
  }
  if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
    alerts.push(
      `cooldown ${a.cooldownReason ?? "?"} until ${new Date(a.coolingDownUntil).toISOString()}`,
    );
  }
  if (alerts.length) {
    lines.push("", "── alerts ─────────────────────────────");
    for (const al of alerts) lines.push(`  ! ${al}`);
  }

  if (a.note) {
    lines.push("", "── note ───────────────────────────────");
    lines.push(`  ${a.note}`);
  }

  lines.push(
    "",
    "edit  l label · t tags · n note",
    "ops   s switch · e/d · r refresh · v live · x del",
  );

  return lines.join("\n");
}

function poolSummary(
  accounts: AccountMetadata[],
  activeIndex: number,
): string {
  const now = Date.now();
  let ready = 0;
  let dead = 0;
  let low = 0;
  for (const a of accounts) {
    if (a.subscriptionStatus === "dead" || a.flaggedForRemoval) dead++;
    if (
      typeof a.billingRemainingPercent === "number" &&
      a.billingRemainingPercent > 0 &&
      a.billingRemainingPercent < 15
    ) {
      low++;
    }
    if (
      a.enabled &&
      a.subscriptionStatus !== "dead" &&
      !a.entitlementBlocked &&
      !(typeof a.quotaResetAt === "number" && a.quotaResetAt > now) &&
      !(typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now)
    ) {
      ready++;
    }
  }
  const active = accounts[activeIndex]
    ? (accounts[activeIndex]!.label ??
      accounts[activeIndex]!.email ??
      shortId(accounts[activeIndex]!.accountId))
    : "—";
  const bits = [`${accounts.length} accounts`, `${ready} ready`];
  if (low) bits.push(`${low} low`);
  if (dead) bits.push(`${dead} dead`);
  return `op-xai  ·  ${bits.join("  ·  ")}  ·  active ${active}`;
}

function accountOptions(
  accounts: AccountMetadata[],
  activeIndex: number,
): SelectOption[] {
  if (accounts.length === 0) {
    return [
      {
        name: "  empty pool",
        description: "opencode auth login → xai-multi → SuperGrok OAuth",
        value: -1,
      },
    ];
  }
  return accounts.map((a, i) => ({
    name: accountTitle(a, i, i === activeIndex),
    description: accountSubtitle(a),
    value: i,
  }));
}

const ACTION_OPTIONS: SelectOption[] = [
  {
    name: "+  Add (device)",
    description: "OAuth device code (recommended)",
    value: "add-device",
  },
  {
    name: "+  Add (browser)",
    description: "OAuth browser loopback",
    value: "add-browser",
  },
  {
    name: "+  How to add",
    description: "Show OAuth steps",
    value: "add",
  },
  { name: "r  Refresh", description: "Quota for selected", value: "refresh" },
  {
    name: "a  Refresh all",
    description: "Probe every account",
    value: "refresh-all",
  },
  {
    name: "v  Live quota",
    description: "Auto-refresh on/off",
    value: "live-toggle",
  },
  { name: "s  Switch", description: "Set sticky active", value: "switch" },
  { name: "e  Enable", description: "Include in rotation", value: "enable" },
  { name: "d  Disable", description: "Skip selection", value: "disable" },
  { name: "l  Label", description: "Display name", value: "label" },
  { name: "t  Tags", description: "Comma-separated", value: "tags" },
  { name: "n  Note", description: "Free-form note", value: "note" },
  { name: "f  Flag", description: "Mark prunable", value: "flag" },
  { name: "u  Unflag", description: "Clear prune flag", value: "unflag" },
  { name: "x  Remove", description: "Delete (confirm ×2)", value: "remove" },
  {
    name: "p  Prune",
    description: "Dead / expired / 0%",
    value: "prune-dead",
  },
  { name: "R  Reload", description: "Re-read disk pool", value: "reload" },
  { name: "q  Quit", description: "Exit TUI", value: "quit" },
];

function setText(node: TextRenderable, value: string, color?: string): void {
  node.content = stringToStyledText(value);
  if (color) node.fg = parseColor(color);
}

export async function runTui(
  manager: AccountManager = new AccountManager(),
): Promise<void> {
  await manager.load();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: T.bg,
  });

  let selectedIndex = Math.max(0, manager.activeIndex());
  let busy = false;
  let liveBusy = false;
  let removeArmed = false;
  let pruneArmed = false;
  let focusPane: "accounts" | "actions" | "edit" = "accounts";
  let editMode = false;
  let editField: EditField = "label";
  /** Live quota auto-refresh (selected account every 20s; all every 3 ticks). */
  let liveEnabled = true;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let liveTick = 0;
  const LIVE_INTERVAL_MS = 20_000;
  const LIVE_ALL_EVERY = 3;

  const brandText = new TextRenderable(renderer, {
    id: "brand",
    content: stringToStyledText("  op-xai  ·  SuperGrok multi-account"),
    fg: parseColor(T.purple),
    height: 1,
    width: "100%",
  });
  const headerText = new TextRenderable(renderer, {
    id: "header",
    content: stringToStyledText(""),
    fg: parseColor(T.accent),
    height: 1,
    width: "100%",
  });
  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: stringToStyledText(
      "  ↑↓ select  ·  Tab  ·  + add  ·  r/a quota  ·  v live  ·  q quit",
    ),
    fg: parseColor(T.textMuted),
    height: 1,
    width: "100%",
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail",
    content: stringToStyledText(""),
    fg: parseColor(T.textSoft),
    flexGrow: 1,
    width: "100%",
  });

  const editInput = new InputRenderable(renderer, {
    id: "edit-input",
    width: "100%",
    placeholder: "Edit · Enter save · Esc cancel",
    backgroundColor: parseColor(T.surfaceInput),
    focusedBackgroundColor: parseColor(T.surfaceRaised),
    textColor: parseColor(T.text),
    cursorColor: parseColor(T.accent),
    focusedTextColor: parseColor(T.text),
    placeholderColor: parseColor(T.textDim),
    visible: false,
  });

  const accountSelect = new SelectRenderable(renderer, {
    id: "accounts",
    width: "100%",
    height: 8,
    flexGrow: 1,
    options: accountOptions(manager.list(), manager.activeIndex()),
    backgroundColor: parseColor(T.surface),
    textColor: parseColor(T.textSoft),
    focusedBackgroundColor: parseColor(T.surface),
    selectedBackgroundColor: parseColor(T.surfaceRaised),
    selectedTextColor: parseColor(T.accent),
    descriptionColor: parseColor(T.textDim),
    selectedDescriptionColor: parseColor(T.secondary),
    showDescription: true,
    showScrollIndicator: true,
    showSelectionIndicator: true,
    itemSpacing: 0,
  });

  const actionSelect = new SelectRenderable(renderer, {
    id: "actions",
    width: "100%",
    height: 8,
    options: ACTION_OPTIONS,
    backgroundColor: parseColor(T.surface),
    textColor: parseColor(T.textSoft),
    focusedBackgroundColor: parseColor(T.surface),
    selectedBackgroundColor: parseColor(T.surfaceRaised),
    selectedTextColor: parseColor(T.accent),
    descriptionColor: parseColor(T.textDim),
    selectedDescriptionColor: parseColor(T.secondary),
    showDescription: true,
    showScrollIndicator: true,
    showSelectionIndicator: true,
    itemSpacing: 0,
  });

  const left = new BoxRenderable(renderer, {
    id: "left",
    flexDirection: "column",
    width: "40%",
    minWidth: 34,
    borderStyle: "rounded",
    borderColor: parseColor(T.borderFocus),
    focusedBorderColor: parseColor(T.borderFocus),
    backgroundColor: parseColor(T.surface),
    padding: 1,
    gap: 1,
    title: " accounts ",
    titleColor: parseColor(T.accent),
    titleAlignment: "left",
  });

  const actionsLabel = new TextRenderable(renderer, {
    id: "actions-label",
    content: stringToStyledText(" actions "),
    fg: parseColor(T.purple),
    height: 1,
    width: "100%",
  });

  const right = new BoxRenderable(renderer, {
    id: "right",
    flexDirection: "column",
    flexGrow: 1,
    borderStyle: "rounded",
    borderColor: parseColor(T.border),
    focusedBorderColor: parseColor(T.borderFocus),
    backgroundColor: parseColor(T.surface),
    padding: 1,
    title: " detail / quota ",
    titleColor: parseColor(T.purple),
    titleAlignment: "left",
  });

  function paintFocus(): void {
    if (focusPane === "accounts" || focusPane === "actions" || focusPane === "edit") {
      left.borderColor = parseColor(T.borderFocus);
      left.titleColor = parseColor(T.accent);
      right.borderColor = parseColor(T.border);
      right.titleColor = parseColor(T.purple);
    } else {
      left.borderColor = parseColor(T.border);
      right.borderColor = parseColor(T.border);
    }
  }

  function setStatus(msg: string, color: string = T.textMuted): void {
    setText(statusText, `  ${msg}`, color);
  }

  function detailTone(a: AccountMetadata | undefined): string {
    if (!a) return T.textSoft;
    if (a.subscriptionStatus === "dead" || isExpiredPlan(a)) return T.danger;
    if (
      typeof a.billingRemainingPercent === "number" &&
      a.billingRemainingPercent < 15
    ) {
      return T.warn;
    }
    return T.textSoft;
  }

  let refreshing = false;

  function updateDetailOnly(): void {
    const accounts = manager.list();
    const activeIndex = manager.activeIndex();
    if (accounts.length === 0) {
      setText(
        detailText,
        [
          "No SuperGrok accounts yet.",
          "",
          "Add one (OAuth only):",
          "  1. Quit this TUI (q)",
          "  2. opencode auth login",
          "  3. provider: xai-multi",
          "  4. SuperGrok OAuth",
          "  5. op-xai tui  (or press R)",
          "",
          "Or open ACTIONS → + Add",
        ].join("\n"),
        T.textMuted,
      );
      right.bottomTitle = undefined;
      return;
    }
    if (selectedIndex >= accounts.length) {
      selectedIndex = Math.max(0, accounts.length - 1);
    }
    const a = accounts[selectedIndex]!;
    setText(
      detailText,
      accountDetail(
        a,
        selectedIndex,
        selectedIndex === activeIndex,
        Date.now(),
      ),
      detailTone(a),
    );
    const planBit = a.planName
      ? a.planName
      : a.planTier !== undefined
        ? `tier ${a.planTier}`
        : "";
    const crBit =
      typeof a.billingRemainingPercent === "number"
        ? `${Math.round(a.billingRemainingPercent)}% cr`
        : "";
    const bottom = [planBit, crBit].filter(Boolean).join(" · ");
    right.bottomTitle = bottom ? ` ${bottom} ` : undefined;
    right.bottomTitleAlignment = "right";
  }

  function refreshViews(): void {
    if (refreshing) return;
    refreshing = true;
    try {
      const accounts = manager.list();
      const activeIndex = manager.activeIndex();
      if (selectedIndex >= accounts.length) {
        selectedIndex = Math.max(0, accounts.length - 1);
      }
      const liveBadge = liveEnabled
        ? liveBusy
          ? "  ·  live …"
          : "  ·  live on"
        : "  ·  live off";
      setText(
        headerText,
        `  ${poolSummary(accounts, activeIndex)}${liveBadge}`,
        liveEnabled ? T.accent : T.textMuted,
      );
      // Assign options without re-select loop: selectionChanged is ignored while refreshing
      accountSelect.options = accountOptions(accounts, activeIndex);
      if (accounts.length > 0) {
        // Prefer silent index assignment if already correct; setSelectedIndex emits
        // selectionChanged which must not re-enter refreshViews.
        if (accountSelect.getSelectedIndex() !== selectedIndex) {
          accountSelect.setSelectedIndex(selectedIndex);
        }
      }
      updateDetailOnly();
      paintFocus();
    } finally {
      refreshing = false;
    }
  }

  async function probeOne(a: AccountMetadata): Promise<{
    billOk: boolean;
    apiOk: boolean;
    planOk: boolean;
    err?: string;
  }> {
    try {
      const tokens = await manager.ensureFreshToken(a.accountId);
      let billOk = false;
      let apiOk = false;
      let planOk = false;
      const errs: string[] = [];

      // Always stamp JWT tier even if network plan fails.
      try {
        const jwtPlan = planFromAccessToken(tokens.accessToken);
        await manager.recordPlan(a.accountId, {
          planTier: jwtPlan.planTier,
          planName: jwtPlan.planName,
          observedAt: jwtPlan.observedAt,
        });
      } catch {
        // ignore
      }

      try {
        const plan = await fetchGrokPlan(tokens.accessToken);
        await manager.recordPlan(a.accountId, plan);
        planOk = true;
      } catch (err) {
        errs.push(`plan: ${(err as Error).message}`);
      }

      try {
        const bill = await fetchGrokBillingQuota(tokens.accessToken);
        await manager.recordBillingQuota(a.accountId, bill);
        billOk = true;
      } catch (err) {
        errs.push(`billing: ${(err as Error).message}`);
      }

      try {
        const snap = await probeAccountRateLimit(tokens.accessToken);
        await manager.recordRateLimit(a.accountId, snap);
        apiOk = true;
      } catch (err) {
        errs.push(`api: ${(err as Error).message}`);
      }

      if (!billOk && !apiOk && !planOk) {
        return { billOk, apiOk, planOk, err: errs.join("; ") || "probe failed" };
      }
      if (errs.length) {
        return { billOk, apiOk, planOk, err: errs.join("; ") };
      }
      return { billOk, apiOk, planOk };
    } catch (err) {
      return {
        billOk: false,
        apiOk: false,
        planOk: false,
        err: (err as Error).message,
      };
    }
  }

  async function refreshQuotaForSelected(): Promise<void> {
    const accounts = manager.list();
    if (accounts.length === 0) {
      setStatus("No accounts to refresh", T.danger);
      return;
    }
    const a = accounts[selectedIndex]!;
    busy = true;
    setStatus(`Probing ${shortId(a.accountId)}…`, T.warn);
    try {
      const result = await probeOne(a);
      refreshViews();
      if (result.err && !result.billOk && !result.apiOk && !result.planOk) {
        setStatus(`Failed: ${result.err}`, T.danger);
      } else if (result.err) {
        setStatus(`Partial: ${result.err}`, T.warn);
      } else {
        const fresh = manager.list()[selectedIndex];
        const pct = fresh?.billingRemainingPercent;
        setStatus(
          pct !== undefined
            ? `OK  ${shortId(a.accountId)}  ${meterBracket(pct, 12)} ${pct}%`
            : `OK  ${shortId(a.accountId)}`,
          creditColor(pct),
        );
      }
    } finally {
      busy = false;
    }
  }

  async function refreshAllQuotas(): Promise<void> {
    const accounts = manager.list();
    if (accounts.length === 0) {
      setStatus("No accounts", T.danger);
      return;
    }
    busy = true;
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]!;
      setStatus(
        `Probing ${i + 1}/${accounts.length}  ${shortId(a.accountId)}…`,
        T.warn,
      );
      const result = await probeOne(a);
      if (result.billOk || result.apiOk || result.planOk) ok++;
      else fail++;
    }
    busy = false;
    refreshViews();
    setStatus(
      `Probed all  ·  ${ok} ok  ·  ${fail} failed`,
      fail ? T.warn : T.success,
    );
  }

  async function liveTickOnce(): Promise<void> {
    if (!liveEnabled || busy || liveBusy || editMode) return;
    const accounts = manager.list();
    if (accounts.length === 0) return;
    liveBusy = true;
    liveTick += 1;
    try {
      // Always refresh selected for snappy detail pane.
      const selected = accounts[selectedIndex];
      if (selected) {
        await probeOne(selected);
      }
      // Periodically refresh the whole pool so list meters stay current.
      if (liveTick % LIVE_ALL_EVERY === 0) {
        for (const a of manager.list()) {
          if (!liveEnabled || busy) break;
          if (selected && a.accountId === selected.accountId) continue;
          await probeOne(a);
        }
      }
      if (!busy && !editMode) {
        refreshViews();
        const fresh = manager.list()[selectedIndex];
        const pct = fresh?.billingRemainingPercent;
        setStatus(
          pct !== undefined
            ? `live  ${meterBracket(pct, 12)} ${Math.round(pct)}%  ·  ${formatAge(fresh?.billingObservedAt, Date.now())}`
            : `live tick ${liveTick}`,
          creditColor(pct),
        );
      }
    } catch {
      // keep live loop alive on transient failures
    } finally {
      liveBusy = false;
    }
  }

  function stopLive(): void {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  function startLive(): void {
    stopLive();
    if (!liveEnabled) return;
    liveTimer = setInterval(() => {
      void liveTickOnce();
    }, LIVE_INTERVAL_MS);
    // Immediate first probe so UI is not empty for 20s.
    void liveTickOnce();
  }

  function toggleLive(): void {
    liveEnabled = !liveEnabled;
    if (liveEnabled) {
      setStatus("Live quota ON — probing every 20s", T.success);
      startLive();
    } else {
      stopLive();
      liveBusy = false;
      refreshViews();
      setStatus("Live quota OFF — press v or r to probe", T.textMuted);
    }
  }

  async function pruneDeadPlans(): Promise<void> {
    const accounts = manager.list();
    const candidates = accounts.filter(isExpiredPlan);
    if (candidates.length === 0) {
      setStatus(
        "Nothing to prune (no dead / expired / 0% credits)",
        T.textMuted,
      );
      pruneArmed = false;
      return;
    }
    if (!pruneArmed) {
      pruneArmed = true;
      setStatus(
        `Prune ${candidates.length} account(s)?  press p again to confirm`,
        T.danger,
      );
      return;
    }
    busy = true;
    setStatus("Pruning…", T.warn);
    const ids = candidates.map((a) => a.accountId);
    const removed = await manager.pruneAccounts(ids);
    const extra = await manager.pruneAccounts(
      manager.prunableAccounts().map((a) => a.accountId),
    );
    const n = new Set([...removed.removed, ...extra.removed]).size;
    pruneArmed = false;
    busy = false;
    refreshViews();
    setStatus(`Pruned ${n} account(s)`, T.danger);
  }

  function beginFieldEdit(field: EditField): void {
    const accounts = manager.list();
    const a = accounts[selectedIndex];
    if (!a) return;
    editField = field;
    editMode = true;
    focusPane = "edit";
    editInput.visible = true;
    if (field === "label") editInput.value = a.label ?? "";
    else if (field === "tags") editInput.value = a.tags.join(", ");
    else editInput.value = a.note ?? "";
    editInput.placeholder =
      field === "label"
        ? "Label · Enter save · Esc cancel"
        : field === "tags"
          ? "Tags: work, personal · Enter save · Esc cancel"
          : "Note · Enter save · Esc cancel";
    editInput.focus();
    setStatus(`Editing ${field} · ${shortId(a.accountId)}`, T.warn);
  }

  function endFieldEdit(): void {
    editMode = false;
    editInput.visible = false;
    focusPane = "accounts";
    accountSelect.focus();
    paintFocus();
  }

  function showAddAccountHelp(): void {
    setText(
      detailText,
      [
        "ADD SUPERGROK ACCOUNT",
        "",
        "In this TUI (no raw token paste):",
        "  + / Enter on  Add (device)   — recommended",
        "  Enter on  Add (browser)     — opens browser",
        "",
        "Device code flow:",
        "  1. Start Add (device)",
        "  2. Open the verification URL",
        "  3. Enter the user code",
        "  4. Wait until this panel says OK",
        "",
        "Also works outside TUI:",
        "  opencode auth login → xai-multi",
        "  op-xai list",
      ].join("\n"),
      T.info,
    );
    setStatus(
      "Press + for device OAuth, or open ACTIONS → Add (browser)",
      T.accent,
    );
  }

  async function runDeviceAdd(): Promise<void> {
    if (busy) return;
    busy = true;
    removeArmed = false;
    pruneArmed = false;
    setStatus("Starting device OAuth…", T.warn);
    setText(
      detailText,
      [
        "DEVICE CODE LOGIN",
        "",
        "Requesting user code from x.ai…",
        "",
        "Keep this TUI open until login finishes.",
      ].join("\n"),
      T.info,
    );
    try {
      const result = await deviceCodeLoginFlow(manager, (prompt) => {
        const url =
          prompt.verificationUriComplete ?? prompt.verificationUri;
        setText(
          detailText,
          [
            "DEVICE CODE LOGIN",
            "",
            "1. Open this URL in a browser:",
            `   ${prompt.verificationUri}`,
            "",
            "2. Enter this code:",
            `   ${prompt.userCode}`,
            "",
            prompt.verificationUriComplete
              ? `One-click (if available):`
              : "",
            prompt.verificationUriComplete
              ? `   ${prompt.verificationUriComplete}`
              : "",
            "",
            `Expires in ~${prompt.expiresIn}s`,
            "",
            "Waiting for authorization…",
            "(sign in with the SuperGrok account to ADD)",
          ]
            .filter((line) => line !== undefined)
            .join("\n"),
          T.accent,
        );
        setStatus(
          `Device code ${prompt.userCode} — open ${prompt.verificationUri}`,
          T.warn,
        );
        // Best-effort open one-click or base URL
        openInBrowser(url);
      });
      await manager.reloadFromDisk();
      // Select the new/updated account if present
      const list = manager.list();
      const idx = list.findIndex((a) => a.accountId === result.accountId);
      if (idx >= 0) selectedIndex = idx;
      refreshViews();
      const who = result.email ?? result.accountId.slice(0, 12);
      setStatus(
        result.outcome === "added"
          ? `Added account ${who}`
          : `Updated tokens for ${who}`,
        T.success,
      );
    } catch (err) {
      setText(
        detailText,
        [
          "DEVICE CODE LOGIN FAILED",
          "",
          (err as Error).message,
          "",
          "Try again with ACTIONS → Add (device)",
          "or Add (browser).",
        ].join("\n"),
        T.danger,
      );
      setStatus(`Add failed: ${(err as Error).message}`, T.danger);
    } finally {
      busy = false;
    }
  }

  async function runBrowserAdd(): Promise<void> {
    if (busy) return;
    busy = true;
    removeArmed = false;
    pruneArmed = false;
    setStatus("Starting browser OAuth…", T.warn);
    setText(
      detailText,
      [
        "BROWSER LOGIN",
        "",
        "Opening SuperGrok authorize URL…",
        "Waiting for loopback callback on",
        "  http://127.0.0.1:56121/callback",
        "",
        "Complete sign-in in the browser,",
        "then return here.",
      ].join("\n"),
      T.info,
    );
    try {
      const result = await browserLogin(manager, {
        openBrowser: true,
        onAuthorizeUrl: (url) => {
          setText(
            detailText,
            [
              "BROWSER LOGIN",
              "",
              "If the browser did not open, visit:",
              `  ${url}`,
              "",
              "Waiting for callback on",
              "  http://127.0.0.1:56121/callback",
              "",
              "Sign in with the SuperGrok account to ADD.",
            ].join("\n"),
            T.accent,
          );
          setStatus("Browser OAuth — complete login in browser", T.warn);
        },
      });
      await manager.reloadFromDisk();
      const list = manager.list();
      const idx = list.findIndex((a) => a.accountId === result.accountId);
      if (idx >= 0) selectedIndex = idx;
      refreshViews();
      const who = result.email ?? result.accountId.slice(0, 12);
      setStatus(
        result.outcome === "added"
          ? `Added account ${who}`
          : `Updated tokens for ${who}`,
        T.success,
      );
    } catch (err) {
      setText(
        detailText,
        [
          "BROWSER LOGIN FAILED",
          "",
          (err as Error).message,
          "",
          "Port 56121 must be free.",
          "Or use ACTIONS → Add (device) instead.",
        ].join("\n"),
        T.danger,
      );
      setStatus(`Add failed: ${(err as Error).message}`, T.danger);
    } finally {
      busy = false;
    }
  }

  async function runAction(action: ActionId): Promise<void> {
    if (busy && action !== "quit") return;
    if (editMode && action !== "quit") return;
    const accounts = manager.list();
    const a = accounts[selectedIndex];

    switch (action) {
      case "quit":
        stopLive();
        renderer.destroy();
        return;
      case "add":
        showAddAccountHelp();
        return;
      case "add-device":
        await runDeviceAdd();
        return;
      case "add-browser":
        await runBrowserAdd();
        return;
      case "reload": {
        await manager.reloadFromDisk();
        refreshViews();
        setStatus("Reloaded pool from disk", T.success);
        return;
      }
      case "refresh":
        await refreshQuotaForSelected();
        return;
      case "refresh-all":
        await refreshAllQuotas();
        return;
      case "live-toggle":
        toggleLive();
        return;
      case "switch":
        if (!a) return;
        await manager.switchTo(a.accountId);
        refreshViews();
        setStatus(`Active → ${shortId(a.accountId)}`, T.success);
        removeArmed = false;
        pruneArmed = false;
        return;
      case "enable":
        if (!a) return;
        await manager.setEnabled(a.accountId, true);
        refreshViews();
        setStatus(`Enabled ${shortId(a.accountId)}`, T.success);
        removeArmed = false;
        pruneArmed = false;
        return;
      case "disable":
        if (!a) return;
        await manager.setEnabled(a.accountId, false);
        refreshViews();
        setStatus(`Disabled ${shortId(a.accountId)}`, T.warn);
        removeArmed = false;
        pruneArmed = false;
        return;
      case "label":
        beginFieldEdit("label");
        return;
      case "tags":
        beginFieldEdit("tags");
        return;
      case "note":
        beginFieldEdit("note");
        return;
      case "flag":
        if (!a) return;
        await manager.setFlaggedForRemoval(a.accountId, true);
        refreshViews();
        setStatus(`Flagged ${shortId(a.accountId)} for prune`, T.warn);
        return;
      case "unflag":
        if (!a) return;
        await manager.setFlaggedForRemoval(a.accountId, false);
        refreshViews();
        setStatus(`Unflagged ${shortId(a.accountId)}`, T.success);
        return;
      case "remove":
        if (!a) return;
        if (!removeArmed) {
          removeArmed = true;
          setStatus(
            `Confirm delete ${shortId(a.accountId)} — press x again`,
            T.danger,
          );
          return;
        }
        await manager.remove(a.accountId);
        removeArmed = false;
        pruneArmed = false;
        refreshViews();
        setStatus(`Removed ${shortId(a.accountId)}`, T.danger);
        return;
      case "prune-dead":
        await pruneDeadPlans();
        return;
    }
  }

  accountSelect.on(
    SelectRenderableEvents.SELECTION_CHANGED,
    (index: number) => {
      // setSelectedIndex / options assignment emit this — never re-enter refreshViews
      if (refreshing) return;
      if (typeof index === "number" && index >= 0) {
        selectedIndex = index;
        removeArmed = false;
        pruneArmed = false;
        updateDetailOnly();
      }
    },
  );

  actionSelect.on(
    SelectRenderableEvents.ITEM_SELECTED,
    async (_index: number, option: SelectOption) => {
      await runAction(option.value as ActionId);
    },
  );

  editInput.on(InputRenderableEvents.ENTER, async (value: string) => {
    const accounts = manager.list();
    const a = accounts[selectedIndex];
    if (!a) {
      endFieldEdit();
      return;
    }
    const raw = value.trim();
    if (editField === "label") {
      await manager.setLabel(a.accountId, raw.length > 0 ? raw : undefined);
      endFieldEdit();
      refreshViews();
      setStatus(
        raw
          ? `Label → "${raw}" on ${shortId(a.accountId)}`
          : `Cleared label on ${shortId(a.accountId)}`,
        T.success,
      );
      return;
    }
    if (editField === "tags") {
      const tags = raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await manager.setTags(a.accountId, tags);
      endFieldEdit();
      refreshViews();
      setStatus(
        tags.length
          ? `Tags → [${tags.join(", ")}] on ${shortId(a.accountId)}`
          : `Cleared tags on ${shortId(a.accountId)}`,
        T.success,
      );
      return;
    }
    await manager.setNote(a.accountId, raw.length > 0 ? raw : undefined);
    endFieldEdit();
    refreshViews();
    setStatus(
      raw
        ? `Note updated on ${shortId(a.accountId)}`
        : `Cleared note on ${shortId(a.accountId)}`,
      T.success,
    );
  });

  renderer.keyInput.on(
    "keypress",
    async (key: { name?: string; sequence?: string }) => {
      const k = (key.name ?? "").toLowerCase();
      const seq = key.sequence ?? "";

      if (editMode) {
        if (k === "escape") {
          endFieldEdit();
          setStatus("Edit cancelled", T.textMuted);
        }
        return;
      }

      if (k === "q") {
        await runAction("quit");
        return;
      }
      if (seq === "+" || k === "insert") {
        await runAction("add-device");
        return;
      }
      if (k === "r") {
        await runAction("refresh");
        return;
      }
      if (k === "a") {
        await runAction("refresh-all");
        return;
      }
      if (k === "v") {
        await runAction("live-toggle");
        return;
      }
      if (k === "s") {
        await runAction("switch");
        return;
      }
      if (k === "e") {
        await runAction("enable");
        return;
      }
      if (k === "d") {
        await runAction("disable");
        return;
      }
      if (k === "l") {
        await runAction("label");
        return;
      }
      if (k === "t") {
        await runAction("tags");
        return;
      }
      if (k === "n") {
        await runAction("note");
        return;
      }
      if (k === "f") {
        await runAction("flag");
        return;
      }
      if (k === "u") {
        await runAction("unflag");
        return;
      }
      if (k === "x") {
        await runAction("remove");
        return;
      }
      if (k === "p") {
        await runAction("prune-dead");
        return;
      }
      if (k === "tab") {
        if (focusPane === "accounts") {
          focusPane = "actions";
          actionSelect.focus();
        } else {
          focusPane = "accounts";
          accountSelect.focus();
        }
        paintFocus();
      }
    },
  );

  left.add(accountSelect);
  left.add(actionsLabel);
  left.add(actionSelect);
  left.add(editInput);

  right.add(detailText);

  const body = new BoxRenderable(renderer, {
    id: "body",
    flexDirection: "row",
    flexGrow: 1,
    gap: 1,
    width: "100%",
  });
  body.add(left);
  body.add(right);

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: stringToStyledText(
      "  + add · v live · r/a quota · l/t/n edit · e/d · s · x del · p · Tab · q",
    ),
    fg: parseColor(T.textDim),
    height: 1,
    width: "100%",
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
    backgroundColor: parseColor(T.bg),
  });
  root.add(brandText);
  root.add(headerText);
  root.add(statusText);
  root.add(body);
  root.add(footer);

  renderer.root.add(root);
  refreshViews();
  accountSelect.focus();
  paintFocus();
  startLive();
}
