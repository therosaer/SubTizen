#!/usr/bin/env bash
#
# package.sh - build a Tizen .wgt for Tizen 2.4 TVs.
#
# Prefers the official Tizen Studio CLI if present; otherwise falls back to
# a plain zip, which is what a .wgt actually is (a zip with config.xml at
# the root plus an author-signature.xml). The fallback produces a package
# suitable for sideloading in developer mode.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app"
DIST_DIR="$ROOT/dist"
OUT="$DIST_DIR/SubTizen.wgt"

TIZEN_CLI="${TIZEN_CLI:-$HOME/tizen-studio/tools/ide/bin/tizen}"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

if [ -x "$TIZEN_CLI" ]; then
    echo "==> Packaging with Tizen Studio CLI: $TIZEN_CLI"
    PROFILE="${TIZEN_PROFILE:-}"
    if [ -z "$PROFILE" ]; then
        echo "!! TIZEN_PROFILE is not set. Run: $TIZEN_CLI security-profiles list" >&2
        echo "!! Falling back to zip packaging." >&2
    else
        ( cd "$APP_DIR" && "$TIZEN_CLI" package -t wgt -s "$PROFILE" -o "$DIST_DIR" -- . )
        echo "==> Built $OUT"
        exit 0
    fi
fi

echo "==> Tizen Studio CLI not found; packaging as zip (sideload-ready)"
( cd "$APP_DIR" && zip -q -r -X "$OUT" . -x '.*' -x '*/.*' )
echo "==> Built $OUT"
unzip -l "$OUT" | tail -n +4 | head -n -2
