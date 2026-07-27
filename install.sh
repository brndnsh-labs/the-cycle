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
SKILL_DIR="$HOME/.claude/skills"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

mkdir -p "$BIN_DIR" "$SKILL_DIR"

# Only cycle.mjs. The other files in bin/ are subcommand modules it imports on
# demand — on PATH they would look like commands and do nothing when run.
ln -sf "$CYCLE/bin/cycle.mjs" "$BIN_DIR/cycle"
echo "Linking the CLI into $BIN_DIR:"
echo "  cycle -> $CYCLE/bin/cycle.mjs"

echo
# The setup skills are PERSONAL, not per-repo: /cycle-setup has to be available in a
# repo that doesn't have the-cycle installed yet, which is the entire point of it.
# Symlinked so a `git pull` here updates them without re-running this script.
echo "Linking setup skills into $SKILL_DIR:"
for src in "$CYCLE"/skills/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    ln -sfn "${src%/}" "$SKILL_DIR/$name"
    echo "  /$name"
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
echo "Next: run /cycle-setup inside a repo (guided), or 'cycle install' for the"
echo "      seven-question version."
