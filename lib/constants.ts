import os from "node:os";
import path from "node:path";

/**
 * xAI SuperGrok OAuth constants.
 *
 * These values are PUBLIC and CONFIRMED across 5 shipping repositories
 * (anomalyco/opencode PR #28557, agent-zero, ysnock404/opencode-grok-auth,
 * Routiform, SeekerClaw). Do NOT change them.
 */

/** Public Grok-CLI desktop client id. */
export const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/** OAuth / OIDC issuer. */
export const OAUTH_ISSUER = "https://auth.x.ai";

/** OIDC discovery document. */
export const OAUTH_DISCOVERY_URL =
  "https://auth.x.ai/.well-known/openid-configuration";

/**
 * Loopback redirect URI. The port is registered with the OAuth client and
 * must match EXACTLY, otherwise the loopback OAuth flow is rejected.
 */
export const REDIRECT_URI = "http://127.0.0.1:56121/callback";

/** Loopback callback host + port derived from REDIRECT_URI. */
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 56121;
export const CALLBACK_PATH = "/callback";

/** OAuth scopes. */
export const OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";

/**
 * Extra authorize params. `plan=generic` is REQUIRED or the loopback OAuth
 * flow is rejected.
 */
export const OAUTH_EXTRA_PARAMS: Record<string, string> = { plan: "generic" };

/** RFC 8628 device authorization grant type. */
export const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Fallback OAuth endpoints used if OIDC discovery fails. Discovery results are
 * pinned to HTTPS `*.x.ai`; on any failure we fall back to these constants.
 */
export const FALLBACK_AUTHORIZE_URL = `${OAUTH_ISSUER}/oauth2/authorize`;
export const FALLBACK_TOKEN_URL = `${OAUTH_ISSUER}/oauth2/token`;
export const FALLBACK_DEVICE_CODE_URL = `${OAUTH_ISSUER}/oauth2/device/code`;

/** xAI inference API. */
export const XAI_API_BASE = "https://api.x.ai/v1";

/** xAI API host, used for bearer host-pinning (token leak guard). */
export const XAI_API_HOST = "api.x.ai";

/** Custom provider id. Do NOT override the built-in `xai` provider. */
export const PROVIDER_ID = "xai-multi";

/**
 * Refresh access tokens this many ms BEFORE their real expiry, to avoid
 * racing the expiry boundary.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Timeout for OAuth/token HTTP requests. Node's fetch has no default timeout;
 * without this a hung request could wedge the single-flight refresh promise.
 */
export const AUTH_FETCH_TIMEOUT_MS = 30_000;

/** Maximum number of accounts allowed in the pool. */
export const MAX_ACCOUNTS = 20;

/**
 * Default chat models for the xai-multi provider (from models.dev, Jul 2026).
 * Requested ids may be remapped server-side by xAI. Image/video models are
 * omitted here — add them in opencode.json if needed.
 */
export const DEFAULT_MODELS: Record<
  string,
  {
    name: string;
    reasoning?: boolean;
    limit?: { context: number; output: number };
    variants?: Record<
      string,
      { reasoningEffort: string } | { disabled: true }
    >;
  }
> = {
  "grok-4.5": {
    name: "Grok 4.5",
    reasoning: true,
    limit: { context: 500_000, output: 500_000 },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
  },
  "grok-4.3": {
    name: "Grok 4.3",
    reasoning: true,
    limit: { context: 1_000_000, output: 30_000 },
    variants: {
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
  },
  "grok-4.20-0309-reasoning": {
    name: "Grok 4.20 (Reasoning)",
    reasoning: true,
    limit: { context: 1_000_000, output: 30_000 },
    variants: {
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    },
  },
  "grok-4.20-0309-non-reasoning": {
    name: "Grok 4.20 (Non-Reasoning)",
    reasoning: false,
    limit: { context: 1_000_000, output: 30_000 },
  },
  "grok-4.20-multi-agent-0309": {
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    limit: { context: 1_000_000, output: 30_000 },
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    },
  },
  "grok-build-0.1": {
    name: "Grok Build 0.1",
    reasoning: true,
    limit: { context: 256_000, output: 256_000 },
    variants: {
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    },
  },
};

/** Default global account storage path: ~/.config/opencode/multi-xai-accounts.json */
export function defaultStoragePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-xai-accounts.json",
  );
}

/** Cached models.dev catalog: ~/.config/opencode/multi-xai-models.json */
export function defaultModelsCachePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-xai-models.json",
  );
}
