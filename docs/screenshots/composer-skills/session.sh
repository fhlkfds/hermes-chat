#!/bin/bash
# How the screenshots were driven: session.sh starts the bridge, Xvfb and the app, then runs these steps (README.md).
# session.sh <app> <display>: bridge, Xvfb and app in one process tree; then runs /tmp/skshots/q/<n>.sh in order as
# they appear, each with DISPLAY set, until q/stop exists or 15 minutes pass.
APP=$1; D=$2; S=/tmp/skshots/run$D; Q=/tmp/skshots/q
rm -rf $S $Q; mkdir -p $S/data $S/cache $S/config $Q
node /tmp/skills-bridge.mjs 47810 > $S/bridge.log 2>&1 & B=$!
Xvfb :$D -screen 0 1280x820x24 > /dev/null 2>&1 & XV=$!
sleep 1
export DISPLAY=:$D XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_CONFIG_HOME=$S/config WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11
dbus-run-session -- $APP > $S/app.log 2>&1 & A=$!
trap 'kill $B $A $XV 2>/dev/null' EXIT
sleep 8
W=$(xdotool search --name "Hermes Chat" | head -1); xdotool windowsize $W 1280 820 windowmove $W 0 0
x() { xdotool "$@"; sleep 0.45; }
shot() { sleep ${1:-0.8}; import -window root -crop 1280x820+0+0 /tmp/skshots/out/$2.png; }
n=1; end=$((SECONDS+900))
while [ $SECONDS -lt $end ] && [ ! -e $Q/stop ]; do
  if [ -e $Q/$n.sh ]; then source $Q/$n.sh > $Q/$n.log 2>&1; touch $Q/$n.done; n=$((n+1)); else sleep 0.3; fi
done
