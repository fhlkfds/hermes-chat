#!/bin/bash
# start-app.sh BINARY: the Hermes Chat debug build under Xvfb :191, app data in a throwaway folder, on its own D-Bus
# bus with its own gnome-keyring, unlocked with a throwaway password and kept in the throwaway folder. The build loads
# its frontend from the Vite dev server on 1420.
S=/tmp/hc191; pkill -f "^/tmp/hermes-chat-(before|after)-191"; sleep 1; rm -rf $S/data $S/cache $S/config; mkdir -p $S/data $S/cache $S/config $S/out
pgrep -f "Xvfb :191" >/dev/null || { setsid nohup Xvfb :191 -screen 0 1280x820x24 > $S/xvfb.log 2>&1 & sleep 1; }
export DISPLAY=:191 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 HERMES_CHAT_NEW_INSTANCE=1
setsid nohup dbus-run-session -- sh -c 'printf throwaway | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null; exec "$0"' "$1" > $S/app.log 2>&1 &
sleep 10
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $S/out/00-start.png; echo "window $W"
