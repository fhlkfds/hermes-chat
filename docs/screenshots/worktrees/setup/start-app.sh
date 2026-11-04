#!/bin/bash
# The real Hermes Chat debug build under Xvfb (:182), app data in throwaway folders, on its own D-Bus session bus.
# PATH puts /tmp/hc82/bin/ssh first: the system ssh with the app's own arguments plus `-F` for the throwaway sshd.
S=/tmp/hc82/shots; rm -rf $S/data $S/cache $S/config; mkdir -p $S/data $S/cache $S/config $S/out
setsid nohup Xvfb :182 -screen 0 1280x820x24 > $S/xvfb.log 2>&1 < /dev/null & echo $! > $S/xvfb.pid
sleep 1
export DISPLAY=:182 XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 PATH=/tmp/hc82/bin:$PATH
setsid nohup dbus-run-session -- /tmp/hc82/target/debug/hermes-chat > $S/app.log 2>&1 < /dev/null & echo $! > $S/app.pid
sleep 10
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0; sleep 1
import -window root $S/out/00-start.png; echo "window $W"
