/**
 * Shared SuperGrok OAuth login for plugin + CLI/TUI (no OpenCode host required).
 *
 * - browserLogin: PKCE + loopback callback on 127.0.0.1:56121
 * - deviceCodeLoginFlow: RFC 8628 device code (best for terminals)
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import { OAUTH_SCOPE } from "../constants.js";
import type { AccountManager } from "../accounts.js";
import type { AccountMetadata } from "../schemas.js";
import { logger } from "../logger.js";
import { generatePkce, generateState } from "./pkce.js";
import {
  buildAuthorizeUrl,
  decodeJwt,
  discoverEndpoints,
  exchangeCode,
  extractIdentity,
  type Tokens,
} from "./oauth.js";
import { planFromAccessToken } from "../request/plan.js";
import { waitForCallback } from "./server.js";
import {
  deviceCodeLogin,
  type DeviceCodePrompt,
} from "./device-code.js";

export type LoginResult = {
  accountId: string;
  email?: string;
  outcome: "added" | "updated";
};

export type DeviceCodePromptHandler = (p: DeviceCodePrompt) => void;

function accountFromTokens(tokens: Tokens): AccountMetadata {
  const claims = decodeJwt(tokens.accessToken);
  const identity = extractIdentity(claims);
  const now = Date.now();
  const plan = planFromAccessToken(tokens.accessToken, now);
  return {
    accountId: identity.accountId,
    email: identity.email,
    tags: [],
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    oauthScope: OAUTH_SCOPE,
    enabled: true,
    addedAt: now,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    planTier: plan.planTier,
    planName: plan.planName,
    planObservedAt: plan.observedAt,
  };
}

/**
 * Persist a freshly minted OAuth session into the pool.
 * Re-login of the same accountId updates tokens instead of failing.
 */
export async function finalizeLoginToPool(
  manager: AccountManager,
  tokens: Tokens,
): Promise<LoginResult> {
  const account = accountFromTokens(tokens);
  const outcome = await manager.upsertFromOAuth(account);
  logger.debug(`OAuth ${outcome} account ${account.accountId}`);
  return {
    accountId: account.accountId,
    email: account.email,
    outcome,
  };
}

/** Best-effort open URL in the default browser (macOS/Linux/Windows). */
export function openInBrowser(url: string): void {
  try {
    const p = platform();
    if (p === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (p === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    logger.debug(`openInBrowser failed: ${(err as Error).message}`);
  }
}

/**
 * Browser PKCE loopback login. Opens the authorize URL, waits for callback,
 * exchanges code, upserts pool.
 */
export async function browserLogin(
  manager: AccountManager,
  opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
  },
): Promise<LoginResult> {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const endpoints = await discoverEndpoints();
  const url = buildAuthorizeUrl({
    codeChallenge,
    state,
    authorizeUrl: endpoints.authorizeUrl,
  });

  opts?.onAuthorizeUrl?.(url);
  if (opts?.openBrowser !== false) openInBrowser(url);

  const { code } = await waitForCallback(state);
  const tokens = await exchangeCode({
    code,
    codeVerifier,
    tokenUrl: endpoints.tokenUrl,
  });
  return finalizeLoginToPool(manager, tokens);
}

/**
 * Device-code login. `onPrompt` receives verification URI + user code once;
 * then polls until authorized or expired.
 */
export async function deviceCodeLoginFlow(
  manager: AccountManager,
  onPrompt?: DeviceCodePromptHandler,
): Promise<LoginResult> {
  const tokens = await deviceCodeLogin(onPrompt);
  return finalizeLoginToPool(manager, tokens);
}
