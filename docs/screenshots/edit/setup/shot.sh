#!/bin/bash
# shot.sh NAME [xdotool args...]: runs the xdotool step, waits, and captures the whole display.
export DISPLAY=:97
N=$1; shift
[ $# -gt 0 ] && xdotool "$@"
sleep ${WAIT:-1.5}
import -window root /tmp/hc-edit/shots/out/$N.png
