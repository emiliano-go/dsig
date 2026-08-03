#!/usr/bin/env bash
# Copy dsig into a Vencord checkout and rebuild it (Linux and macOS).
# Windows users: run install.ps1 instead.
#
# Vesktop is pointed at VENCORD/dist via its "Vencord Location" setting
# (state.json -> vencordDir), so a rebuild is all that is needed to pick up
# plugin changes; restart Vesktop afterwards.
#
# Usage: ./install.sh [path-to-Vencord]
#   The path defaults to $VENCORD, then ~/Documents/GitHub/Vencord.

set -eu

VENCORD="${1:-${VENCORD:-$HOME/Documents/GitHub/Vencord}}"
HERE="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "install.sh: $*" >&2; exit 1; }

[ -d "$VENCORD/src" ] || fail "not a Vencord checkout: $VENCORD
clone it first:  git clone https://github.com/Vendicated/Vencord.git \"$VENCORD\""

command -v node > /dev/null 2>&1 || fail "node is not on PATH; install Node.js first"
if ! command -v pnpm > /dev/null 2>&1; then
    # corepack ships with Node and can provide pnpm without a global install.
    command -v corepack > /dev/null 2>&1 || fail "pnpm is not on PATH; install it (npm i -g pnpm) or enable corepack"
    corepack enable pnpm > /dev/null 2>&1 || fail "pnpm is not on PATH and corepack could not enable it"
fi

[ -d "$VENCORD/node_modules" ] || (cd "$VENCORD" && pnpm install)

# A symlink would break esbuild's alias resolution (it resolves real paths),
# so the plugin is copied in.
rm -rf "$VENCORD/src/userplugins/dsig"
mkdir -p "$VENCORD/src/userplugins"
cp -R "$HERE/plugin" "$VENCORD/src/userplugins/dsig"

cd "$VENCORD"
CI=true pnpm build

# Vesktop requires a package.json alongside the four vencordDesktop* files.
[ -f dist/package.json ] || echo '{}' > dist/package.json

echo
echo "installed into $VENCORD/src/userplugins/dsig"
echo "built to       $VENCORD/dist"
echo
echo "Point your client at the build (once), then restart it:"
echo "  Vesktop:           Settings -> Vencord Location -> $VENCORD/dist"
echo "    (native install:  ~/.config/vesktop/state.json)"
echo "    (Flatpak:         ~/.var/app/dev.vencord.Vesktop/config/vesktop/state.json)"
echo "  Discord Desktop:   cd \"$VENCORD\" && pnpm inject"
