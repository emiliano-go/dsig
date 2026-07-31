#!/usr/bin/env bash
# Copy dsig into a Vencord checkout and rebuild it.
#
# Vesktop is pointed at VENCORD/dist via its "Vencord Location" setting
# (state.json -> vencordDir), so a rebuild is all that is needed to pick up
# plugin changes; restart Vesktop afterwards.
#
# Usage: ./install.sh [path-to-Vencord]

set -euo pipefail

VENCORD="${1:-$HOME/Documents/GitHub/Vencord}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$VENCORD/src" ] || { echo "not a Vencord checkout: $VENCORD" >&2; exit 1; }

# A symlink would break esbuild's alias resolution (it resolves real paths),
# so the plugin is copied in.
rm -rf "$VENCORD/src/userplugins/dsig"
mkdir -p "$VENCORD/src/userplugins"
cp -r "$HERE/plugin" "$VENCORD/src/userplugins/dsig"

cd "$VENCORD"
CI=true pnpm build

# Vesktop requires a package.json alongside the four vencordDesktop* files.
[ -f dist/package.json ] || echo '{}' > dist/package.json

echo
echo "installed into $VENCORD/src/userplugins/dsig"
echo "built to      $VENCORD/dist"
echo "restart Vesktop to load it."
