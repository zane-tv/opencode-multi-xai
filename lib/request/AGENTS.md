# lib/request — customFetch, classify, quota

**Parent:** root `AGENTS.md`. Selection eligibility lives in `lib/accounts.ts`; this domain classifies and rotates.

## OVERVIEW

Outbound inference pipeline: host-pin bearer, sticky account pick, classify failures, rotate recoverable errors, probe plan/credits/rate-limits. Classifier is pure; fetch owns marks.

## WHERE TO LOOK

| Task | File | Symbol |
|------|------|--------|
| Rotation loop | `fetch.ts` | `createCustomFetch` |
| Failure taxonomy | `classify-error.ts` | `classifyResponse`, `classifyThrownError` |
| Reasoning body patch | `body-bridge.ts` | `injectXaiReasoningBody` |
| Session variant stash | `session-options.ts` | `rememberSessionOptions`, `getSessionOptions` |
| API remaining | `rate-limit.ts` | `parseRateLimitHeaders`, `probeAccountRateLimit` |
| Monthly credits % | `billing-quota.ts` | `fetchGrokBillingQuota` |
| Plan / Heavy-safe label | `plan.ts` | `fetchGrokPlan`, `planFromAccessToken` |
| Email fill | `user-profile.ts` | `fetchGrokUserProfile` |

## STRUCTURE

```
request/
├── fetch.ts            # I/O + marks + rotate
├── classify-error.ts   # pure Classification union
├── body-bridge.ts
├── session-options.ts
├── rate-limit.ts
├── billing-quota.ts
├── plan.ts
└── user-profile.ts
```

## CONVENTIONS

- Classify on **initial** status/body clone; never re-parse 2xx stream body as error (S3).
- Match order matters: **quota before entitlement** on 403.
- Per request: `attempted` set; attempt cap = pool size; one same-account transient retry; one auth-recover force-refresh.
- On `rotate`, optional short backoff; discard body only when not returning response.
- Quota probes (billing/plan/rate-limit) are fire-and-forget-friendly — never block success stream on bookkeeping.

## ANTI-PATTERNS

- NEVER send bearer off `api.x.ai` — throw instead.
- NEVER append `Authorization` — `headers.set` overwrite only.
- NEVER rotate on `unknown-client-error` / bare param 4xx (oracle B1).
- NEVER mark `dead` on inference auth-dead after refresh succeeded — cooldown + rotate.
- NEVER map credit/quota strings → auth-dead or prune.
- NEVER blind-rotate entitlement #26847 — mark blocked + skip.
- NEVER treat max_tokens / param allowlist 400s as auth-dead.
- NEVER burn pool on every 429 — transient backoff, keep account.
- NEVER match bare upsell `"purchase more credits"` as quota-exhausted.

## Classification → action (fetch)

| kind | Mark | Action |
|------|------|--------|
| `ok` | touchLastUsed (+ rate-limit) | return |
| `quota-exhausted` | markQuotaExhausted | rotate |
| `entitlement-blocked` | markEntitlementBlocked | rotate |
| `auth-dead` (1st) | — | auth-recover force refresh |
| `auth-dead` (retry) | recordCooldown | rotate |
| `transient` (after same-acct retry) | — | rotate + backoff |
| `server` / `network` | — | rotate + backoff |
| `unknown-client-error` | — | return as-is |

## NOTES

- Well-tested: `test/fetch.test.ts`, `test/classify-error.test.ts`, plan/billing/rate-limit/body-bridge suites.
- “Next account” = first eligible in **priority-sorted** list after sticky fails — not `activeIndex+1`.
