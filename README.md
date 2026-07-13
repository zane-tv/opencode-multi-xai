# opencode-multi-xai

OpenCode plugin that manages **multiple SuperGrok (xAI) OAuth accounts** under one provider (`xai-multi`), with automatic account rotation when quota is exhausted.

- SuperGrok OAuth (browser + device code)
- Sticky multi-account pool with safe rotation
- Uses `@ai-sdk/xai` (Responses API), same stack as OpenCode’s built-in `xai`
- Grok 4.5 thinking variants (`low` / `medium` / `high`)
- Quiet by default; model catalog network sync only after login

## Requirements

- [OpenCode](https://opencode.ai) (tested with 1.17.x)
- Node.js 18+ (or Bun)
- One or more SuperGrok-capable xAI accounts

## Install

### 1. Clone / link the plugin

```bash
git clone https://github.com/zane-tv/opencode-multi-xai.git
cd opencode-multi-xai
npm install   # or: bun install
```

Add the **package directory** to OpenCode config (`~/.config/opencode/opencode.json` or `opencode.jsonc`):

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

Or run the installer (writes provider + optional plugin entry):

```bash
bun scripts/install.ts
# optional:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

Restart OpenCode after config changes.

### 2. Login

```bash
opencode auth login
```

1. Choose provider **`xai-multi`**
2. Pick:
   - **SuperGrok OAuth (browser)** — loopback callback
   - **SuperGrok OAuth (device code)** — paste code on x.ai

Repeat login to add more accounts to the pool.

Account pool file (do not commit):

```text
~/.config/opencode/multi-xai-accounts.json
```

Model catalog cache (written after successful login):

```text
~/.config/opencode/multi-xai-models.json
```

## Usage

List models:

```bash
opencode models xai-multi
```

Run with Grok 4.5 + thinking effort:

```bash
opencode run --model xai-multi/grok-4.5 --variant high "your prompt"
```

In the TUI, select provider **Grok Multi-Account** / `xai-multi`, then a model and optional variant.

### Default chat models

| Model | Notes |
| --- | --- |
| `grok-4.5` | Reasoning; variants `low` / `medium` / `high` (default high on xAI) |
| `grok-4.3` | Reasoning; includes `none` |
| `grok-4.20-0309-reasoning` | Reasoning model; effort param not accepted |
| `grok-4.20-0309-non-reasoning` | Non-reasoning |
| `grok-4.20-multi-agent-0309` | Multi-agent; includes `xhigh` |
| `grok-build-0.1` | Build-oriented |

Imagine/image/video models are skipped by default.

## Account tools

Available as OpenCode tools while the plugin is loaded:

| Tool | Purpose |
| --- | --- |
| `xai-status` | Compact pool status |
| `xai-list` | List accounts |
| `xai-switch` | Sticky switch active account |
| `xai-enable` / `xai-disable` | Toggle account |
| `xai-remove` | Remove one account |
| `xai-label` / `xai-tag` / `xai-note` | Metadata |
| `xai-refresh` | Force token refresh |
| `xai-flag` / `xai-unflag` | Mark for prune |
| `xai-prune` | Remove dead/flagged accounts (**dry-run by default**) |

Prune safety:

- **Never** prunes mere “out of credits” / quota exhaustion (recoverable)
- Only prunes `subscriptionStatus === "dead"` or `flaggedForRemoval`
- Default: `dryRun=true` — pass `dryRun=false` to actually delete

## How rotation works

1. OpenCode calls `@ai-sdk/xai` with a dummy API key and custom `fetch`
2. `customFetch` picks a live account, sets `Authorization: Bearer …`
3. On recoverable failure (quota, transient, some auth cases), rotates to another account within the same request
4. Host-pin: bearer is only sent to `api.x.ai`

Quota / entitlement states are tracked per account; sticky selection prefers the last good account until it fails.

## Logging & model sync

| Behavior | Default |
| --- | --- |
| Logs | **Quiet** — only `warn` / `error` on stderr |
| Verbose logs | `MULTI_XAI_DEBUG=1` |
| models.dev fetch | **Only after successful OAuth login** |
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
index.ts              # package entry → PluginModule { id, server }
lib/plugin.ts         # OpenCode plugin (only default export)
lib/accounts.ts       # pool + selection
lib/request/fetch.ts  # rotation pipeline
lib/auth/             # OAuth browser + device code
lib/models-sync.ts    # catalog cache + variants
lib/tools/            # CLI tools registry
scripts/install.ts    # config installer
```

## Security notes

- OAuth tokens live only in `multi-xai-accounts.json` (mode should stay private)
- Do not commit account files, API keys, or OpenCode global config with secrets
- Plugin refuses to attach bearer tokens to non-`api.x.ai` hosts

## License

MIT
