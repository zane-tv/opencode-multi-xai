import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// Mock ONLY the network grant (refreshTokens); keep the rest of oauth intact.
// Seeded accounts carry non-expired access tokens so ensureFreshToken takes the
// fast path and never actually calls this — but mock it so an accidental
// refresh fails loudly rather than hitting the network.
const { refreshTokensMock } = vi.hoisted(() => ({
  refreshTokensMock: vi.fn(),
}));

vi.mock("../lib/auth/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth/oauth.js")>();
  return { ...actual, refreshTokens: refreshTokensMock };
});

import { AccountManager } from "../lib/accounts.js";
import { resetRefreshState } from "../lib/auth/refresh.js";
import { createCustomFetch } from "../lib/request/fetch.js";
import { saveAccounts } from "../lib/storage.js";
import { XAI_API_BASE } from "../lib/constants.js";
import type { AccountMetadata, AccountStorage } from "../lib/schemas.js";

const HOUR = 3_600_000;
const ENDPOINT = `${XAI_API_BASE}/chat/completions`;

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-xai-fetch-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  id: string,
  overrides: Partial<AccountMetadata> = {},
): AccountMetadata {
  return {
    accountId: id,
    tags: [],
    refreshToken: `rt-${id}`,
    // Non-expired access token → ensureFreshToken fast path (no network).
    accessToken: `at-${id}`,
    expiresAt: Date.now() + HOUR,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
}

async function writeStore(
  storePath: string,
  accounts: AccountMetadata[],
  activeIndex = 0,
): Promise<void> {
  const storage: AccountStorage = { version: 1, accounts, activeIndex };
  await saveAccounts(storage, storePath);
}

/** The init shape of the runtime `fetch`, without relying on DOM libs. */
type FetchInit = Parameters<typeof fetch>[1];

/** Bearer sent on a captured fetch call. */
function bearerOf(init: FetchInit): string | undefined {
  const h = new Headers(init?.headers);
  return h.get("authorization") ?? undefined;
}

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

let storePath: string;
let fetchSpy: MockInstance<FetchFn>;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  storePath = tmpStorePath();
  refreshTokensMock.mockReset();
  resetRefreshState();
  // Replace the global fetch that customFetch calls out to.
  realFetch = globalThis.fetch;
  fetchSpy = vi.fn<FetchFn>();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(base))
      .map((e) => fs.rm(path.join(dir, e), { force: true }).catch(() => {})),
  );
});

async function managerWith(
  accounts: AccountMetadata[],
  activeIndex = 0,
): Promise<AccountManager> {
  await writeStore(storePath, accounts, activeIndex);
  const mgr = new AccountManager(storePath);
  await mgr.load();
  return mgr;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("customFetch rotation pipeline", () => {
  it("quota-exhausted → marks account + rotates to next, then succeeds", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    fetchSpy
      // a0 → quota-exhausted
      .mockResolvedValueOnce(
        jsonResponse(403, { error: "you have run out of credits" }),
      )
      // a1 → ok
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);

    // First bearer was a0, second was a1 (rotated).
    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe("Bearer at-a0");
    expect(bearerOf(fetchSpy.mock.calls[1][1])).toBe("Bearer at-a1");

    // a0 is now quota-exhausted with a future reset.
    expect(mgr.get("a0")?.quotaResetAt).toBeGreaterThan(Date.now());
    // a1 was touched on success.
    expect(mgr.get("a1")?.lastUsed).toBeGreaterThan(0);
  });

  it("entitlement-blocked → marks account + rotates, skips it", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(403, {
          error: "your account does not have permission to use this API",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);
    expect(mgr.get("a0")?.entitlementBlocked).toBe(true);
    // Selection now skips a0 entirely.
    expect(mgr.selectAccount(new Set())?.accountId).toBe("a1");
  });

  it("transient → one backoff+retry on the SAME account, then success", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    fetchSpy
      // a0 → 429 transient
      .mockResolvedValueOnce(
        jsonResponse(429, { error: "rate limit exceeded" }),
      )
      // a0 retry → ok
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);

    // Called twice, BOTH against a0 (same bearer) — the retry did not rotate.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe("Bearer at-a0");
    expect(bearerOf(fetchSpy.mock.calls[1][1])).toBe("Bearer at-a0");
    // a0 was not marked quota/entitlement/cooldown.
    expect(mgr.get("a0")?.quotaResetAt).toBeUndefined();
    expect(mgr.get("a0")?.coolingDownUntil).toBeUndefined();
  });

  it("unknown-client-error → returns immediately, NO rotation", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    // A 400 param error (not auth/quota/entitlement).
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(400, { error: "max_tokens is invalid" }),
    );

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(400);
    // Body returned as-is.
    await expect(res.clone().json()).resolves.toMatchObject({
      error: "max_tokens is invalid",
    });
    // Exactly ONE outward attempt — no rotation to a1.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe("Bearer at-a0");
    // No account state mutated.
    expect(mgr.get("a0")?.quotaResetAt).toBeUndefined();
    expect(mgr.get("a1")?.lastUsed).toBe(0);
  });

  it("all-exhausted → 503 with earliest-reset info", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    // Both accounts quota-exhausted (403 credits) with a retry hint.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "run out of credits" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "120" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "run out of credits" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "60" },
        }),
      );

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/All 2 xAI accounts exhausted/);
    // Earliest reset is the smaller (~60s) window.
    expect(res.headers.get("retry-after")).toBeTruthy();
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);

    // Both accounts attempted exactly once.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("host-pin: a request to a non-api.x.ai host throws (bearer not leaked)", async () => {
    const mgr = await managerWith([makeAccount("a0")]);
    const customFetch = createCustomFetch(mgr);

    await expect(
      customFetch("https://evil.example.com/v1/chat/completions", {
        method: "POST",
      }),
    ).rejects.toThrow(/non-xAI host/);

    // No outward request was ever made.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("overwrites the SDK dummy apiKey with a real per-account bearer", async () => {
    const mgr = await managerWith([makeAccount("a0")]);
    const customFetch = createCustomFetch(mgr);

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch(ENDPOINT, {
      method: "POST",
      // The SDK stamps a dummy bearer; customFetch must OVERWRITE it.
      headers: { authorization: "Bearer multi-xai-dummy-key" },
    });

    expect(bearerOf(fetchSpy.mock.calls[0][1])).toBe("Bearer at-a0");
  });

  it("auth-dead that survives a FORCED refresh → cooldown + rotate (never marked dead)", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    // S-1: the forced refresh must bypass the fast path and fire a REAL network
    // grant even though a0's seeded token is not locally expired.
    refreshTokensMock.mockResolvedValueOnce({
      accessToken: "at-a0-rotated",
      refreshToken: "rt-a0-rotated",
      expiresAt: Date.now() + HOUR,
    });

    fetchSpy
      // a0 first attempt → auth-dead (401)
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }))
      // a0 forced-refresh retry (with the rotated token) → STILL auth-dead
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }))
      // a1 → ok
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);

    // The forced refresh genuinely fired (S-1), and the retry used the rotated
    // token — not the stale seeded one.
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchSpy.mock.calls[1][1])).toBe("Bearer at-a0-rotated");

    // a0 was cooled down (auth-failure), NOT marked dead (only refresh-grant
    // invalid_grant marks dead).
    expect(mgr.get("a0")?.subscriptionStatus).not.toBe("dead");
    expect(mgr.get("a0")?.coolingDownUntil).toBeGreaterThan(Date.now());
    expect(mgr.get("a0")?.cooldownReason).toBe("auth-failure");
    // Rotated to a1.
    expect(bearerOf(fetchSpy.mock.calls[2][1])).toBe("Bearer at-a1");
  });

  it("S-1: auth-dead → forced refresh fires a real grant and RECOVERS when the rotated token succeeds", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    refreshTokensMock.mockResolvedValueOnce({
      accessToken: "at-a0-rotated",
      refreshToken: "rt-a0-rotated",
      expiresAt: Date.now() + HOUR,
    });

    fetchSpy
      // a0 first attempt → auth-dead (401)
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }))
      // a0 forced-refresh retry with the rotated token → ok
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);

    // A real network refresh fired; the retry used the freshly rotated token and
    // succeeded on the SAME account (no rotation to a1).
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchSpy.mock.calls[1][1])).toBe("Bearer at-a0-rotated");
    // Success touched a0; it was never cooled down or marked dead.
    expect(mgr.get("a0")?.lastUsed).toBeGreaterThan(0);
    expect(mgr.get("a0")?.coolingDownUntil).toBeUndefined();
    expect(mgr.get("a0")?.subscriptionStatus).not.toBe("dead");
    // a1 was never attempted.
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it("S-2: auth-dead retry hitting quota-exhausted MARKS the account (marks not dropped on the retry path)", async () => {
    const mgr = await managerWith([makeAccount("a0"), makeAccount("a1")]);
    const customFetch = createCustomFetch(mgr);

    refreshTokensMock.mockResolvedValueOnce({
      accessToken: "at-a0-rotated",
      refreshToken: "rt-a0-rotated",
      expiresAt: Date.now() + HOUR,
    });

    fetchSpy
      // a0 first attempt → auth-dead (401)
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }))
      // a0 forced-refresh retry → quota-exhausted (must be MARKED, not dropped)
      .mockResolvedValueOnce(
        jsonResponse(403, { error: "you have run out of credits" }),
      )
      // a1 → ok
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await customFetch(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);

    // The quota-exhausted classification on the RETRY still marked a0 (S-2 bug
    // was: the auth-dead retry path blanket-rotated and dropped this mark).
    expect(mgr.get("a0")?.quotaResetAt).toBeGreaterThan(Date.now());
    // a0 was NOT cooled down (it was quota-exhausted, a different signal) and
    // NOT marked dead.
    expect(mgr.get("a0")?.cooldownReason).toBeUndefined();
    expect(mgr.get("a0")?.subscriptionStatus).not.toBe("dead");
    // Rotated to a1 and succeeded.
    expect(bearerOf(fetchSpy.mock.calls[2][1])).toBe("Bearer at-a1");
  });
});
