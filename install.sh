#!/usr/bin/env bash
# Quick install: deps + global op-xai CLI shortcuts.
#
# Usage:
#   ./install.sh
#   ./install.sh --path          # also append ~/.local/bin to shell rc
#   ./install.sh --with-plugin   # also wire OpenCode provider entry
#   curl -fsSL ... | bash        # if published; from clone just run ./install.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

WITH_PATH=0
WITH_PLUGIN=0
for arg in "$@"; do
  case "$arg" in
    --path|--fix-path) WITH_PATH=1 ;;
    --with-plugin|--plugin) WITH_PLUGIN=1 ;;
    -h|--help)
      cat <<'EOF'
opencode-multi-xai quick install

  ./install.sh              Install deps + global CLI (op-xai)
  ./install.sh --path       Also ensure ~/.local/bin is on PATH (shell rc)
  ./install.sh --with-plugin
                            Also write OpenCode provider/plugin config

After install, from any directory:
  op-xai tui
  op-xai list
  op-xai limits --probe
  op-xai help
EOF
      exit 0
      ;;
  esac
done

echo "==> opencode-multi-xai install"
echo "    root: $ROOT"
echo ""

# --- runtime ---
if command -v bun >/dev/null 2>&1; then
  RUNNER=bun
elif command -v npm >/dev/null 2>&1; then
  RUNNER=npm
else
  echo "error: need bun or npm on PATH" >&2
  exit 1
fi

# --- deps ---
if [[ ! -d node_modules ]]; then
  echo "==> installing dependencies ($RUNNER)"
  if [[ "$RUNNER" == "bun" ]]; then
    bun install
  else
    npm install
  fi
else
  echo "==> dependencies already present (node_modules)"
fi

# --- global CLI ---
echo "==> installing global CLI shortcuts → ~/.local/bin"
bash "$ROOT/scripts/install-cli.sh" ${WITH_PATH:+--path}

# --- optional OpenCode plugin wiring ---
if [[ "$WITH_PLUGIN" -eq 1 ]]; then
  echo ""
  echo "==> wiring OpenCode provider/plugin"
  if command -v bun >/dev/null 2>&1; then
    bun "$ROOT/scripts/install.ts" --with-plugin-entry || bun "$ROOT/scripts/install.ts"
  else
    echo "note: bun required for scripts/install.ts; skipped plugin wiring" >&2
  fi
fi

echo ""
echo "==> done"
echo ""
echo "Global commands (anywhere in terminal):"
echo "  op-xai tui"
echo "  op-xai list"
echo "  op-xai limits --probe"
echo "  op-xai add"
echo "  op-xai help"
echo ""
echo "Aliases: opencode-multi-xai · xai-multi"
echo ""
if ! command -v op-xai >/dev/null 2>&1; then
  echo "If 'op-xai' is not found, open a new terminal or run:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "Or re-run:  ./install.sh --path"
fi
