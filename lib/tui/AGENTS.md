# lib/tui — OpenTUI account manager

**Parent:** root `AGENTS.md`. Uses `AccountManager` + `lib/auth/login` + request probes; does not own customFetch.

## OVERVIEW

Standalone terminal UI for the SuperGrok pool (`op-xai tui`). Single large module `app.ts` (~1.8k LOC). Palette: warm orange primary, purple accent (OpenCode-style).

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Entry | `app.ts` → `runTui(manager?)` |
| Status line helpers (tested) | `lib/tui-status.ts` (parent of this folder) |
| Strings | `lib/i18n.ts` |
| Datetime | `lib/format-time.ts` |

Default manager: `new AccountManager()` (CLI process — not plugin singleton).

## KEY BINDINGS

| Key | Action |
|-----|--------|
| `a` / `A` | Add device / browser OAuth |
| `Esc` | Cancel in-progress add (`AbortController`) |
| `[` `]` `{` | Priority up / down / top |
| `s` | Switch sticky active |
| `v` | Live quota on/off (~20s, parallel batches ×4) |
| `r` / `R` | Refresh quota one / all (all = parallel batches) |
| `l` `t` `n` | Edit label / tags / note |
| `e` / `d` | Enable / disable |
| `x` | Remove (confirm twice) |
| `p` | Prune (confirm) |
| `g` | Toggle lang en ↔ vi (persist settings) |
| `L` | Reload pool from disk |
| `Tab` | Focus accounts ↔ actions |
| `q` | Quit |

## CONVENTIONS

- Esc cancels add via `LoginCancelledError` — must not leave half-written UI state.
- Live quota suppressed while busy/editing; `refreshViews` has re-entry guard.
- Display: label → email → short id; no raw priority chips; no tokens in UI.
- Language: `g` or `op-xai tui --lang vi` saves `multi-xai-settings.json`; `MULTI_XAI_LANG` one-shot.

## ANTI-PATTERNS

- NEVER render access/refresh token values (status, detail, logs).
- NEVER call storage APIs bypassing `AccountManager`.
- NEVER assume tool prune criteria match TUI prune UX: TUI may surface dead / expired / 0% credits with confirm — tools stay dead | flagged only.
- NEVER re-enter `refreshViews` from selection handlers without the re-entry guard.

## NOTES

- No direct tests for `app.ts`; pure status helpers covered by `test/tui-status.test.ts`.
- Depends on `@opentui/core@0.4.3`.
- OAuth: prefer device code; browser uses loopback `127.0.0.1:56121`.
