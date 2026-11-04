#!/bin/bash
# x.sh <name> <xdotool args...>: runs xdotool on :63, waits, takes a screenshot named <name>.
export DISPLAY=:63
N=$1; shift
if [ $# -gt 0 ]; then xdotool "$@"; fi
sleep ${WAIT:-1}
import -window root /tmp/hc63/shots/out/$N.png && echo shot $N
