/**
 * P0 EXISTENTIAL SPIKE — go/no-go test for OAuth-bearer inference against xAI.
 *
 * Run standalone:
 *   bun scripts/spike.ts
 *   # or: npx tsx scripts/spike.ts
 *
 * Flow:
 *   1. Device-code login (headless-friendly): prints a URL + user code, waits.
 *   2. Prints the decoded identity (email / accountId) from the access token.
 *   3. POSTs a tiny chat/completions request to https://api.x.ai/v1 with the
 *      OAuth bearer.
 *   4. Prints the HTTP status + raw body.
 *   5. Interprets the result:
 *        200                              -> GO
 *        403 + permission/entitlement     -> NO-GO (entitlement-blocked #26847)
 *        anything else                    -> print status for diagnosis
 *
 * This script is intentionally self-contained: it does NOT persist to the
 * account store. It only exercises the OAuth + inference path and prints.
 *
 * NOTE: this imports the auth modules directly (not through the lib barrel) so
 * it stays runnable on its own without pulling in unrelated exports.
 */

import { XAI_API_BASE } from "../lib/constants.js";
import {
  decodeJwt,
  extractIdentity,
  type Tokens,
} from "../lib/auth/oauth.js";
import { deviceCodeLogin } from "../lib/auth/device-code.js";

const MODEL = "grok-3";

function line(): void {
  console.log("─".repeat(64));
}

async function main(): Promise<void> {
  line();
  console.log("multi-xai P0 spike — OAuth bearer vs api.x.ai inference");
  line();

  // 1. Device-code login.
  console.log("Starting device-code login...\n");
  let tokens: Tokens;
  try {
    tokens = await deviceCodeLogin((p) => {
      console.log(`  1. Open: ${p.verificationUri}`);
      if (p.verificationUriComplete) {
        console.log(`     (direct: ${p.verificationUriComplete})`);
      }
      console.log(`  2. Enter code: ${p.userCode}`);
      console.log(`\n  Waiting for authorization (expires in ${p.expiresIn}s)...\n`);
    });
  } catch (err) {
    console.error(`\nLogin failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log("Login succeeded.\n");

  // 2. Decode identity.
  try {
    const claims = decodeJwt(tokens.accessToken);
    const id = extractIdentity(claims);
    console.log(`Identity: accountId=${id.accountId} email=${id.email ?? "(none)"}`);
  } catch (err) {
    console.log(
      `Identity: could not decode access token as JWT (${(err as Error).message})`,
    );
  }
  console.log(
    `Access token expires at: ${new Date(tokens.expiresAt).toISOString()}\n`,
  );

  // 3. Inference request.
  const url = `${XAI_API_BASE}/chat/completions`;
  console.log(`POST ${url} (model=${MODEL})\n`);

  let status: number;
  let body: string;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    console.error(`Request failed (network): ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // 4. Print status + raw body.
  line();
  console.log(`HTTP ${status}`);
  console.log(body);
  line();

  // 5. Interpret.
  if (status === 200) {
    console.log("GO: OAuth bearer works against api.x.ai");
    return;
  }

  const entitlementBlocked =
    status === 403 &&
    /caller does not have permission|entitlement|not.*allowlist/i.test(body);

  if (entitlementBlocked) {
    console.log(
      "NO-GO (entitlement-blocked #26847): this account not allowlisted for OAuth API",
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    `INCONCLUSIVE: HTTP ${status} — inspect the body above for diagnosis`,
  );
  process.exitCode = 3;
}

void main();
