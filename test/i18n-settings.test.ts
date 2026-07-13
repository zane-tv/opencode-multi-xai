import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

describe("i18n locale persistence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-xai-i18n-"));
  const settingsFile = path.join(dir, "multi-xai-settings.json");
  const prevEnv = process.env.MULTI_XAI_LANG;

  beforeEach(() => {
    delete process.env.MULTI_XAI_LANG;
    if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MULTI_XAI_LANG;
    else process.env.MULTI_XAI_LANG = prevEnv;
  });

  it("setLocale writes lang to settings file", async () => {
    // Dynamic import after mocking path via env is hard; test write/read helpers
    // by calling setLocale and reading defaultSettingsPath — use real path with
    // a spy on fs by testing the public API against real home config is invasive.
    // Instead: import module and verify round-trip using setLocale(persist).
    const { setLocale, getLocale, toggleLocale, settingsPath } = await import(
      "../lib/i18n.js"
    );
    const p = settingsPath();
    // backup if exists
    let backup: string | null = null;
    if (fs.existsSync(p)) backup = fs.readFileSync(p, "utf8");
    try {
      setLocale("vi", true);
      expect(getLocale()).toBe("vi");
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { lang?: string };
      expect(raw.lang).toBe("vi");

      setLocale("en", true);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).lang).toBe("en");

      const next = toggleLocale(true);
      expect(next).toBe("vi");
      expect(JSON.parse(fs.readFileSync(p, "utf8")).lang).toBe("vi");
    } finally {
      if (backup !== null) fs.writeFileSync(p, backup);
      else if (fs.existsSync(p)) {
        // leave file as en for cleanliness
        setLocale("en", true);
      }
    }
  });
});
