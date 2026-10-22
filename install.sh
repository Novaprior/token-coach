#!/usr/bin/env bash
# Installs Token-Coach in Claude Code for good (macOS and Linux).
# Running it again updates it. Usage: bash install.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

claude="$(command -v claude || true)"
if [ -z "$claude" ]; then
  # The desktop app ships Claude Code but does not put it on the PATH.
  for base in "$HOME/Library/Application Support" "$HOME/.local/share" "$HOME/.claude"; do
    [ -d "$base" ] || continue
    found="$(find "$base" -path '*claude-code*' -name claude -type f -perm -u+x 2>/dev/null | sort -r | head -n 1)"
    if [ -n "$found" ]; then claude="$found"; break; fi
  done
fi
if [ -z "$claude" ]; then
  echo 'Claude Code was not found. Please install the Claude desktop app or Claude Code first.'
  exit 1
fi

if "$claude" plugin marketplace list 2>/dev/null | grep -q novaprior; then
  "$claude" plugin marketplace update novaprior
else
  "$claude" plugin marketplace add "$here"
fi
if "$claude" plugin list 2>/dev/null | grep -q 'token-coach@novaprior'; then
  "$claude" plugin update token-coach@novaprior
else
  "$claude" plugin install token-coach@novaprior
fi

echo
echo 'Done. Open a new session in Claude; /token-coach opens the panel.'
