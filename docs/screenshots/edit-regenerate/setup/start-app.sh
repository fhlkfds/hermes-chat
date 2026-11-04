#!/bin/bash
# The real Hermes Chat debug build under Xvfb :63, app data in a throwaway folder, on its own D-Bus session bus.
S=/tmp/hc63/shots; rm -rf $S/data $S/cache $S/config; mkdir -p $S/data $S/cache $S/config $S/out
[ -f $S/xvfb.pid ] && kill $(cat $S/xvfb.pid) 2>/dev/null; [ -f $S/app.pid ] && kill $(cat $S/app.pid) 2>/dev/null; sleep 0.5
nohup Xvfb :63 -screen 0 1280x820x24 > $S/xvfb.log 2>&1 & echo $! > $S/xvfb.pid
sleep 1
export DISPLAY=:63 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
nohup dbus-run-session -- /tmp/hc63/target/debug/hermes-chat > $S/app.log 2>&1 & echo $! > $S/app.pid
sleep 9
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $S/out/00-start.png; echo "window $W"
