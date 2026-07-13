/**
 * Lightweight locale for op-xai CLI/TUI.
 * Default: English (en).
 *
 * Load order: MULTI_XAI_LANG env > multi-xai-settings.json > en
 * TUI `g` / setLocale / toggleLocale persist to settings file.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultSettingsPath } from "./constants.js";

export type Locale = "vi" | "en";

type SettingsFile = {
  lang?: string;
};

let current: Locale = "en";
let loaded = false;

function normalizeLocale(raw: string | undefined | null): Locale | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "vi" || v.startsWith("vi") || v.includes("vn")) return "vi";
  if (v === "en" || v.startsWith("en")) return "en";
  return null;
}

function readSettingsFile(): SettingsFile {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    return data as SettingsFile;
  } catch {
    return {};
  }
}

function writeSettingsFile(patch: SettingsFile): void {
  try {
    const p = defaultSettingsPath();
    const dir = p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
    fs.mkdirSync(dir, { recursive: true });
    const prev = readSettingsFile();
    const next = { ...prev, ...patch };
    fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // non-fatal
  }
}

export function ensureLocaleLoaded(): Locale {
  if (loaded) return current;
  loaded = true;

  const fromEnv = normalizeLocale(process.env.MULTI_XAI_LANG);
  if (fromEnv) {
    current = fromEnv;
    return current;
  }

  const fromFile = normalizeLocale(readSettingsFile().lang);
  if (fromFile) {
    current = fromFile;
    return current;
  }

  current = "en";
  return current;
}

ensureLocaleLoaded();

export function getLocale(): Locale {
  ensureLocaleLoaded();
  return current;
}

export function setLocale(locale: Locale, persist = true): void {
  loaded = true;
  current = locale === "en" ? "en" : "vi";
  if (persist) writeSettingsFile({ lang: current });
}

export function toggleLocale(persist = true): Locale {
  ensureLocaleLoaded();
  current = current === "vi" ? "en" : "vi";
  if (persist) writeSettingsFile({ lang: current });
  return current;
}

type Dict = Record<string, string>;

const en: Dict = {
  never: "never",
  just_now: "just now",
  now: "now",
  empty: "—",
  ago_s: "{n}s ago",
  ago_m: "{n}m ago",
  ago_h: "{n}h ago",
  ago_d: "{n}d ago",
  in_s: "in {n}s",
  in_m: "in {n}m",
  in_h: "in {n}h",
  in_d: "in {n}d",
  brand: "  op-xai  ·  SuperGrok multi-account",
  status_hint:
    "  ↑↓/mouse select  ·  Tab panes  ·  live refreshes ALL accounts every ~20s",
  footer:
    "  a/A add  [ ]/{ priority  s switch  e/d on/off  r/R quota  v live(all)  l/t/n edit\n  f/u flag  x del  p prune  L reload  g lang  Esc cancel  Tab  q quit",
  live_on: "  ·  live on",
  live_off: "  ·  live off",
  live_busy: "  ·  live …",
  accounts_title: " accounts ",
  actions_title: " actions ",
  detail_title: " detail / quota ",
  empty_pool: "  empty pool",
  empty_hint: "opencode auth login → xai-multi → SuperGrok OAuth",
  no_accounts:
    "No SuperGrok accounts yet.\n\nAdd one (OAuth only):\n  1. Press a (device code)\n  2. Or A (browser)\n  3. Esc cancels while waiting",
  lang_switched: "Language: English",
  add_device: "a  Add (device)",
  add_browser: "A  Add (browser)",
  how_to_add: "?  How to add",
  refresh: "r  Refresh",
  refresh_all: "R  Refresh all",
  live_quota: "v  Live quota",
  switch: "s  Switch",
  prio_up: "[  Priority up",
  prio_down: "]  Priority down",
  prio_top: "{  Priority top",
  enable: "e  Enable",
  disable: "d  Disable",
  label: "l  Label",
  tags: "t  Tags",
  note: "n  Note",
  flag: "f  Flag",
  unflag: "u  Unflag",
  remove: "x  Remove",
  prune: "p  Prune",
  reload: "L  Reload",
  quit: "q  Quit",
  lang: "g  Language",
  desc_add_device: "OAuth device · Esc cancel",
  desc_add_browser: "OAuth browser · Esc cancel",
  desc_how_to_add: "Show OAuth steps",
  desc_refresh: "Quota for selected",
  desc_refresh_all: "Probe every account",
  desc_live: "Auto-refresh ALL accounts ~20s",
  desc_switch: "Set sticky active",
  desc_prio_up: "Prefer earlier in list",
  desc_prio_down: "Prefer later in list",
  desc_prio_top: "Move to front of queue",
  desc_enable: "Include in rotation",
  desc_disable: "Skip selection",
  desc_label: "Display name",
  desc_tags: "Comma-separated",
  desc_note: "Free-form note",
  desc_flag: "Mark prunable",
  desc_unflag: "Clear prune flag",
  desc_remove: "Delete (confirm ×2)",
  desc_prune: "Dead / expired / 0%",
  desc_reload: "Re-read disk pool",
  desc_quit: "Exit TUI",
  desc_lang: "Toggle vi / en (saved)",
};

const vi: Dict = {
  never: "chưa có",
  just_now: "vừa xong",
  now: "bây giờ",
  empty: "—",
  ago_s: "{n} giây trước",
  ago_m: "{n} phút trước",
  ago_h: "{n} giờ trước",
  ago_d: "{n} ngày trước",
  in_s: "sau {n} giây",
  in_m: "sau {n} phút",
  in_h: "sau {n} giờ",
  in_d: "sau {n} ngày",
  brand: "  op-xai  ·  Quản lý SuperGrok đa tài khoản",
  status_hint:
    "  ↑↓/chuột chọn  ·  Tab panel  ·  live làm mới TẤT CẢ acc ~20s",
  footer:
    "  a/A thêm  [ ]/{ ưu tiên  s switch  e/d bật/tắt  r/R quota  v live(all)  l/t/n sửa\n  f/u cờ  x xoá  p dọn  L tải lại  g ngôn ngữ  Esc huỷ  Tab  q thoát",
  live_on: "  ·  live bật",
  live_off: "  ·  live tắt",
  live_busy: "  ·  live …",
  accounts_title: " tài khoản ",
  actions_title: " thao tác ",
  detail_title: " chi tiết / hạn mức ",
  empty_pool: "  chưa có tài khoản",
  empty_hint: "opencode auth login → xai-multi → SuperGrok OAuth",
  no_accounts:
    "Chưa có tài khoản SuperGrok.\n\nThêm (chỉ OAuth):\n  1. Nhấn a (mã thiết bị)\n  2. Hoặc A (trình duyệt)\n  3. Esc để huỷ khi đang chờ",
  lang_switched: "Ngôn ngữ: Tiếng Việt",
  add_device: "a  Thêm (mã thiết bị)",
  add_browser: "A  Thêm (trình duyệt)",
  how_to_add: "?  Hướng dẫn thêm",
  refresh: "r  Làm mới",
  refresh_all: "R  Làm mới tất cả",
  live_quota: "v  Live hạn mức",
  switch: "s  Chuyển active",
  prio_up: "[  Ưu tiên lên",
  prio_down: "]  Ưu tiên xuống",
  prio_top: "{  Ưu tiên đầu",
  enable: "e  Bật",
  disable: "d  Tắt",
  label: "l  Nhãn",
  tags: "t  Thẻ",
  note: "n  Ghi chú",
  flag: "f  Đánh dấu xoá",
  unflag: "u  Bỏ đánh dấu",
  remove: "x  Xoá",
  prune: "p  Dọn dead",
  reload: "L  Tải lại",
  quit: "q  Thoát",
  lang: "g  Ngôn ngữ",
  desc_add_device: "OAuth mã thiết bị · Esc huỷ",
  desc_add_browser: "OAuth trình duyệt · Esc huỷ",
  desc_how_to_add: "Hiện các bước OAuth",
  desc_refresh: "Hạn mức tài khoản chọn",
  desc_refresh_all: "Probe mọi tài khoản",
  desc_live: "Tự làm mới TẤT CẢ acc ~20s",
  desc_switch: "Đặt sticky active",
  desc_prio_up: "Ưu tiên sớm hơn trong list",
  desc_prio_down: "Ưu tiên muộn hơn",
  desc_prio_top: "Đưa lên đầu hàng đợi",
  desc_enable: "Cho vào rotation",
  desc_disable: "Bỏ khỏi selection",
  desc_label: "Tên hiển thị",
  desc_tags: "Phân tách bằng dấu phẩy",
  desc_note: "Ghi chú tự do",
  desc_flag: "Đánh dấu dọn",
  desc_unflag: "Bỏ cờ dọn",
  desc_remove: "Xoá (xác nhận ×2)",
  desc_prune: "Dead / hết hạn / 0%",
  desc_reload: "Đọc lại pool từ disk",
  desc_quit: "Thoát TUI",
  desc_lang: "Đổi vi / en (đã lưu)",
};

const catalogs: Record<Locale, Dict> = { en, vi };

export function t(key: string, vars?: Record<string, string | number>): string {
  ensureLocaleLoaded();
  const dict = catalogs[current] ?? en;
  let s = dict[key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function localeLabel(locale: Locale = getLocale()): string {
  return locale === "vi" ? "Tiếng Việt" : "English";
}

export function settingsPath(): string {
  return defaultSettingsPath();
}
