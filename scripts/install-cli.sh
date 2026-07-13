#!/usr/bin/env bash
# Install the op-xai CLI into ~/.local/bin:
#   op-xai list
#   op-xai help
#   op-xai limits --probe
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/scripts/cli.ts"
BIN_DIR="${HOME}/.local/bin"
BUN_BIN="$(command -v bun || true)"

if [[ ! -x "$BUN_BIN" ]]; then
  echo "error: bun not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$CLI" ]]; then
  echo "error: missing $CLI" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

# Primary entry
cat >"$BIN_DIR/op-xai" <<EOF
#!/usr/bin/env bash
exec "$BUN_BIN" "$CLI" "\$@"
EOF
chmod +x "$BIN_DIR/op-xai"

# Optional aliases (same CLI)
for name in opencode-multi-xai xai-multi; do
  cat >"$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
exec "$BUN_BIN" "$CLI" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
done

# Remove legacy one-shot wrappers (xai-list, xai-add, ...) if present
LEGACY=(
  status list add limits quota health switch remove
  enable disable label tag note refresh flag unflag prune help
)
for cmd in "${LEGACY[@]}"; do
  rm -f "$BIN_DIR/xai-$cmd"
done

echo "Installed CLI into $BIN_DIR"
echo ""
echo "Try:"
echo "  op-xai tui"
echo "  op-xai help"
echo "  op-xai list"
echo "  op-xai status"
echo "  op-xai limits --probe"
echo "  op-xai health"
echo "  op-xai add"
echo ""
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo "NOTE: $BIN_DIR is not on PATH. Add to ~/.zshrc:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
