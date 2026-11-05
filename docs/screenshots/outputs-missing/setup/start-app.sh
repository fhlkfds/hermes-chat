#!/bin/bash
# start-app.sh BINARY: a Hermes Chat debug build under Xvfb :223, app data in a throwaway folder, on its own D-Bus bus
# with its own gnome-keyring, unlocked with a throwaway password. Stops only an earlier app this script started, by
# exact PID on this display.
S=/tmp/hc223
for p in $(pgrep -f "^/tmp/hc223/hermes-chat-"); do grep -qz "^DISPLAY=:223$" /proc/$p/environ 2>/dev/null && kill $p; done; sleep 1
rm -rf $S/data $S/cache $S/config; mkdir -p $S/data $S/cache $S/config $S/out
[ -e /tmp/.X11-unix/X223 ] || { setsid nohup Xvfb :223 -screen 0 1280x820x24 > $S/xvfb.log 2>&1 < /dev/null & sleep 1; }
export DISPLAY=:223 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 HERMES_CHAT_NEW_INSTANCE=1
setsid nohup dbus-run-session -- sh -c 'printf throwaway | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null; exec "$0"' "$1" > $S/app.log 2>&1 < /dev/null &
sleep 10
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $S/out/00-start.png; echo "window $W"
