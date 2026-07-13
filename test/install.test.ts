import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installProvider,
  PLUGIN_PACKAGE,
} from "../scripts/install.js";
import { PROVIDER_ID, XAI_API_BASE } from "../lib/constants.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "multi-xai-install-"));
  configPath = path.join(dir, "opencode.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(p: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(p, "utf8"));
}

describe("installProvider — creates from absent", () => {
  it("creates a config file with the schema + provider entry", async () => {
    const result = await installProvider(configPath);

    expect(result.created).toBe(true);
    expect(result.providerAdded).toBe(true);
    expect(result.providerUpdated).toBe(false);
    expect(result.pluginEntryAdded).toBe(false);

    const config = await readJson(configPath);
    expect(config.$schema).toBe("https://opencode.ai/config.json");

    const entry = config.provider[PROVIDER_ID];
    expect(entry.npm).toBe("@ai-sdk/xai");
    expect(entry.name).toBe("Grok Multi-Account");
    expect(entry.options.baseURL).toBe(XAI_API_BASE);
    expect(entry.models["grok-4.5"]?.name).toBe("Grok 4.5");
    expect(entry.models["grok-4.3"]?.name).toBe("Grok 4.3");
    expect(entry.models["grok-build-0.1"]?.name).toBe("Grok Build 0.1");
  });

  it("creates missing parent directories", async () => {
    const nested = path.join(dir, "a", "b", "opencode.json");
    const result = await installProvider(nested);
    expect(result.created).toBe(true);
    await expect(readJson(nested)).resolves.toBeTruthy();
  });

  it("pretty-prints with 2-space indent and a trailing newline", async () => {
    await installProvider(configPath);
    const raw = await readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "provider": {');
  });
});

describe("installProvider — merges without clobbering", () => {
  it("preserves unrelated keys and other providers", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "gruvbox",
        model: "anthropic/claude-3",
        provider: {
          anthropic: { options: { apiKey: "sk-existing" } },
        },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.created).toBe(false);
    expect(result.providerAdded).toBe(true);

    const config = await readJson(configPath);
    // Unrelated top-level keys survive.
    expect(config.theme).toBe("gruvbox");
    expect(config.model).toBe("anthropic/claude-3");
    // The other provider is untouched.
    expect(config.provider.anthropic.options.apiKey).toBe("sk-existing");
    // Our provider was added alongside it.
    expect(config.provider[PROVIDER_ID].options.baseURL).toBe(XAI_API_BASE);
  });

  it("merges new default models under user edits (user overrides win)", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "My Custom Grok Name",
            options: { baseURL: XAI_API_BASE, extra: "keep-me" },
            models: {
              "grok-4.5": { name: "Grok 4.5 Custom" },
              "grok-2": { name: "Grok 2" },
            },
          },
        },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.providerAdded).toBe(false);
    // New default model ids were missing → providerUpdated.
    expect(result.providerUpdated).toBe(true);

    const entry = (await readJson(configPath)).provider[PROVIDER_ID];
    // User's custom name, extra option, and edited/added models all survive.
    expect(entry.name).toBe("My Custom Grok Name");
    expect(entry.options.extra).toBe("keep-me");
    // User override for grok-4.5 wins; user-added grok-2 kept; other defaults filled in.
    expect(entry.models["grok-4.5"]).toEqual({ name: "Grok 4.5 Custom" });
    expect(entry.models["grok-2"]).toEqual({ name: "Grok 2" });
    expect(entry.models["grok-4.3"]?.name).toBe("Grok 4.3");
  });

  it("fills in only missing fields on a partial provider entry", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        provider: { [PROVIDER_ID]: { name: "Kept Name" } },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.providerAdded).toBe(false);
    expect(result.providerUpdated).toBe(true);

    const entry = (await readJson(configPath)).provider[PROVIDER_ID];
    expect(entry.name).toBe("Kept Name"); // kept
    expect(entry.npm).toBe("@ai-sdk/xai"); // filled
    expect(entry.options.baseURL).toBe(XAI_API_BASE); // filled
    expect(entry.models).toBeTruthy(); // seeded
  });
});

describe("installProvider — idempotent on rerun", () => {
  it("produces byte-identical output on a second run", async () => {
    await installProvider(configPath);
    const first = await readFile(configPath, "utf8");

    const result = await installProvider(configPath);
    const second = await readFile(configPath, "utf8");

    expect(second).toBe(first);
    expect(result.providerAdded).toBe(false);
    expect(result.providerUpdated).toBe(false);
    expect(result.created).toBe(false);
  });

  it("never duplicates the plugin array entry", async () => {
    await installProvider(configPath, { withPluginEntry: true });
    const r2 = await installProvider(configPath, { withPluginEntry: true });
    const r3 = await installProvider(configPath, { withPluginEntry: true });

    expect(r2.pluginEntryAdded).toBe(false);
    expect(r3.pluginEntryAdded).toBe(false);

    const config = await readJson(configPath);
    expect(config.plugin).toEqual([PLUGIN_PACKAGE]);
  });

  it("appends the plugin entry only with --with-plugin-entry", async () => {
    const without = await installProvider(configPath);
    expect(without.pluginEntryAdded).toBe(false);
    expect((await readJson(configPath)).plugin).toBeUndefined();

    const withEntry = await installProvider(configPath, {
      withPluginEntry: true,
    });
    expect(withEntry.pluginEntryAdded).toBe(true);
    expect((await readJson(configPath)).plugin).toEqual([PLUGIN_PACKAGE]);
  });

  it("preserves other existing plugin array entries", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ plugin: ["some-other-plugin"] }),
      "utf8",
    );

    await installProvider(configPath, { withPluginEntry: true });
    const config = await readJson(configPath);
    expect(config.plugin).toEqual(["some-other-plugin", PLUGIN_PACKAGE]);
  });
});

describe("installProvider — throws on malformed JSON", () => {
  it("throws a clear error and never overwrites malformed JSON", async () => {
    const malformed = '{ "provider": { broken';
    await writeFile(configPath, malformed, "utf8");

    await expect(installProvider(configPath)).rejects.toThrow(
      /malformed JSON/i,
    );

    // The broken file is left exactly as-is (never silently overwritten).
    expect(await readFile(configPath, "utf8")).toBe(malformed);
  });

  it("throws when the top level is not a JSON object", async () => {
    await writeFile(configPath, JSON.stringify(["array", "config"]), "utf8");
    await expect(installProvider(configPath)).rejects.toThrow(
      /expected a JSON object/i,
    );
  });

  it("treats an empty existing file as an empty config (not malformed)", async () => {
    await writeFile(configPath, "   \n", "utf8");
    const result = await installProvider(configPath);
    expect(result.created).toBe(false);
    expect(result.providerAdded).toBe(true);
    expect((await readJson(configPath)).provider[PROVIDER_ID]).toBeTruthy();
  });
});
