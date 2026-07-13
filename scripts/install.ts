/**
 * Provider installer for the multi-account xAI plugin.
 *
 * The plugin registers the `xai-multi` provider at runtime via its auth hook,
 * but OpenCode still needs a matching `provider` entry in the user's global
 * `opencode.json` for the models to show up in the model picker. This script
 * writes that entry idempotently, without clobbering unrelated config.
 *
 * Run standalone:
 *   bun scripts/install.ts                 # writes the provider entry
 *   bun scripts/install.ts --with-plugin-entry
 *                                          # ALSO register the npm plugin in
 *                                          #   the "plugin" array (skip this
 *                                          #   during local dev — the plugin
 *                                          #   loads from the plugins dir then)
 *   bun scripts/install.ts --config /path/to/opencode.json
 *                                          # target a specific config file
 *
 * Or via npm:  npm run install-provider
 *
 * DESIGN NOTES
 * - Idempotent: running twice produces the same file. Re-running never
 *   duplicates the plugin-array entry. New bundled model ids are added while
 *   user edits and overrides of existing ids win.
 * - Defensive: a missing config is treated as an empty config; a present but
 *   MALFORMED config throws a clear error and is NEVER silently overwritten.
 * - xAI may remap requested model names server-side. The ids written here are
 *   requested ids, and the plugin refreshes its runtime catalog from models.dev
 *   plus the authenticated `/v1/models` endpoint when available.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import {
  DEFAULT_MODELS,
  PROVIDER_ID,
  XAI_API_BASE,
} from "../lib/constants.js";

/** npm package name of this plugin (matches package.json "name"). */
export const PLUGIN_PACKAGE = "opencode-multi-xai";

/** The npm adapter the provider config points OpenCode at. */
const PROVIDER_NPM = "@ai-sdk/xai";

/** Human-readable provider name shown in OpenCode. */
const PROVIDER_NAME = "Grok Multi-Account";

/** OpenCode config JSON schema URL, used when creating a config from scratch. */
const CONFIG_SCHEMA = "https://opencode.ai/config.json";

/** Result of an install run, suitable for printing a summary. */
export interface InstallResult {
  /** Absolute path of the config file that was written. */
  configPath: string;
  /** True when the config file did not exist and was created. */
  created: boolean;
  /** True when the `xai-multi` provider entry was newly added. */
  providerAdded: boolean;
  /** True when an existing provider entry had missing fields filled in. */
  providerUpdated: boolean;
  /** True when the plugin package was appended to the `plugin` array. */
  pluginEntryAdded: boolean;
  /** The final, merged config object that was written to disk. */
  config: Record<string, unknown>;
}

/** Options controlling install behavior. */
export interface InstallOptions {
  /**
   * Also register this plugin package in the config's `plugin` array. Only
   * meaningful when the plugin is npm-installed; during local dev the plugin
   * loads from the plugins directory, so leave this off. Default: false.
   */
  withPluginEntry?: boolean;
}

/** Default global OpenCode config path: ~/.config/opencode/opencode.json */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read + JSON-parse the config defensively.
 * - Missing file  -> { config: {}, created: true }
 * - Present file  -> parse; throw a CLEAR error on malformed JSON or a
 *                    non-object top level (never silently overwrite).
 */
async function readConfig(
  configPath: string,
): Promise<{ config: Record<string, unknown>; created: boolean }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, created: true };
    }
    throw err;
  }

  // An empty (or whitespace-only) existing file is treated as an empty config
  // rather than a parse error — it is safe to fill in.
  if (raw.trim().length === 0) {
    return { config: {}, created: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed JSON in ${configPath}: ${
        (err as Error).message
      }. Fix or remove the file, then re-run.`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Refusing to overwrite ${configPath}: expected a JSON object at the top ` +
        `level but found ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }

  return { config: parsed, created: false };
}

/**
 * Merge the `xai-multi` provider entry into `config` in place, without
 * clobbering unrelated keys or other providers. Returns which changes occurred.
 *
 * Idempotency + edit-preservation rules:
 * - `npm` / `name` are set only when absent (user renames are kept).
 * - `options.baseURL` is set only when absent (the whole options object,
 *   including any user-added keys, is preserved).
  * - `models` merges DEFAULT_MODELS under any existing user models: new
  *   default ids are added; user renames/overrides for existing ids win.
  */
function mergeProvider(config: Record<string, unknown>): {
  providerAdded: boolean;
  providerUpdated: boolean;
} {
  if (!isPlainObject(config.provider)) {
    config.provider = {};
  }
  const provider = config.provider as Record<string, unknown>;

  const existing = isPlainObject(provider[PROVIDER_ID])
    ? (provider[PROVIDER_ID] as Record<string, unknown>)
    : undefined;

  const providerAdded = existing === undefined;
  let providerUpdated = false;

  const entry: Record<string, unknown> = { ...(existing ?? {}) };

  if (entry.npm === undefined) {
    entry.npm = PROVIDER_NPM;
    if (!providerAdded) providerUpdated = true;
  }
  if (entry.name === undefined) {
    entry.name = PROVIDER_NAME;
    if (!providerAdded) providerUpdated = true;
  }

  const options = isPlainObject(entry.options)
    ? { ...(entry.options as Record<string, unknown>) }
    : {};
  if (options.baseURL === undefined) {
    options.baseURL = XAI_API_BASE;
    if (!providerAdded) providerUpdated = true;
  }
  entry.options = options;

  // Models: defaults first, then user entries on top (user wins on conflict).
  const prevModels = isPlainObject(entry.models)
    ? (entry.models as Record<string, unknown>)
    : {};
  const nextModels: Record<string, unknown> = {
    ...DEFAULT_MODELS,
    ...prevModels,
  };
  for (const id of Object.keys(DEFAULT_MODELS)) {
    if (!(id in prevModels)) {
      if (!providerAdded) providerUpdated = true;
      break;
    }
  }
  entry.models = nextModels;

  provider[PROVIDER_ID] = entry;
  return { providerAdded, providerUpdated };
}

/**
 * Ensure the plugin package appears exactly once in the config's `plugin`
 * array. Creates the array if absent. Returns true when an entry was appended.
 */
function mergePluginEntry(config: Record<string, unknown>): boolean {
  const current = config.plugin;
  const list = Array.isArray(current) ? [...current] : [];

  if (list.includes(PLUGIN_PACKAGE)) {
    config.plugin = list;
    return false;
  }

  list.push(PLUGIN_PACKAGE);
  config.plugin = list;
  return true;
}

/**
 * Write the merged provider config into an opencode.json.
 *
 * @param configPath Path to the config file. Defaults to the global config
 *   (`~/.config/opencode/opencode.json`). Injectable for tests.
 * @param options    See {@link InstallOptions}.
 */
export async function installProvider(
  configPath: string = defaultConfigPath(),
  options: InstallOptions = {},
): Promise<InstallResult> {
  const resolved = path.resolve(configPath);
  const { config, created } = await readConfig(resolved);

  // Base scaffolding: ensure the schema is present (helps editors + validates).
  if (created && config.$schema === undefined) {
    config.$schema = CONFIG_SCHEMA;
  }

  const { providerAdded, providerUpdated } = mergeProvider(config);

  const pluginEntryAdded = options.withPluginEntry
    ? mergePluginEntry(config)
    : false;

  // Pretty-print (2-space) with a trailing newline, matching repo convention.
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, body, "utf8");

  return {
    configPath: resolved,
    created,
    providerAdded,
    providerUpdated,
    pluginEntryAdded,
    config,
  };
}

/** Print a clear, human-readable summary of what the install did. */
function printSummary(result: InstallResult): void {
  const {
    configPath,
    created,
    providerAdded,
    providerUpdated,
    pluginEntryAdded,
  } = result;

  console.log("multi-xai provider installer");
  console.log("─".repeat(56));
  console.log(`config: ${configPath}`);
  console.log(created ? "  created a new config file" : "  updated existing config");

  if (providerAdded) {
    console.log(`  + added provider "${PROVIDER_ID}" (${PROVIDER_NAME})`);
    console.log(`      npm:     ${PROVIDER_NPM}`);
    console.log(`      baseURL: ${XAI_API_BASE}`);
    console.log(
      `      models:  ${Object.keys(DEFAULT_MODELS).join(", ")}`,
    );
  } else if (providerUpdated) {
    console.log(
      `  ~ provider "${PROVIDER_ID}" already present; filled in missing fields`,
    );
  } else {
    console.log(
      `  = provider "${PROVIDER_ID}" already configured (no changes needed)`,
    );
  }

  if (pluginEntryAdded) {
    console.log(`  + registered plugin "${PLUGIN_PACKAGE}" in the plugin array`);
  }

  console.log("─".repeat(56));
  console.log(
    "Done. Restart OpenCode and pick a SuperGrok OAuth method via " +
      "`opencode auth login` to add accounts.",
  );
}

/** Parse CLI flags: --with-plugin-entry and --config <path>. */
function parseArgs(argv: string[]): {
  configPath?: string;
  withPluginEntry: boolean;
} {
  let configPath: string | undefined;
  let withPluginEntry = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--with-plugin-entry") {
      withPluginEntry = true;
    } else if (arg === "--config") {
      configPath = argv[++i];
      if (configPath === undefined) {
        throw new Error("--config requires a path argument");
      }
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }

  return { configPath, withPluginEntry };
}

async function main(): Promise<void> {
  const { configPath, withPluginEntry } = parseArgs(process.argv.slice(2));
  const result = await installProvider(configPath, { withPluginEntry });
  printSummary(result);
}

// Only run the CLI when executed directly (not when imported by a test).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain = invokedPath === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`install failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
