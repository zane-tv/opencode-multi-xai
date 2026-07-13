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
  formatAge,
  formatDateTime,
  formatPeriodEnd,
  formatUntil,
} from "../format-time.js";
import {
  getLocale,
  localeLabel,
  setLocale,
  t,
  toggleLocale,
} from "../i18n.js";
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
  LoginCancelledError,
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
  | "priority-up"
  | "priority-down"
  | "priority-top"
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
  | "lang"
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
  const prio =
    typeof a.priority === "number" && a.priority !== 0
      ? `p${a.priority}`
      : "";
  const bits = [prio, ...chips].filter(Boolean);
  const extra = bits.length ? `  ${bits.join(" · ")}` : "";
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
      ? formatPeriodEnd(a.planPeriodEndMs)
      : "—";

  const lines: string[] = [
    `${active ? "* ACTIVE" : "  idle"}   #${index}   ${who}`,
    `id     ${shortId(a.accountId)}`,
    `email  ${a.email ?? "—"}`,
    `label  ${a.label ?? "—"}`,
    `tags   ${a.tags.length ? a.tags.map((t) => `#${t}`).join(" ") : "—"}`,
    `state  ${a.enabled ? "enabled" : "disabled"}  ·  sub ${a.subscriptionStatus}`,
    `order  #${index}  priority ${a.priority ?? 0}  ([ ] move · { top)`,
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
      lines.push(`  resets     ${formatUntil(a.billingResetsAt, now)}`);
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
    alerts.push(`exhausted ${formatUntil(a.quotaResetAt, now)}`);
  }
  if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
    alerts.push(
      `cooldown ${a.cooldownReason ?? "?"} ${formatUntil(a.coolingDownUntil, now)}`,
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
    "ops   a add · [ ] priority · s switch · e/d · r · v · x del",
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
        name: t("empty_pool"),
        description: t("empty_hint"),
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

function buildActionOptions(): SelectOption[] {
  return [
    {
      name: t("add_device"),
      description: t("desc_add_device"),
      value: "add-device",
    },
    {
      name: t("add_browser"),
      description: t("desc_add_browser"),
      value: "add-browser",
    },
    {
      name: t("how_to_add"),
      description: t("desc_how_to_add"),
      value: "add",
    },
    {
      name: t("refresh"),
      description: t("desc_refresh"),
      value: "refresh",
    },
    {
      name: t("refresh_all"),
      description: t("desc_refresh_all"),
      value: "refresh-all",
    },
    {
      name: t("live_quota"),
      description: t("desc_live"),
      value: "live-toggle",
    },
    {
      name: t("switch"),
      description: t("desc_switch"),
      value: "switch",
    },
    {
      name: t("prio_up"),
      description: t("desc_prio_up"),
      value: "priority-up",
    },
    {
      name: t("prio_down"),
      description: t("desc_prio_down"),
      value: "priority-down",
    },
    {
      name: t("prio_top"),
      description: t("desc_prio_top"),
      value: "priority-top",
    },
    {
      name: t("enable"),
      description: t("desc_enable"),
      value: "enable",
    },
    {
      name: t("disable"),
      description: t("desc_disable"),
      value: "disable",
    },
    {
      name: t("label"),
      description: t("desc_label"),
      value: "label",
    },
    {
      name: t("tags"),
      description: t("desc_tags"),
      value: "tags",
    },
    {
      name: t("note"),
      description: t("desc_note"),
      value: "note",
    },
    {
      name: t("flag"),
      description: t("desc_flag"),
      value: "flag",
    },
    {
      name: t("unflag"),
      description: t("desc_unflag"),
      value: "unflag",
    },
    {
      name: t("remove"),
      description: t("desc_remove"),
      value: "remove",
    },
    {
      name: t("prune"),
      description: t("desc_prune"),
      value: "prune-dead",
    },
    {
      name: t("reload"),
      description: t("desc_reload"),
      value: "reload",
    },
    {
      name: t("lang"),
      description: t("desc_lang"),
      value: "lang",
    },
    { name: t("quit"), description: t("desc_quit"), value: "quit" },
  ];
}

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
  /** AbortController for in-flight OAuth add (Esc cancels). */
  let addAbort: AbortController | null = null;
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
    content: stringToStyledText(t("brand")),
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
    content: stringToStyledText(t("status_hint")),
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
    options: buildActionOptions(),
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
    title: t("accounts_title"),
    titleColor: parseColor(T.accent),
    titleAlignment: "left",
  });

  const actionsLabel = new TextRenderable(renderer, {
    id: "actions-label",
    content: stringToStyledText(t("actions_title")),
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
    title: t("detail_title"),
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
      setText(detailText, t("no_accounts"), T.textMuted);
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
          ? t("live_busy")
          : t("live_on")
        : t("live_off");
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
        "  a  Add (device)     — recommended",
        "  A  Add (browser)   — opens browser",
        "  Esc                — cancel in-progress add",
        "",
        "Device code flow:",
        "  1. Press a",
        "  2. Open the verification URL",
        "  3. Enter the user code",
        "  4. Wait until this panel says OK",
        "  (Esc cancels while waiting)",
        "",
        "Also works outside TUI:",
        "  opencode auth login → xai-multi",
        "  op-xai list",
      ].join("\n"),
      T.info,
    );
    setStatus(
      "Press a for device OAuth · A for browser · Esc to cancel",
      T.accent,
    );
  }

  function cancelAddAccount(): void {
    if (!addAbort) {
      setStatus("Nothing to cancel", T.textMuted);
      return;
    }
    addAbort.abort();
    setStatus("Cancelling add…", T.warn);
  }

  async function runDeviceAdd(): Promise<void> {
    if (busy) return;
    busy = true;
    removeArmed = false;
    pruneArmed = false;
    addAbort?.abort();
    addAbort = new AbortController();
    const signal = addAbort.signal;
    setStatus("Starting device OAuth… Esc cancel", T.warn);
    setText(
      detailText,
      [
        "DEVICE CODE LOGIN",
        "",
        "Requesting user code from x.ai…",
        "",
        "Press Esc to cancel.",
      ].join("\n"),
      T.info,
    );
    try {
      const result = await deviceCodeLoginFlow(
        manager,
        (prompt) => {
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
                ? "One-click (if available):"
                : "",
              prompt.verificationUriComplete
                ? `   ${prompt.verificationUriComplete}`
                : "",
              "",
              `Expires in ~${prompt.expiresIn}s`,
              "",
              "Waiting for authorization…",
              "(sign in with the SuperGrok account to ADD)",
              "",
              "Press Esc to cancel.",
            ]
              .filter((line) => line !== "")
              .join("\n"),
            T.accent,
          );
          setStatus(
            `Code ${prompt.userCode} · Esc cancel`,
            T.warn,
          );
          openInBrowser(url);
        },
        signal,
      );
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
      if (err instanceof LoginCancelledError || signal.aborted) {
        setText(
          detailText,
          [
            "ADD CANCELLED",
            "",
            "Device OAuth was cancelled.",
            "Press a to try again.",
          ].join("\n"),
          T.textMuted,
        );
        setStatus("Add cancelled", T.textMuted);
      } else {
        setText(
          detailText,
          [
            "DEVICE CODE LOGIN FAILED",
            "",
            (err as Error).message,
            "",
            "Press a to try again, or A for browser.",
          ].join("\n"),
          T.danger,
        );
        setStatus(`Add failed: ${(err as Error).message}`, T.danger);
      }
    } finally {
      addAbort = null;
      busy = false;
    }
  }

  async function runBrowserAdd(): Promise<void> {
    if (busy) return;
    busy = true;
    removeArmed = false;
    pruneArmed = false;
    addAbort?.abort();
    addAbort = new AbortController();
    const signal = addAbort.signal;
    setStatus("Starting browser OAuth… Esc cancel", T.warn);
    setText(
      detailText,
      [
        "BROWSER LOGIN",
        "",
        "Opening SuperGrok authorize URL…",
        "Waiting for loopback callback on",
        "  http://127.0.0.1:56121/callback",
        "",
        "Press Esc to cancel.",
      ].join("\n"),
      T.info,
    );
    try {
      const result = await browserLogin(manager, {
        openBrowser: true,
        signal,
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
              "Press Esc to cancel.",
            ].join("\n"),
            T.accent,
          );
          setStatus("Browser OAuth · Esc cancel", T.warn);
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
      if (err instanceof LoginCancelledError || signal.aborted) {
        setText(
          detailText,
          [
            "ADD CANCELLED",
            "",
            "Browser OAuth was cancelled.",
            "Press a to try device add, or A for browser.",
          ].join("\n"),
          T.textMuted,
        );
        setStatus("Add cancelled", T.textMuted);
      } else {
        setText(
          detailText,
          [
            "BROWSER LOGIN FAILED",
            "",
            (err as Error).message,
            "",
            "Port 56121 must be free.",
            "Or press a for device OAuth.",
          ].join("\n"),
          T.danger,
        );
        setStatus(`Add failed: ${(err as Error).message}`, T.danger);
      }
    } finally {
      addAbort = null;
      busy = false;
    }
  }

  async function runAction(action: ActionId): Promise<void> {
    if (busy && action !== "quit" && action !== "add-device" && action !== "add-browser") {
      // allow quit; block other actions while OAuth add is running
      return;
    }
    if (busy && (action === "add-device" || action === "add-browser")) return;
    if (editMode && action !== "quit") return;
    const accounts = manager.list();
    const a = accounts[selectedIndex];

    switch (action) {
      case "lang": {
        const next = toggleLocale();
        applyLocaleChrome();
        refreshViews();
        setStatus(
          next === "vi"
            ? `Ngôn ngữ: Tiếng Việt · datetime dd/mm/yyyy`
            : `Language: English · datetime 13 Jul 2026`,
          T.accent,
        );
        return;
      }
      case "quit":
        addAbort?.abort();
        addAbort = null;
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
      case "priority-up": {
        if (!a) return;
        const id = a.accountId;
        await manager.movePriority(id, "up");
        const list = manager.list();
        const idx = list.findIndex((x) => x.accountId === id);
        if (idx >= 0) selectedIndex = idx;
        refreshViews();
        setStatus(
          `Priority up → #${idx}  ${shortId(id)}  (p${list[idx!]?.priority ?? 0})`,
          T.success,
        );
        return;
      }
      case "priority-down": {
        if (!a) return;
        const id = a.accountId;
        await manager.movePriority(id, "down");
        const list = manager.list();
        const idx = list.findIndex((x) => x.accountId === id);
        if (idx >= 0) selectedIndex = idx;
        refreshViews();
        setStatus(
          `Priority down → #${idx}  ${shortId(id)}  (p${list[idx!]?.priority ?? 0})`,
          T.success,
        );
        return;
      }
      case "priority-top": {
        if (!a) return;
        const id = a.accountId;
        await manager.moveToFront(id);
        const list = manager.list();
        const idx = list.findIndex((x) => x.accountId === id);
        if (idx >= 0) selectedIndex = idx;
        refreshViews();
        setStatus(
          `Priority top → #${idx}  ${shortId(id)}  (p${list[idx!]?.priority ?? 0})`,
          T.success,
        );
        return;
      }
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
      if (k === "escape") {
        if (addAbort) {
          cancelAddAccount();
          return;
        }
      }
      // a = add device; A = add browser
      if (seq === "A") {
        await runAction("add-browser");
        return;
      }
      if (k === "a" || seq === "a" || seq === "+" || k === "insert") {
        await runAction("add-device");
        return;
      }
      // r = refresh selected; R = refresh all
      if (seq === "R") {
        await runAction("refresh-all");
        return;
      }
      if (k === "r" || seq === "r") {
        await runAction("refresh");
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
      if (k === "g" || seq === "g") {
        await runAction("lang");
        return;
      }
      if (seq === "[" || k === "[") {
        await runAction("priority-up");
        return;
      }
      if (seq === "]" || k === "]") {
        await runAction("priority-down");
        return;
      }
      if (seq === "{" || k === "{") {
        await runAction("priority-top");
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
    content: stringToStyledText(t("footer")),
    fg: parseColor(T.textDim),
    height: 1,
    width: "100%",
  });


  function applyLocaleChrome(): void {
    setText(brandText, t("brand"), T.purple);
    setText(statusText, t("status_hint"), T.textMuted);
    setText(footer, t("footer"), T.textDim);
    left.title = t("accounts_title");
    right.title = t("detail_title");
    setText(actionsLabel, t("actions_title"), T.purple);
    actionSelect.options = buildActionOptions();
  }

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
