#!/bin/bash
# x.sh click X Y | type TEXT | key K | shot NAME
export DISPLAY=:182
case "$1" in
  click) xdotool mousemove "$2" "$3" click 1; sleep "${4:-0.8}";;
  type) xdotool type --delay 12 "$2"; sleep 0.4;;
  key) xdotool key "$2"; sleep "${3:-0.6}";;
  shot) import -window root "/tmp/hc82/shots/out/$2.png";;
esac
