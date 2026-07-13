# lib/auth — SuperGrok OAuth

**Parent:** root `AGENTS.md`. Do not restate package layout, install, or plugin export rules.

## OVERVIEW

OAuth protocol + login UX for SuperGrok. Browser loopback and device-code grants; shared pool upsert. No raw token paste.

## WHERE TO LOOK

| Task | File | Symbol |
|------|------|--------|
| Discover / exchange / refresh | `oauth.ts` | `discoverEndpoints`, `exchangeCode`, `refreshTokens` |
| Host-pin check | `oauth.ts` | `isTrustedEndpoint`, `assertTrustedEndpoint` |
| JWT identity | `oauth.ts` | `extractIdentity`, `decodeJwt` |
| Loopback server | `server.ts` | `waitForCallback` |
| Device grant | `device-code.ts` | `deviceCodeLogin`, `LoginCancelledError` |
| Durable refresh helper | `refresh.ts` | `getFreshTokens` |
| CLI/TUI login + pool upsert | `login.ts` | `browserLogin`, `deviceCodeLoginFlow`, `finalizeLoginToPool` |
| PKCE | `pkce.ts` | `generatePkce`, `generateState` |

Plugin auth methods also call these from `lib/plugin.ts` (finalize → `finalizeLoginToPool` + model sync).

## CONVENTIONS

- Public OAuth constants live in `lib/constants.ts` — treat as immutable (`CLIENT_ID`, `REDIRECT_URI` `:56121`, `plan=generic`, scopes).
- Discovery may fail → fallback endpoints; **do not cache** fallback (retry discovery next call).
- xAI rotates refresh tokens: always `refresh_token ?? oldRefreshToken`.
- `InvalidGrantError` = terminal credential; `TransientAuthError` = network/5xx — do not conflate.
- Cancel: device/browser flows honor `AbortSignal` / `LoginCancelledError` (TUI Esc).

## ANTI-PATTERNS

- NEVER POST credentials to non-HTTPS or non-`*.x.ai` (re-assert pin at every credential POST).
- NEVER resolve refresh success before durable persist (`refresh.ts` HARD CONTRACT).
- NEVER reuse a detached stale refresh snapshot after rotation.
- NEVER invent identity `"unknown"` when JWT lacks `sub` — reject login.
- NEVER log token values on persist/refresh failure.
- NEVER mutate the account pool except via `AccountManager` (`finalizeLoginToPool` / upsert).

## NOTES

- Tests mock only `refreshTokens` (`vi.hoisted` + `importOriginal`); full browser/device UI untested.
- Plugin `finalizeLogin` also triggers `resolveXaiMultiModels({ allowNetwork: true })`.
