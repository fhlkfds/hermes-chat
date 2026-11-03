#!/bin/bash
# Drives the real Hermes Chat debug build under Xvfb against the fake dashboard (bridge.ts); writes PNGs to $S/out.
# Needs Xvfb, xdotool and ImageMagick. From the repo root:
#   npm run tauri -- build --debug --no-bundle
#   npx rolldown docs/screenshots/slash-commands/bridge.ts --platform node -o /tmp/slash-bridge.mjs
#   docs/screenshots/slash-commands/drive.sh
# App data goes to a throwaway folder and the app runs on its own D-Bus session bus, not your desktop's. On that bus
# the keyring save timed out here, and nothing was written to the login keyring; check yours before relying on it.
APP=${APP:-$(git rev-parse --show-toplevel)/src-tauri/target/debug/hermes-chat}
S=/tmp/slash-shots; rm -rf $S/data $S/cache $S/config $S/out; mkdir -p $S/data $S/cache $S/config $S/out
node /tmp/slash-bridge.mjs 47800 > /tmp/slash-bridge.log 2>&1 & BRIDGE=$!
export DISPLAY=:97 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
Xvfb :97 -screen 0 1280x820x24 >/dev/null 2>&1 & XV=$!
sleep 1
dbus-run-session -- $APP > $S/app.log 2>&1 & APPPID=$!
trap 'kill $BRIDGE $APPPID $XV 2>/dev/null' EXIT
sleep 8
x() { xdotool "$@"; sleep 0.45; }
shot() { sleep 0.7; import -window root $S/out/$1.png; }
clr() { x key ctrl+a; x key BackSpace; }
W=$(xdotool search --name "Hermes Chat" | head -1); x windowsize $W 1280 820 windowmove $W 0 0; sleep 1
x mousemove 739 292 click 1; sleep 0.8
x mousemove 640 308 click 1; x type --delay 15 "http://127.0.0.1:47800"
x mousemove 640 547 click 1; x type --delay 15 "demo"
x mousemove 640 619 click 1; x type --delay 15 "synthetic"; x key Return; sleep 32
x mousemove 155 127 click 1; sleep 1.5
x mousemove 800 708 click 1
x type "/"; shot 1-menu
x type "ren"; shot 2-filtered
x key Return; shot 3-filled-in
x type "Nightly restic backup"; x key Return; sleep 1.2; shot 4-renamed
x type "/help"; x key Return; x key Return; shot 5-help
x key Escape
x type "/context"; x key Return; x key Return; sleep 1; shot 6-context
x type "/delete"; x key Return; x key Return; shot 7-delete-confirm
x key Escape; shot 8-delete-cancelled
clr; x type "/steer skip the logs"; x key Return; shot 9-steer-unavailable
clr; x type "Run a restore test of /etc from last night"; x key Return; sleep 0.8
x type "/steer compare only the nginx folder"; x key Return; sleep 1; shot 10-steer-queued
curl -s localhost:47800/__finish >/dev/null; sleep 1
x type "/deploy"; shot 11-unknown-command
x key space; x type "the staging site"; x key Return; sleep 1; shot 12-unknown-sent
curl -s localhost:47800/__finish >/dev/null; sleep 0.5
x windowsize $W 760 820; sleep 1; x mousemove 400 708 click 1; x type "/"; shot 13-narrow
x key Escape; clr; x windowsize $W 1280 820; sleep 1
kill $BRIDGE; sleep 0.5
NO_CATALOG=1 node /tmp/slash-bridge.mjs 47800 > /tmp/slash-bridge2.log 2>&1 & BRIDGE=$!
sleep 7
x mousemove 155 127 click 1; sleep 1.5; x mousemove 800 708 click 1
x type "/cont"; shot 14-no-catalog
x key Return; x key Return; shot 15-no-catalog-run
ls $S/out
