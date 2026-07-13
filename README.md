# opencode-multi-xai

OpenCode plugin for **multiple SuperGrok (xAI) OAuth accounts** under one provider (`xai-multi`): sticky rotation, plan/quota visibility, priority ordering, and a standalone **`op-xai`** CLI + OpenTUI manager.

| | |
| --- | --- |
| Provider ID | `xai-multi` |
| Auth | SuperGrok OAuth only (browser + device code) — **no raw token paste** |
| Runtime | `@ai-sdk/xai` (Responses API), same stack as OpenCode’s built-in `xai` |
| CLI | `op-xai` |
| UI language | English by default; Vietnamese via `--lang vi` / `g` in TUI |
| Repo | https://github.com/zane-tv/opencode-multi-xai |

## Features

- **Multi-account pool** with sticky active account and automatic rotation
- **Priority order** — list order is rotation preference (`[` `]` in TUI / `op-xai priority`)
- **OAuth add** from OpenCode, CLI, or TUI (device code recommended; **Esc** cancels)
- **Plan detection** (Lite / SuperGrok / Heavy, …) from JWT `tier` + monthly limit
- **Quota**
  - SuperGrok monthly credits % — `GetGrokCreditsConfig` ([opencode-bar](https://github.com/opgginc/opencode-bar)-style)
  - API remaining — `x-ratelimit-*` on `api.x.ai`
- **OpenTUI** (`op-xai tui`) — manage accounts, live quota, plan meters
- **i18n** — English default; Vietnamese datetime (`13/07/2026 22:30`, `5 phút trước`)
- Quiet logs; models.dev network sync only after successful login
- Host-pin: bearer tokens only sent to `api.x.ai`

## Requirements

- [OpenCode](https://opencode.ai) (tested with 1.17.x)
- Node.js 18+ or [Bun](https://bun.sh)
- One or more SuperGrok-capable xAI accounts

## Install

### Quick install (one command — no manual clone)

```bash
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-xai/main/install.sh | bash -s -- --path
```

Also useful:

```bash
# CLI only (no PATH rc edit)
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-xai/main/install.sh | bash

# + wire OpenCode plugin/provider
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-xai/main/install.sh | bash -s -- --path --with-plugin

# reinstall / update
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-xai/main/install.sh | bash -s -- --path --force
```

What it does:

1. Clones/updates the repo to `~/.local/share/opencode-multi-xai` (override with `MULTI_XAI_HOME`)
2. Installs dependencies
3. Installs **global CLI** shims into `~/.local/bin`
4. With `--path`, ensures `~/.local/bin` is on your shell PATH

Then **from any directory**:

```bash
op-xai tui
op-xai list
op-xai limits --probe
op-xai help
```

| Command | Same as |
| --- | --- |
| `op-xai` | primary |
| `opencode-multi-xai` | alias |
| `xai-multi` | alias |

Open a **new terminal** after `--path`, or `source ~/.zshrc`.

### Install from a local clone

```bash
git clone https://github.com/zane-tv/opencode-multi-xai.git
cd opencode-multi-xai
./install.sh --path
# or: npm run setup
```

```bash
npm run install-cli       # shims only
npm run install:global    # shims + PATH
```

### 2. Wire the plugin into OpenCode

`~/.config/opencode/opencode.json` or `opencode.jsonc`:

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

Or:

```bash
bun scripts/install.ts
# optional:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

Restart OpenCode after config changes.

### 3. Global CLI (if you skipped quick install)

```bash
./install.sh --path
# or:
bash scripts/install-cli.sh --path
npm run install:global
```

Shims → `~/.local/bin/op-xai` (+ aliases). Without global install:

```bash
bun scripts/cli.ts help
npm run cli -- list
```

> **`opencode xai-add` does not work** — OpenCode treats that as a project path. Use `op-xai …` or in-session agent tools.

## Add accounts

SuperGrok OAuth only.

```bash
op-xai tui                 # press a  (device OAuth; Esc cancels)
op-xai add                 # device code
op-xai add --browser       # loopback http://127.0.0.1:56121/callback
opencode auth login        # provider xai-multi → SuperGrok OAuth
```

Re-login of the same account **updates tokens** (upsert).

### Data files (do not commit)

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/multi-xai-accounts.json` | Pool + tokens (private) |
| `~/.config/opencode/multi-xai-models.json` | Model catalog cache |

## Chat usage

```bash
opencode models xai-multi
opencode run --model xai-multi/grok-4.5 --variant high "your prompt"
```

In OpenCode: provider **Grok Multi-Account** / `xai-multi`, then model + variant.

### Default models

| Model | Notes |
| --- | --- |
| `grok-4.5` | Reasoning; variants `low` / `medium` / `high` |
| `grok-4.3` | Reasoning; includes `none` |
| `grok-4.20-0309-reasoning` | Reasoning; no effort param |
| `grok-4.20-0309-non-reasoning` | Non-reasoning |
| `grok-4.20-multi-agent-0309` | Multi-agent; includes `xhigh` |
| `grok-build-0.1` | Build-oriented |

Image/video models are skipped by default.

## CLI (`op-xai`)

```text
op-xai help
op-xai tui [--lang en|vi]
op-xai status
op-xai list [--tag NAME]
op-xai add [--browser]
op-xai limits|quota [--probe]
op-xai health
op-xai switch --index N | --id PREFIX
op-xai priority --index N --direction up|down|top
op-xai priority --index N --priority N
op-xai enable|disable --index N | --id PREFIX
op-xai label --index N --label TEXT
op-xai tag --index N --tags a,b,c
op-xai note --index N --note TEXT
op-xai refresh --index N | --id PREFIX
op-xai flag|unflag --index N | --id PREFIX
op-xai remove --index N --confirm
op-xai prune [--tag NAME] [--execute]
```

Examples:

```bash
op-xai tui
op-xai tui --lang vi
op-xai list
op-xai limits --probe
op-xai priority --index 2 --direction up
op-xai switch --index 0
op-xai remove --index 1 --confirm
```

## OpenTUI (`op-xai tui`)

OpenCode-style palette (warm orange primary, purple accent).

| Key | Action |
| --- | --- |
| `a` | **Add account** (device OAuth) |
| `A` | Add account (browser) |
| `Esc` | **Cancel** in-progress add |
| `[` / `]` | Priority up / down (reorder list) |
| `{` | Priority top (front of queue) |
| `s` | Switch sticky active |
| `v` | Live quota on/off (default on; ~20s) |
| `r` / `R` | Refresh quota one / all |
| `l` / `t` / `n` | Edit label / tags / note |
| `e` / `d` | Enable / disable |
| `x` | Remove (confirm twice) |
| `p` | Prune dead / expired / 0% (confirm) |
| `g` | Toggle language en ↔ vi |
| `L` | Reload pool from disk |
| `Tab` | Focus accounts ↔ actions |
| `q` | Quit |

## Language & datetime

| | English (default) | Vietnamese |
| --- | --- | --- |
| Absolute | `13 Jul 2026 22:30` | `13/07/2026 22:30` |
| Past | `5m ago` | `5 phút trước` |
| Future | `in 2h · 13 Jul 2026 22:30` | `sau 2 giờ · 13/07/2026 22:30` |

```bash
op-xai tui                 # English
op-xai tui --lang vi
MULTI_XAI_LANG=vi op-xai tui
# In TUI: press g
```

## Priority & rotation

1. **Sticky** active account is drained while eligible  
2. On failure, scan **list order** (higher `priority` first)  
3. Reorder with TUI `[` `]` `{` or `op-xai priority`

```bash
op-xai priority --index 1 --direction top
op-xai priority --index 2 --priority 10
```

## Plan & quota

### Plan name

Best-effort merge of:

1. JWT claim `tier`
2. `GET https://cli-chat-proxy.grok.com/v1/billing` → `monthlyLimit` / `used`

Observed: SuperGrok **Heavy** often has JWT `tier=5` and `monthlyLimit ≈ 150000`. Labels prefer billing limit so Heavy is not mislabeled as plain SuperGrok.

### Monthly credits %

```
POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
```

gRPC-web empty frame + Bearer (opencode-bar family).

### API remaining

`x-ratelimit-*` from live `api.x.ai` traffic or probe.

```bash
op-xai limits --probe
```

## Agent tools (inside OpenCode)

| Tool | Purpose |
| --- | --- |
| `xai-status` | Compact pool line |
| `xai-list` | Accounts (+ optional `tag`) |
| `xai-limits` | Plan / credits % / rate limits (`probe=true`) |
| `xai-health` | Refresh-token health |
| `xai-switch` | Sticky active |
| `xai-priority` | Reorder / set priority |
| `xai-add` | How to add (points at CLI/TUI) |
| `xai-label` / `xai-tag` / `xai-note` | Metadata |
| `xai-enable` / `xai-disable` | Selection |
| `xai-refresh` | Force token refresh |
| `xai-remove` | Delete (`confirm=true`) |
| `xai-flag` / `xai-unflag` | Prune mark |
| `xai-prune` | Bulk dead/flagged (`dryRun` default true) |

### Prune safety

- Does **not** prune recoverable “out of credits” alone  
- Tool/CLI: dead and/or `flaggedForRemoval`; dry-run by default  
- TUI prune also covers expired / 0% credits with confirm  

## How rotation works

1. OpenCode calls `@ai-sdk/xai` with a dummy key + custom `fetch`  
2. `customFetch` picks a live account, sets `Authorization: Bearer …`  
3. On recoverable failure, rotates within the same request  
4. Bearer host-pinned to `api.x.ai`  

## Logging & model sync

| Behavior | Default |
| --- | --- |
| Logs | Quiet (`warn` / `error`) |
| Verbose | `MULTI_XAI_DEBUG=1` |
| models.dev | After successful OAuth only |
| Cold start models | Cache + bundled defaults |

```bash
MULTI_XAI_DEBUG=1 opencode models xai-multi
```

## Development

```bash
npm install
npm run typecheck
npm test
```

```text
index.ts                 # package entry → { id, server }
lib/plugin.ts            # OpenCode plugin (default export only)
lib/accounts.ts          # pool, selection, priority, plan/quota
lib/auth/                # OAuth + shared login (cancellable)
lib/request/             # fetch, billing, plan, rate-limit
lib/i18n.ts              # en/vi strings
lib/format-time.ts       # locale-aware datetime
lib/tui/app.ts           # OpenTUI manager
lib/tools/registry.ts    # agent tools
scripts/cli.ts           # op-xai
scripts/install-cli.sh   # PATH install
scripts/install.ts       # OpenCode config installer
```

## Security

- Tokens only in `multi-xai-accounts.json` (keep private, mode `600`)  
- Do not commit account files or secrets  
- No bearer to non-`api.x.ai` hosts  

## License

MIT
