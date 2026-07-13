# opencode-multi-xai

OpenCode plugin for **multiple SuperGrok (xAI) OAuth accounts** under one provider (`xai-multi`), with sticky rotation, plan/quota visibility, and a standalone CLI + OpenTUI manager.

| | |
| --- | --- |
| Provider ID | `xai-multi` |
| Auth | SuperGrok OAuth only (browser + device code) — **no raw token paste** |
| Runtime | `@ai-sdk/xai` (Responses API), same stack as OpenCode’s built-in `xai` |
| CLI | `op-xai` (`op-xai tui`, `op-xai list`, `op-xai limits --probe`, …) |
| Repo | https://github.com/zane-tv/opencode-multi-xai |

## Features

- **Multi-account pool** with sticky active account and automatic rotation on recoverable failures
- **OAuth login** from OpenCode, CLI, or TUI (device code recommended)
- **Plan detection** (Lite / SuperGrok / Heavy, …) from JWT `tier` + `cli-chat-proxy` monthly limit
- **Quota**
  - SuperGrok monthly credits % — `GetGrokCreditsConfig` (same family as [opencode-bar](https://github.com/opgginc/opencode-bar))
  - API remaining — `x-ratelimit-*` on `api.x.ai`
- **OpenTUI** (`op-xai tui`) — add / edit / delete, live quota refresh, plan + meters
- Quiet logs by default; models.dev network sync only after successful login
- Host-pin: bearer tokens only go to `api.x.ai`

## Requirements

- [OpenCode](https://opencode.ai) (tested with 1.17.x)
- Node.js 18+ or [Bun](https://bun.sh)
- One or more SuperGrok-capable xAI accounts (Lite / SuperGrok / Heavy / Premium+, etc.)

## Install

### 1. Clone and install deps

```bash
git clone https://github.com/zane-tv/opencode-multi-xai.git
cd opencode-multi-xai
npm install   # or: bun install
```

### 2. Wire the plugin into OpenCode

Add the **package directory** to `~/.config/opencode/opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-multi-xai"
  ],
  "provider": {
    "xai-multi": {
      "npm": "@ai-sdk/xai",
      "name": "Grok Multi-Account",
      "options": {
        "baseURL": "https://api.x.ai/v1"
      }
    }
  }
}
```

Or use the installer:

```bash
bun scripts/install.ts
# optional:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

Restart OpenCode after config changes.

### 3. Install the `op-xai` CLI (recommended)

```bash
bash scripts/install-cli.sh
# or: npm run install-cli
```

Installs a shim to `~/.local/bin/op-xai` (ensure that directory is on `PATH`).

Without install, from the repo:

```bash
bun scripts/cli.ts help
npm run cli -- list
```

> **Note:** `opencode xai-add` does **not** work — OpenCode treats that argument as a project path. Use `op-xai …` or agent tools inside a session.

## Add accounts

SuperGrok OAuth only. No cookie scrape, no pasting refresh tokens.

```bash
# Inside TUI (device OAuth — recommended)
op-xai tui          # press +

# CLI
op-xai add          # device code
op-xai add --browser

# OpenCode
opencode auth login   # provider xai-multi → SuperGrok OAuth (browser or device)
```

Repeat for each SuperGrok account. Re-login of the same account **updates tokens** (upsert).

### Data files (do not commit)

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/multi-xai-accounts.json` | Account pool + tokens (private) |
| `~/.config/opencode/multi-xai-models.json` | Model catalog cache (after login) |

## Chat usage

```bash
opencode models xai-multi
opencode run --model xai-multi/grok-4.5 --variant high "your prompt"
```

In OpenCode TUI: pick provider **Grok Multi-Account** / `xai-multi`, then model + optional variant.

### Default models

| Model | Notes |
| --- | --- |
| `grok-4.5` | Reasoning; variants `low` / `medium` / `high` |
| `grok-4.3` | Reasoning; includes `none` |
| `grok-4.20-0309-reasoning` | Reasoning; no effort param |
| `grok-4.20-0309-non-reasoning` | Non-reasoning |
| `grok-4.20-multi-agent-0309` | Multi-agent; includes `xhigh` |
| `grok-build-0.1` | Build-oriented |

Image/video (“imagine”) models are skipped by default.

## CLI (`op-xai`)

```text
op-xai help
op-xai tui
op-xai status
op-xai list [--tag NAME]
op-xai add [--browser]
op-xai limits|quota [--probe]
op-xai health
op-xai switch --index N | --id PREFIX
op-xai enable|disable --index N | --id PREFIX
op-xai label --index N --label TEXT
op-xai tag --index N --tags a,b,c
op-xai note --index N --note TEXT
op-xai refresh --index N | --id PREFIX
op-xai flag|unflag --index N | --id PREFIX
op-xai remove --index N --confirm
op-xai prune [--tag NAME] [--execute]   # dry-run unless --execute
```

Examples:

```bash
op-xai tui
op-xai list
op-xai limits --probe
op-xai switch --index 0
op-xai remove --index 1 --confirm
op-xai label --index 0 --label Work
```

## OpenTUI manager (`op-xai tui`)

OpenCode-style palette (warm orange primary, purple accent, neutral grays).

| Key | Action |
| --- | --- |
| `+` | **Add account** (device OAuth) |
| ACTIONS → Add (browser) | Browser loopback OAuth (`127.0.0.1:56121`) |
| `v` | Toggle **live quota** (default ON; selected every ~20s, all every 3 ticks) |
| `r` / `a` | Refresh quota one / all |
| `l` / `t` / `n` | Edit label / tags / note |
| `e` / `d` | Enable / disable |
| `s` | Switch sticky active |
| `x` | Remove selected (confirm twice) |
| `p` | Prune dead / expired / 0% credits (confirm) |
| `R` | Reload pool from disk |
| `Tab` | Focus accounts ↔ actions |
| `q` | Quit |

Detail pane shows **plan**, SuperGrok credit bar, and API rate-limit bars.

## Plan & quota

### Plan name

Best-effort merge of:

1. Access JWT claim `tier`
2. Absolute monthly limit from `GET https://cli-chat-proxy.grok.com/v1/billing`

Observed: SuperGrok **Heavy** often reports JWT `tier=5` and `monthlyLimit ≈ 150000`. Labels prefer billing limit so Heavy is not mislabeled as plain SuperGrok.

### Monthly credits %

```
POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
```

gRPC-web empty frame + Bearer — same family as [opencode-bar](https://github.com/opgginc/opencode-bar) `GrokProvider`. Parses used % and reset time.

### API remaining

From `x-ratelimit-*` headers on live `api.x.ai` traffic (or a tiny probe).

```bash
op-xai limits --probe   # refresh plan + billing % + rate limits
```

## Agent tools (inside OpenCode)

Same surface as CLI, e.g. `xai-list`, `xai-limits`, `xai-switch`, `xai-health`, `xai-remove` (needs `confirm=true`), `xai-prune` (dry-run by default).

| Tool | Purpose |
| --- | --- |
| `xai-status` | Compact pool line |
| `xai-list` | Accounts (+ optional `tag`) |
| `xai-limits` | Plan / credits % / rate limits (`probe=true` live) |
| `xai-health` | Refresh-token health for all |
| `xai-switch` | Sticky active |
| `xai-add` | How to add (points at `op-xai tui` / `op-xai add`) |
| `xai-label` / `xai-tag` / `xai-note` | Metadata |
| `xai-enable` / `xai-disable` | Selection |
| `xai-refresh` | Force token refresh |
| `xai-remove` | Delete one (`confirm=true`) |
| `xai-flag` / `xai-unflag` | Prune mark |
| `xai-prune` | Bulk dead/flagged (`dryRun` default true) |

### Prune safety

- **Never** prunes recoverable “out of credits” alone
- Only `subscriptionStatus === "dead"` and/or `flaggedForRemoval` (TUI also offers expired / 0% credits path with confirm)
- CLI/tool prune: dry-run by default

## How rotation works

1. OpenCode calls `@ai-sdk/xai` with a dummy API key and custom `fetch`
2. `customFetch` picks a live account, sets `Authorization: Bearer …`
3. On recoverable failure (quota, transient, some auth cases), rotates within the same request
4. Bearer is host-pinned to `api.x.ai` only

Sticky selection keeps the last good account until it fails.

## Logging & model sync

| Behavior | Default |
| --- | --- |
| Logs | Quiet — `warn` / `error` on stderr |
| Verbose | `MULTI_XAI_DEBUG=1` |
| models.dev | Only after successful OAuth login |
| Cold start models | Disk cache + bundled defaults (no network) |

```bash
MULTI_XAI_DEBUG=1 opencode models xai-multi
```

## Development

```bash
npm install
npm run typecheck
npm test
```

Layout:

```text
index.ts                 # package entry → PluginModule { id, server }
lib/plugin.ts            # OpenCode plugin (default export only)
lib/accounts.ts          # pool, selection, plan/quota records
lib/auth/                # OAuth + shared login helpers
lib/request/             # fetch rotation, billing, plan, rate-limit
lib/tui/app.ts           # OpenTUI manager
lib/tools/registry.ts    # agent tools
scripts/cli.ts           # op-xai CLI
scripts/install-cli.sh   # PATH install
scripts/install.ts       # OpenCode config installer
```

## Security

- OAuth tokens live only in `multi-xai-accounts.json` (keep file private, mode `600` recommended)
- Do not commit account files, API keys, or OpenCode global config with secrets
- Plugin refuses to attach bearer tokens to non-`api.x.ai` hosts

## License

MIT
