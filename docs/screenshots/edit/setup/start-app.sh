#!/bin/bash
# Real Hermes Chat debug build under Xvfb :97, app data in a throwaway folder, on its own D-Bus session bus.
S=/tmp/hc-edit/shots; rm -rf $S/data $S/cache $S/config; mkdir -p $S/data $S/cache $S/config $S/out
nohup Xvfb :97 -screen 0 1280x820x24 > $S/xvfb.log 2>&1 & echo $! > $S/xvfb.pid
sleep 1
export DISPLAY=:97 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
nohup dbus-run-session -- /tmp/hc-edit/target/debug/hermes-chat > $S/app.log 2>&1 & echo $! > $S/app.pid
sleep 10
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $S/out/00-start.png; echo "window $W"
