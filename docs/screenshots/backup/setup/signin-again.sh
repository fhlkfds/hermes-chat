#!/bin/bash
# The isolated D-Bus session has no keyring, so after a restart the password is typed again on the sign-in screen.
export DISPLAY=:97
xdotool mousemove 640 603 click 1; sleep 0.4; xdotool type --delay 15 "fixture-pass-123"; sleep 0.3; xdotool key Return; sleep 8
