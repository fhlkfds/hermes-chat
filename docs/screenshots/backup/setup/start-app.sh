#!/bin/bash
# Hermes Chat debug build of this branch under Xvfb, app data in /tmp/hc75/<computer>, on its own D-Bus session bus.
# $1: the computer (A or B). $2: "keep" to keep its data from an earlier run.
C=/tmp/hc75/$1; [ "$2" = keep ] || { rm -rf $C; }; mkdir -p $C/data $C/cache $C/config $C/out
pkill -f "^/tmp/hc75/hermes-chat" 2>/dev/null; sleep 1
pgrep -f "Xvfb :97" >/dev/null || { nohup Xvfb :97 -screen 0 1280x820x24 > /tmp/hc75/xvfb.log 2>&1 & sleep 1; }
export DISPLAY=:97 XDG_DATA_HOME=$C/data XDG_CACHE_HOME=$C/cache XDG_CONFIG_HOME=$C/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 HOME=$C
nohup dbus-run-session -- /tmp/hc75/hermes-chat > $C/app.log 2>&1 &
sleep 9
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $C/out/00-start.png; echo "window $W"
