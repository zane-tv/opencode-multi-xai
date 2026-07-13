#!/usr/bin/env bun
/**
 * Standalone CLI for multi-xai account tools (no OpenCode agent / no model tokens).
 *
 * Usage:
 *   op-xai list
 *   op-xai help
 *   op-xai limits --probe
 *   bun scripts/cli.ts list
 *
 * Note: `opencode xai-add` does NOT work — OpenCode treats the arg as a project path.
 */

import { AccountManager } from "../lib/accounts.js";
import { buildTools } from "../lib/tools/registry.js";
import type { ToolContext } from "@opencode-ai/plugin";

const COMMANDS = [
  "help",
  "tui",
  "status",
  "list",
  "add",
  "limits",
  "quota",
  "health",
  "switch",
  "remove",
  "enable",
  "disable",
  "label",
  "tag",
  "note",
  "refresh",
  "flag",
  "unflag",
  "priority",
  "prune",
] as const;

type Command = (typeof COMMANDS)[number];

function usage(): string {
  return [
    "op-xai — SuperGrok multi-account CLI for OpenCode",
    "",
    "Usage:",
    "  op-xai <command> [options]",
    "  bun scripts/cli.ts <command> [options]",
    "",
    "Commands:",
    "  help                    Show this help",
    "  tui [--lang vi|en]      OpenTUI account + quota manager",
    "  status                  Compact pool status",
    "  list [--tag NAME]       List accounts",
    "  add [--browser]        Add account via SuperGrok OAuth (device default)",
    "  limits|quota [--probe]  SuperGrok credits % + API remaining",
    "  health                  Validate refresh tokens for all accounts",
    "  switch --index N | --id PREFIX",
    "  remove --index N --confirm",
    "  enable|disable --index N | --id PREFIX",
    "  label --index N --label TEXT",
    "  tag --index N --tags a,b,c",
    "  note --index N --note TEXT",
    "  refresh --index N | --id PREFIX",
    "  flag|unflag --index N | --id PREFIX",
    "  priority --index N --direction up|down|top",
    "  priority --index N --priority N   (absolute)",
    "  prune [--tag NAME] [--execute]   (dry-run unless --execute)",
    "",
    "Language: MULTI_XAI_LANG=en|vi  or  op-xai tui --lang vi  (default: en)",
    "  In TUI press g to toggle language.",
    "",
    "Examples:",
    "  op-xai tui",
    "  op-xai tui --lang en",
    "  op-xai list",
    "  op-xai limits --probe",
    "  op-xai switch --index 0",
    "  op-xai remove --index 1 --confirm",
    "",
    "Add account:",
    "  opencode auth login   # pick xai-multi → SuperGrok OAuth",
    "",
    "Note: do not run `opencode xai-add` — OpenCode treats that as a project path.",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  return String(v);
}

function toolCtx(): ToolContext {
  return {
    sessionID: "cli",
    messageID: "cli",
    agent: "cli",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function toolName(command: Command): string {
  if (command === "quota") return "xai-limits";
  return `xai-${command}`;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  if (command === "tui") {
    const lang = strFlag(flags, "lang");
    if (lang === "en" || lang === "vi") {
      const { setLocale } = await import("../lib/i18n.js");
      setLocale(lang);
    }
    const { runTui } = await import("../lib/tui/app.js");
    await runTui();
    return;
  }

  if (command === "add") {
    const { AccountManager } = await import("../lib/accounts.js");
    const {
      browserLogin,
      deviceCodeLoginFlow,
    } = await import("../lib/auth/login.js");
    const manager = new AccountManager();
    await manager.load();
    const useBrowser = flags.browser === true || flags.browser === "true";
    try {
      if (useBrowser) {
        console.log("Starting browser OAuth (loopback http://127.0.0.1:56121/callback)…");
        const result = await browserLogin(manager, {
          onAuthorizeUrl: (url) => {
            console.log(`Open: ${url}`);
          },
        });
        console.log(
          result.outcome === "added"
            ? `Added account ${result.email ?? result.accountId}`
            : `Updated account ${result.email ?? result.accountId}`,
        );
      } else {
        console.log("Starting device OAuth…");
        const result = await deviceCodeLoginFlow(manager, (prompt) => {
          console.log("");
          console.log(`Open: ${prompt.verificationUri}`);
          console.log(`Code: ${prompt.userCode}`);
          if (prompt.verificationUriComplete) {
            console.log(`One-click: ${prompt.verificationUriComplete}`);
          }
          console.log(`Expires in ~${prompt.expiresIn}s`);
          console.log("Waiting for authorization…");
        });
        console.log(
          result.outcome === "added"
            ? `Added account ${result.email ?? result.accountId}`
            : `Updated account ${result.email ?? result.accountId}`,
        );
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }

  if (!(COMMANDS as readonly string[]).includes(command) || command === "help") {
    console.error(`Unknown command: ${command}\n`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const manager = new AccountManager();
  await manager.load();
  const tools = buildTools(manager);
  const name = toolName(command as Command);
  const tool = tools[name];
  if (!tool) {
    console.error(`Tool not registered: ${name}`);
    process.exitCode = 1;
    return;
  }

  const args: Record<string, unknown> = {};
  const index = numFlag(flags, "index");
  const id = strFlag(flags, "id");
  if (index !== undefined) args.index = index;
  if (id !== undefined) args.id = id;

  if (command === "list") {
    const tag = strFlag(flags, "tag");
    if (tag) args.tag = tag;
  }
  if (command === "limits" || command === "quota") {
    if (flags.probe === true || flags.probe === "true") args.probe = true;
  }
  if (command === "remove") {
    args.confirm = flags.confirm === true || flags.confirm === "true";
  }
  if (command === "label") {
    args.label = strFlag(flags, "label") ?? "";
  }
  if (command === "tag") {
    args.tags = strFlag(flags, "tags") ?? "";
  }
  if (command === "note") {
    args.note = strFlag(flags, "note") ?? "";
  }
  if (command === "priority") {
    const direction = strFlag(flags, "direction");
    if (direction) args.direction = direction;
    const pr = numFlag(flags, "priority");
    if (pr !== undefined) args.priority = pr;
  }
  if (command === "prune") {
    // CLI: dry-run by default; --execute actually deletes
    args.dryRun = flags.execute !== true && flags.execute !== "true";
    const tag = strFlag(flags, "tag");
    if (tag) args.tag = tag;
  }

  try {
    const out = await tool.execute(args, toolCtx());
    console.log(out);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

main();
