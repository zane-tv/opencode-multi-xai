# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-14  
**Commit:** 5159bf9  
**Branch:** main

## OVERVIEW

OpenCode plugin `opencode-multi-xai` — multi SuperGrok OAuth account pool under provider `xai-multi`. Sticky rotation via customFetch, plan/quota probes, agent tools, and standalone `op-xai` CLI + OpenTUI. Single ESM package; ships TypeScript source (Bun/OpenCode load `.ts` directly; no `dist/`).

## STRUCTURE

```
opencode-mutil-xai/          # workspace folder name (typo: mutil ≠ multi)
├── index.ts                 # package entry → default plugin only
├── install.sh               # curl|bash + local setup
├── lib/
│   ├── plugin.ts            # PluginModule { id, server } ONLY
│   ├── accounts.ts          # AccountManager — pool truth
│   ├── storage.ts           # atomic JSON + cross-process lock
│   ├── schemas.ts           # Zod AccountStorage v1
│   ├── auth/                # OAuth protocol + login UX  → see AGENTS.md
│   ├── request/             # customFetch / classify / quota → see AGENTS.md
│   ├── tools/               # buildTools (agent + CLI)
│   └── tui/                 # OpenTUI manager             → see AGENTS.md
├── scripts/                 # cli.ts, install.ts, install-cli.sh
└── test/                    # flat vitest (no nested dirs)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| OpenCode load / provider wire | `index.ts` → `lib/plugin.ts` | default export only |
| Sticky select + priority | `lib/accounts.ts` | `selectAccount`, `sortAccountsByPriority` |
| Rotation / bearer / retries | `lib/request/fetch.ts` | `createCustomFetch` |
| Error taxonomy | `lib/request/classify-error.ts` | pure; no I/O |
| Disk + lock | `lib/storage.ts` | never touch OpenCode `auth.json` |
| OAuth browser/device | `lib/auth/` | shared finalize: `login.ts` |
| Token refresh | `accounts.ensureFreshToken` + `auth/refresh.ts` | durable-first |
| Agent tools | `lib/tools/registry.ts` | same map as CLI |
| CLI commands | `scripts/cli.ts` | thin shell over tools |
| TUI keys / live quota | `lib/tui/app.ts` | `runTui` |
| Models catalog | `lib/models-sync.ts` | network only post-login |
| Plan / credits / rate-limit | `lib/request/plan.ts`, `billing-quota.ts`, `rate-limit.ts` | |
| i18n en/vi | `lib/i18n.ts`, `lib/format-time.ts` | settings file |
| Install into OpenCode | `scripts/install.ts`, `install.sh` | |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `plugin` / default | Plugin | `lib/plugin.ts` | OpenCode entry; wires fetch + auth + tools |
| `AccountManager` | class | `lib/accounts.ts` | Canonical pool; all mutations |
| `getAccountManager` | fn | `lib/accounts.ts` | Process singleton (plugin path only) |
| `isSelectable` | fn | `lib/accounts.ts` | Single eligibility predicate |
| `selectAccount` | method | `lib/accounts.ts` | Sticky then priority-list scan |
| `ensureFreshToken` | method | `lib/accounts.ts` | Refresh + disk lock (S4) |
| `createCustomFetch` | fn | `lib/request/fetch.ts` | Rotation pipeline |
| `classifyResponse` | fn | `lib/request/classify-error.ts` | Failure → Classification |
| `withCrossProcessTransaction` | fn | `lib/storage.ts` | Advisory lock + re-read |
| `buildTools` | fn | `lib/tools/registry.ts` | `xai-*` tool map |
| `finalizeLoginToPool` | fn | `lib/auth/login.ts` | OAuth upsert shared |
| `refreshTokens` | fn | `lib/auth/oauth.ts` | Grant; `InvalidGrantError` |
| `runTui` | fn | `lib/tui/app.ts` | OpenTUI entry |
| `main` | fn | `scripts/cli.ts` | `op-xai` dispatcher |
| `resolveXaiMultiModels` | fn | `lib/models-sync.ts` | Catalog + cache |

**Spine:** `storage` → `accounts` → `fetch`/`classify` ← `auth/refresh`.  
**Satellites:** `tools`, `tui`, `plugin` config hook.  
**Dual construction:** plugin uses `getAccountManager()`; CLI/TUI use `new AccountManager()` (standalone process).

## CONVENTIONS

- ESM only; imports use **`.js` extensions** on TS sources. No path aliases. No linter/formatter config.
- Ship source: `"main": "index.ts"`, `tsc --noEmit`, Bun preferred (`bun.lock`).
- **Plugin export hygiene:** `lib/plugin.ts` default-exports **only** `{ id: "xai-multi", server }`. No named function exports. `lib/index.ts` must not re-export plugin.
- Zod (`lib/schemas.ts`) is the **persisted** boundary (`version: 1`). Tools use OpenCode `tool.schema`, not Zod.
- Provider id **`xai-multi`** only — never override built-in `xai`. Runtime LLM = external `@ai-sdk/xai`.
- Data files under `~/.config/opencode/`: `multi-xai-accounts.json` (600), `multi-xai-models.json`, `multi-xai-settings.json`.
- Env: `MULTI_XAI_DEBUG`, `MULTI_XAI_LANG` (one-shot), `MULTI_XAI_HOME` (install).
- Quiet logs; never pass tokens to `logger` (no redaction).
- Tests: flat `test/*.test.ts`; per-file `makeAccount`/`tmpStorePath`; mock `refreshTokens` surgically; replace `globalThis.fetch`.

## ANTI-PATTERNS (THIS PROJECT)

- NEVER raw token/API-key paste — SuperGrok OAuth only (browser/device).
- NEVER send bearer to any host except `api.x.ai`; OAuth POSTs only HTTPS `*.x.ai`.
- NEVER append `Authorization` — always overwrite (dummy SDK key).
- NEVER set `subscriptionStatus: "dead"` except refresh-grant `invalid_grant`.
- NEVER mark dead on inference 401 after successful refresh — cooldown + rotate only.
- NEVER map quota/credit strings to dead or prune (recoverable).
- NEVER prune solely on quota-exhausted — tool prune: dead **or** `flaggedForRemoval`.
- NEVER rotate pool on `unknown-client-error` / bare param 4xx.
- NEVER blind-rotate on entitlement #26847 — mark + skip.
- NEVER use rotated refresh token before durable persist; always `refresh_token ?? old`.
- NEVER nest storage transactions on same path; never log token values.
- NEVER named exports from `lib/plugin.ts`; no `as any` / `@ts-ignore`.
- NEVER change public OAuth constants (`CLIENT_ID`, redirect `:56121`, `plan=generic`).
- NEVER re-add YAGNI: healthScore, tokenBucket, activeIndexByModel, auto-prune-on-quota.

## UNIQUE STYLES

- Selection: sticky drain active account → on fail, rescan **priority-sorted list** (not `index+1`).
- Priority DESC, then `addedAt` ASC; list order = rotation preference.
- Models.dev network sync **only after successful OAuth**, not cold start.
- CLI reuses agent tools: `xai-${cmd}.execute` (exceptions: help, tui, add).
- Display name: label → email → short id; hide raw priority chips in list UI.
- Plan label: JWT `tier` + cli-chat-proxy `monthlyLimit` (Heavy-safe).

## COMMANDS

```bash
bun install                 # or npm install
npm run typecheck           # tsc --noEmit
npm test                    # vitest run
# no build / no CI workflows / no npm publish pipeline

./install.sh --path         # or npm run setup
npm run install:global      # shims → ~/.local/bin (op-xai)
bun scripts/install.ts [--with-plugin-entry]
bun scripts/cli.ts help     # without global install

# remote:
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-xai/main/install.sh | bash -s -- --path
```

## NOTES

- Repo: https://github.com/zane-tv/opencode-multi-xai — package name `opencode-multi-xai`.
- `opencode xai-add` does **not** work (path); use `op-xai` / TUI / agent tools.
- Install clones to `~/.local/share/opencode-multi-xai` when curl'd; shims require Bun.
- Well-tested: accounts, fetch, classify-error, storage-lock, tools, models-sync.  
  Untested: full OAuth device/browser UI, `lib/tui/app.ts`, `lib/plugin.ts` wiring.
- Child AGENTS: `lib/auth/`, `lib/request/`, `lib/tui/` — domain invariants only; do not repeat this file.
