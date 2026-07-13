/**
 * Leveled logger → stderr with `[multi-xai]` prefix.
 * Quiet by default: only warn/error unless MULTI_XAI_DEBUG is truthy.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PREFIX = "[multi-xai]";

function debugEnabled(): boolean {
  const v = process.env.MULTI_XAI_DEBUG;
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

function threshold(): number {
  // Default: warn+ only. MULTI_XAI_DEBUG unlocks debug+info.
  return debugEnabled() ? LEVEL_ORDER.debug : LEVEL_ORDER.warn;
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  const tag = `${PREFIX} ${level.toUpperCase()}`;
  process.stderr.write(`${tag} ${args.map(stringify).join(" ")}\n`);
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};

export type Logger = typeof logger;
