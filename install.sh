#!/usr/bin/env bash
# install.sh — put the `cycle` command on PATH.
#
# Idempotent: safe to re-run. Symlinks bin/cycle.mjs into ~/.local/bin as the bare
# command `cycle`, then checks that ~/.local/bin is actually on PATH. Deliberately
# does NOT edit your shell profile — a persistent PATH change is yours to make; the
# script prints the exact line if it's missing.
#
# Mirrors ~/code/dotfiles/install.sh on purpose: same convention, same guarantees.
set -euo pipefail

CYCLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

mkdir -p "$BIN_DIR"

echo "Linking bin/ tools into $BIN_DIR:"
for src in "$CYCLE"/bin/*; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    name="${name%.mjs}"          # cycle.mjs → cycle (bare command on PATH)
    name="${name%.sh}"
    ln -sf "$src" "$BIN_DIR/$name"
    echo "  $name -> $src"
done

echo
if printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
    echo "✓ $BIN_DIR is already on PATH."
else
    echo "⚠ $BIN_DIR is NOT on PATH. Add this line to your shell profile (e.g. ~/.zshrc):"
    echo
    echo "    $PATH_LINE"
fi

echo
echo "Next: run 'cycle install' inside a repo to render the pipeline into it."
