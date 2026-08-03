#!/usr/bin/env bash
# Install dsig (Linux and macOS). Windows users: run install.ps1 instead.
#
# Does the whole job from a bare machine: clones Vencord if you do not have it,
# installs its dependencies, copies the plugin in, builds, and points Vesktop at
# the build. Re-run it to update; it is safe to run repeatedly.
#
# Usage: ./install.sh [path-to-Vencord]
#   The path defaults to $VENCORD, then an existing ~/Documents/GitHub/Vencord,
#   then ~/.local/share/dsig/Vencord, which the script clones and maintains.
#
# Environment:
#   VENCORD=path      same as the argument
#   DSIG_NO_VESKTOP=1 build only; do not touch Vesktop's state.json

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
MANAGED_DEFAULT="$HOME/.local/share/dsig/Vencord"
LEGACY_DEFAULT="$HOME/Documents/GitHub/Vencord"
REPO_URL="https://github.com/Vendicated/Vencord.git"

# Written into checkouts this script created, so it can update them without
# ever running git in a tree the user maintains by hand.
MARKER=".dsig-managed"

if [ $# -gt 0 ]; then
    VENCORD="$1"
elif [ -n "${VENCORD:-}" ]; then
    :
elif [ -d "$LEGACY_DEFAULT/src" ]; then
    VENCORD="$LEGACY_DEFAULT"
else
    VENCORD="$MANAGED_DEFAULT"
fi

fail() { echo "install.sh: $*" >&2; exit 1; }
step() { echo "==> $*"; }

need() { command -v "$1" > /dev/null 2>&1; }

need git || fail "git is not on PATH; install git first"
need node || fail "node is not on PATH; install Node.js first"
if ! need pnpm; then
    # corepack ships with Node and can provide pnpm without a global install.
    need corepack || fail "pnpm is not on PATH; install it (npm i -g pnpm) or enable corepack"
    corepack enable pnpm > /dev/null 2>&1 || fail "pnpm is not on PATH and corepack could not enable it"
fi

# ── the Vencord checkout ──────────────────────────────────────────────────

if [ ! -d "$VENCORD/src" ]; then
    if [ -e "$VENCORD" ] && [ -n "$(ls -A "$VENCORD" 2>/dev/null)" ]; then
        fail "$VENCORD exists but is not a Vencord checkout; move it aside or pass another path"
    fi
    step "cloning Vencord into $VENCORD"
    mkdir -p "$(dirname "$VENCORD")"
    git clone --depth 1 "$REPO_URL" "$VENCORD" || fail "could not clone Vencord"
    : > "$VENCORD/$MARKER"
elif [ -f "$VENCORD/$MARKER" ]; then
    step "updating $VENCORD"
    # --ff-only: never invent a merge in a tree the user might look at.
    git -C "$VENCORD" pull --ff-only --depth 1 origin HEAD \
        || echo "install.sh: could not update Vencord; building the version already there" >&2
fi

step "installing Vencord's dependencies"
(cd "$VENCORD" && pnpm install --silent) || fail "pnpm install failed"

# ── the plugin ────────────────────────────────────────────────────────────

# A symlink would break esbuild's alias resolution (it resolves real paths),
# so the plugin is copied in. The .desktop suffix keeps it out of web builds.
TARGET="$VENCORD/src/userplugins/dsig.desktop"
step "copying the plugin into $TARGET"
rm -rf "$TARGET"
mkdir -p "$VENCORD/src/userplugins"
cp -R "$HERE/dsig.desktop" "$TARGET"

step "building Vencord"
(cd "$VENCORD" && CI=true pnpm build) || fail "pnpm build failed"

DIST="$VENCORD/dist"
# Vesktop requires a package.json alongside the four vencordDesktop* files.
[ -f "$DIST/package.json" ] || echo '{}' > "$DIST/package.json"

# ── point Vesktop at the build ────────────────────────────────────────────

# Vesktop reads state.json once at startup and writes it back on exit, so a
# running instance would overwrite whatever is set here.
vesktop_running() {
    pgrep -x vesktop > /dev/null 2>&1 || pgrep -f "[Vv]esktop" > /dev/null 2>&1
}

set_vencord_dir() {
    local state="$1"
    mkdir -p "$(dirname "$state")"
    if [ -f "$state" ]; then cp "$state" "$state.dsig-backup"; fi
    node -e '
        const fs = require("fs");
        const [path, dir] = process.argv.slice(1);
        let state = {};
        if (fs.existsSync(path)) {
            try { state = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); }
            catch { console.error("state.json is not valid JSON; leaving it alone"); process.exit(3); }
        }
        state.vencordDir = dir;
        fs.writeFileSync(path, JSON.stringify(state, null, 4));
    ' "$state" "$DIST"
}

FLATPAK_STATE="$HOME/.var/app/dev.vencord.Vesktop/config/vesktop/state.json"
STATES="$HOME/.config/vesktop/state.json
$FLATPAK_STATE
$HOME/Library/Application Support/vesktop/state.json"

WIRED=""
FLATPAK_WIRED=""
if [ -n "${DSIG_NO_VESKTOP:-}" ]; then
    :
elif vesktop_running; then
    echo "install.sh: Vesktop is running; close it and re-run to have it pointed at the build" >&2
else
    # read, not word splitting: the macOS path has a space in it.
    while IFS= read -r state; do
        # Only touch installs that exist: the config directory is created by
        # Vesktop itself, so its absence means that flavour is not installed.
        [ -d "$(dirname "$state")" ] || continue
        if set_vencord_dir "$state"; then
            WIRED="$WIRED$state
"
            if [ "$state" = "$FLATPAK_STATE" ]; then FLATPAK_WIRED=1; fi
        fi
    done <<< "$STATES"
fi

echo
echo "plugin  $TARGET"
echo "build   $DIST"
if [ -n "$WIRED" ]; then
    echo
    echo "Vesktop is now pointed at the build (previous state.json kept as *.dsig-backup):"
    printf '%s' "$WIRED" | sed '/^$/d; s/^/  /'
    if [ -n "$FLATPAK_WIRED" ]; then
        echo
        echo "Flatpak Vesktop is sandboxed and cannot read the build yet. Grant it access once:"
        echo "  flatpak override --user --filesystem=\"$DIST\" dev.vencord.Vesktop"
    fi
    echo "Start Vesktop, then enable Dsig in Settings -> Plugins."
else
    echo
    echo "Point your client at the build, then restart it:"
    echo "  Vesktop:          Settings -> Vencord Location -> $DIST"
    echo "  Discord Desktop:  cd \"$VENCORD\" && pnpm inject"
    echo "Then enable Dsig in Settings -> Plugins."
fi
