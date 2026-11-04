#!/bin/bash
# pick.sh <path>: from Settings → General scrolled to Backup, open Restore…, Choose backup…, and open <path> in the
# GTK Open dialog (pasted, since its completion rewrites typed paths).
export DISPLAY=:97
xdotool mousemove 1099 657 click 1; sleep 1.2
xdotool mousemove 907 451 click 1; sleep 2.5
W=$(xdotool search --name "Restore a backup" | head -1); xdotool windowfocus --sync $W 2>/dev/null; sleep 0.3
printf %s "$1" | xclip -selection clipboard >/dev/null 2>&1; xdotool key ctrl+l; sleep 0.4; xdotool key ctrl+a ctrl+v; sleep 0.6
xdotool key Return; sleep 3
