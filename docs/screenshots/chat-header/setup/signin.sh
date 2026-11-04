#!/bin/bash
# Onboarding against the throwaway dashboard from dash.sh, at the 1280 × 820 window's coordinates.
export DISPLAY=:173
x() { xdotool "$@"; sleep 0.8; }
x mousemove 828 566 click 1
x mousemove 759 380 click 1
x mousemove 640 407 click 1; xdotool key ctrl+a; xdotool type --delay 20 "http://127.0.0.2:19173"; sleep 0.3
x mousemove 849 611 click 1; sleep 1.5
x mousemove 640 412 click 1; xdotool type --delay 20 "fixture"
x mousemove 640 484 click 1; xdotool type --delay 20 "fixture-pass-123"
x mousemove 814 576 click 1; sleep 25
x mousemove 807 647 click 1; sleep 12
x mousemove 846 752 click 1; sleep 5
