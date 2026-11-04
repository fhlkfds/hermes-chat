#!/bin/sh
# Regenerates every PNG/ICO/ICNS in src-tauri/icons/ from the SVG sources (issue #177, ADR 0049).
#
#   assets/icon.svg              the master: Tauri's suite, and hicolor 64-512
#   assets/icons/icon-<N>.svg    pixel-hinted sources for hicolor 16, 22, 24, 32 and 48 (and 32x32.png)
#   assets/icons/tray.svg        the tray icon, and tray-inbox.svg with the Inbox dot
#
# Every raster comes from `tauri icon` (the Tauri CLI's own SVG renderer), so no ImageMagick or Inkscape is needed.
# Run from anywhere: tools/icons/build.sh
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
icons=src-tauri/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Quiet unless it fails: the CLI logs every file it writes to stderr.
tauri_icon() { node_modules/.bin/tauri icon "$@" > "$tmp/log" 2>&1 || { cat "$tmp/log" >&2; exit 1; }; }

# Tauri's own suite: 32x32, 64x64, 128x128, 128x128@2x, icon.png (512), icon.ico, icon.icns.
tauri_icon assets/icon.svg -o "$tmp/suite"
for f in 32x32.png 64x64.png 128x128.png 128x128@2x.png icon.png icon.ico icon.icns; do
  cp "$tmp/suite/$f" "$icons/$f"
done

# The hicolor theme: hinted sources below 64px, the master from 64px up.
mkdir -p "$icons/hicolor"
for n in 16 22 24 32 48; do
  tauri_icon "assets/icons/icon-$n.svg" -o "$tmp/hinted" -p "$n"
  cp "$tmp/hinted/${n}x${n}.png" "$icons/hicolor/${n}x${n}.png"
done
tauri_icon assets/icon.svg -o "$tmp/big" -p 64 -p 128 -p 256 -p 512
for n in 64 128 256 512; do
  cp "$tmp/big/${n}x${n}.png" "$icons/hicolor/${n}x${n}.png"
done
# Tauri's 32x32.png gets the hinted render too: it's what a 32px slot shows.
cp "$icons/hicolor/32x32.png" "$icons/32x32.png"

# The tray: one 64px image each, which the panel scales to its own size.
for name in tray tray-inbox; do
  tauri_icon "assets/icons/$name.svg" -o "$tmp/$name" -p 64
  cp "$tmp/$name/64x64.png" "$icons/$name.png"
done

echo "Icons written to $icons/"
