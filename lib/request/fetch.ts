import { XAI_API_HOST } from "../constants.js";
import { logger } from "../logger.js";
import { getAccountManager, type AccountManager } from "../accounts.js";
import { InvalidGrantError } from "../auth/oauth.js";
import {
  classifyResponse,
  classifyThrownError,
  type Classification,
} from "./classify-error.js";
import {
  injectXaiReasoningBody,
  sessionIdFromHeaders,
} from "./body-bridge.js";
import { getSessionOptions } from "./session-options.js";

/** The input/init shapes of the runtime `fetch`, without relying on DOM libs. */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * customFetch — the S5 rotation pipeline.
 *
 * OpenCode's AI SDK calls this fetch for every xAI request. The SDK stamps a
 * dummy apiKey; we OVERWRITE the Authorization header with a live bearer for a
 * SELECTED account, classify the response, and — on a recoverable failure —
 * rotate to a sibling account and retry, all within a SINGLE outward request so
 * the caller sees one Response.
 *
 * Design rules (deliberately simple, YAGNI per plan):
 *   - Distinct-account attempt cap = pool size; a failed account is added to
 *     `attempted` at the point we commit to it so it is never reselected.
 *   - Inner retries (one transient backoff, one auth-dead forced-refresh retry)
 *     are bounded and do NOT consume a distinct-account slot.
 *   - Classification drives the action via a SINGLE shared handler used for both
 *     the first attempt AND the auth-dead retry, so account marks
 *     (quota-exhausted / entitlement-blocked) are applied identically on either
 *     path (never dropped on the retry — oracle S-2).
 *   - unknown-client-error is returned as-is (a bad param must not fake a
 *     pool-wide outage — oracle B1).
 *   - Selection/mutation go ONLY through AccountManager; this module never
 *     touches storage directly.
 */

/** Fixed, bounded backoff for a single same-account transient retry. */
const TRANSIENT_BACKOFF_MS = 250;
/** Brief backoff before rotating on server/network failures. */
const NETWORK_BACKOFF_MS = 150;
/** Fallback quota reset window when no retry hint is present. */
const QUOTA_FALLBACK_MS = 15 * 60_000;
/** Cooldown for an account whose auth failure survived a forced refresh. */
const AUTH_COOLDOWN_MS = 5 * 60_000;
/**
 * Upper bound on how much of an ERROR response body we read for classification.
 * A JSON error envelope is tiny; 64KB is generous and prevents an unbounded
 * read of a pathological error body (oracle S-3).
 */
const MAX_CLASSIFY_BYTES = 64 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort cancel of a response body we are DISCARDING (a rotate/retry path).
 * Never call this on a response we RETURN — the caller must get an intact,
 * readable stream. Safe on a null body and swallows cancel errors.
 */
function discardBody(res: Response | undefined): void {
  res?.body?.cancel().catch(() => {});
}

/** Coerce the various fetch input shapes into a parseable URL. */
function toURL(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as Request).url);
}

/**
 * Read at most `maxBytes` of a CLONE of the response body, for classification.
 * The original `res` is left untouched (we read a clone), so a caller can still
 * return the original with an intact readable stream.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const clone = res.clone();
  const reader = clone.body?.getReader();
  if (!reader) {
    try {
      return await clone.text();
    } catch {
      return "";
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    // A partial read is fine for classification.
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Outcome of a single outward HTTP attempt against one bearer. */
interface Attempt {
  /** Present unless fetch itself threw. */
  res?: Response;
  classification: Classification;
  /** The raw thrown error, when fetch threw (for faithful rethrow). */
  error?: unknown;
}

/**
 * Perform ONE request with the given bearer and classify the result.
 *
 * The Authorization header is OVERWRITTEN (set, not appended) so the SDK's
 * dummy apiKey never leaks through. For a 2xx we return the ORIGINAL response
 * untouched (its stream is never read) so the body pipes through cleanly. For
 * an error we read a bounded CLONE for classification, leaving the original
 * body intact in case the caller decides to return it (unknown-client-error).
 */
async function doRequest(
  input: FetchInput,
  init: FetchInit,
  accessToken: string,
): Promise<Attempt> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(input, { ...init, headers });
  } catch (err) {
    return { classification: classifyThrownError(err), error: err };
  }

  // Trust the status line on the initial response for 2xx: return the original
  // (unconsumed) response so the stream pipes through untouched.
  if (res.status >= 200 && res.status < 300) {
    return { res, classification: { kind: "ok" } };
  }

  // Error path: read a bounded CLONE for classification; original stays intact.
  const bodyText = await readBoundedText(res, MAX_CLASSIFY_BYTES);
  return {
    res,
    classification: classifyResponse(res.status, res.headers, bodyText),
  };
}

/**
 * The action the pipeline should take for a classified attempt.
 *   - return:       hand this response back to the caller (intact body).
 *   - throw:        rethrow a fetch-level error (no Response available).
 *   - rotate:       move to the next account (optionally after a short backoff).
 *   - auth-recover: force a refresh and retry ONCE against the same account.
 */
type Handled =
  | { action: "return"; res: Response }
  | { action: "throw"; error: unknown }
  | { action: "rotate"; backoffMs?: number }
  | { action: "auth-recover" };

interface HandleCtx {
  /** True on the first attempt (auth-dead may recover); false on the retry. */
  allowAuthRecover: boolean;
  /** Warn-once sink for entitlement-blocked accounts. */
  warnEntitlement: (id: string) => void;
}

/**
 * Map a classified attempt to an action, performing the SAME account mark for a
 * given classification regardless of whether this is the first attempt or the
 * auth-dead retry (oracle S-2: marks must never be dropped on the retry path).
 */
async function handleAttempt(
  manager: AccountManager,
  attempt: Attempt,
  id: string,
  ctx: HandleCtx,
): Promise<Handled> {
  const c = attempt.classification;
  switch (c.kind) {
    case "ok": {
      await manager.touchLastUsed(id);
      return { action: "return", res: attempt.res as Response };
    }

    case "transient": {
      // The caller already spent the one same-account transient retry; a
      // still-transient result rotates after a brief backoff.
      return { action: "rotate", backoffMs: NETWORK_BACKOFF_MS };
    }

    case "quota-exhausted": {
      const resetAt = c.resetAtMs ?? Date.now() + QUOTA_FALLBACK_MS;
      await manager.markQuotaExhausted(id, resetAt);
      return { action: "rotate" };
    }

    case "entitlement-blocked": {
      await manager.markEntitlementBlocked(id);
      ctx.warnEntitlement(id);
      return { action: "rotate" };
    }

    case "auth-dead": {
      if (ctx.allowAuthRecover) {
        // First hit: try a forced refresh + one retry (handled by the caller).
        return { action: "auth-recover" };
      }
      // The retry AFTER a forced refresh is STILL auth-dead: the refresh grant
      // succeeded (or adopted a fresh token) yet inference rejects it. NEVER
      // mark dead here (only a refresh-grant invalid_grant does that) — cool the
      // account down and rotate.
      await manager.recordCooldown(
        id,
        "auth-failure",
        Date.now() + AUTH_COOLDOWN_MS,
      );
      return { action: "rotate" };
    }

    case "server":
    case "network": {
      return { action: "rotate", backoffMs: NETWORK_BACKOFF_MS };
    }

    case "unknown-client-error": {
      // Client/param error (e.g. bad max_tokens). Rotating would fake a
      // pool-wide outage (oracle B1) — return it immediately, no rotation.
      if (attempt.res) return { action: "return", res: attempt.res };
      return {
        action: "throw",
        error: attempt.error ?? new Error("multi-xai: unknown client error"),
      };
    }
  }
}

/**
 * Synthesize the terminal 503 when no account can serve the request. The body
 * and `retry-after` header carry the earliest recovery time across the pool
 * (min of any future quotaResetAt / coolingDownUntil).
 */
function buildExhaustedResponse(
  manager: AccountManager,
  count: number,
): Response {
  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const a of manager.list()) {
    if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
      earliest = Math.min(earliest, a.quotaResetAt);
    }
    if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
      earliest = Math.min(earliest, a.coolingDownUntil);
    }
  }

  const headers = new Headers({ "content-type": "application/json" });
  const body: Record<string, unknown> = {
    error: `All ${count} xAI accounts exhausted`,
  };
  if (Number.isFinite(earliest)) {
    const retryAfterSec = Math.max(0, Math.ceil((earliest - now) / 1000));
    headers.set("retry-after", String(retryAfterSec));
    body.retryAfterSeconds = retryAfterSec;
    body.earliestResetAt = earliest;
  }

  return new Response(JSON.stringify(body), { status: 503, headers });
}

/**
 * Build a `fetch`-compatible function that selects a live account, attaches its
 * bearer, and rotates over the pool on recoverable failures.
 */
export function createCustomFetch(
  manager: AccountManager = getAccountManager(),
): (input: FetchInput, init?: FetchInit) => Promise<Response> {
  return async function customFetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    const parsedUrl = toURL(input);

    // HOST-PIN (S5): only ever attach the bearer to api.x.ai. Anything else is
    // a misconfigured baseURL/redirect — refuse rather than leak the token.
    if (parsedUrl.host !== XAI_API_HOST) {
      throw new Error(
        `multi-xai customFetch refusing to send a bearer to non-xAI host "${parsedUrl.host}" ` +
          `(expected ${XAI_API_HOST}); check the provider baseURL configuration`,
      );
    }

    const sessionID = sessionIdFromHeaders(
      init?.headers as Headers | Record<string, string> | undefined,
    );
    const sessionOpts = getSessionOptions(sessionID);
    const requestInit =
      injectXaiReasoningBody(parsedUrl, init, sessionOpts) ?? init;

    const attempted = new Set<string>();
    const poolSize = manager.list().length;
    let warnedEntitlement = false;
    const warnEntitlement = (id: string): void => {
      if (warnedEntitlement) return;
      warnedEntitlement = true;
      logger.warn(
        `account ${id} is entitlement-blocked (xAI allowlist gate #26847); ` +
          `skipping it in selection`,
      );
    };

    // Loop over DISTINCT accounts, capped at the pool size.
    for (let i = 0; i < poolSize; i++) {
      const account = manager.selectAccount(attempted);
      if (!account) break;
      const id = account.accountId;
      // Commit to this account: never reselect it this request.
      attempted.add(id);

      // Ensure a fresh bearer (proactive; fast path is correct here). A
      // refresh-grant invalid_grant kills the credential and rotates;
      // transient/other is treated as network and rotates after a brief backoff.
      let accessToken: string;
      try {
        const tokens = await manager.ensureFreshToken(id);
        accessToken = tokens.accessToken;
      } catch (err) {
        if (err instanceof InvalidGrantError) {
          await manager.markDeadCandidate(id);
        } else {
          await sleep(NETWORK_BACKOFF_MS);
        }
        continue;
      }

      // First attempt.
      let attempt = await doRequest(input, requestInit, accessToken);

      // transient → ONE bounded backoff + retry against the SAME account. This
      // inner retry does NOT consume a distinct-account slot.
      if (attempt.classification.kind === "transient") {
        await sleep(TRANSIENT_BACKOFF_MS);
        discardBody(attempt.res);
        attempt = await doRequest(input, requestInit, accessToken);
        // If still transient it is rotated by the shared handler below.
      }

      let handled = await handleAttempt(manager, attempt, id, {
        allowAuthRecover: true,
        warnEntitlement,
      });

      // auth-dead recovery: force a REAL refresh (bypassing the fast path so a
      // server-side-revoked-but-not-yet-expired token is genuinely re-granted —
      // oracle S-1), then retry ONCE against the same account and feed the retry
      // back through the SAME handler with recovery disabled (no infinite loop).
      if (handled.action === "auth-recover") {
        discardBody(attempt.res);
        let refreshedToken: string;
        try {
          const fresh = await manager.ensureFreshToken(id, true);
          refreshedToken = fresh.accessToken;
        } catch (err) {
          if (err instanceof InvalidGrantError) {
            await manager.markDeadCandidate(id);
          } else {
            await sleep(NETWORK_BACKOFF_MS);
          }
          continue;
        }

        attempt = await doRequest(input, requestInit, refreshedToken);
        handled = await handleAttempt(manager, attempt, id, {
          allowAuthRecover: false,
          warnEntitlement,
        });
      }

      switch (handled.action) {
        case "return":
          return handled.res;
        case "throw":
          discardBody(attempt.res);
          throw handled.error;
        case "rotate":
          discardBody(attempt.res);
          if (handled.backoffMs) await sleep(handled.backoffMs);
          continue;
      }
    }

    // No account could serve the request.
    logger.warn(`all ${poolSize} xAI account(s) exhausted for this request`);
    return buildExhaustedResponse(manager, poolSize);
  };
}
