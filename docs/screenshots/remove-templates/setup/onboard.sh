#!/bin/bash
# Onboarding (current Setup layout, 1280x820) against the throwaway dashboard on 127.0.0.2:19187.
export DISPLAY=:187
x(){ xdotool "$@"; sleep 0.8; }
x mousemove 828 566 click 1
x mousemove 759 433 click 1
x mousemove 640 460 click 1; xdotool key ctrl+a; xdotool type --delay 20 "http://127.0.0.2:19187"; sleep 0.3
x mousemove 849 664 click 1; sleep 1.5
x mousemove 640 412 click 1; xdotool type --delay 20 "fixture"
x mousemove 640 484 click 1; xdotool type --delay 20 "fixture-pass-123"
x mousemove 814 576 click 1; sleep 25
x mousemove 807 647 click 1; sleep 12
x mousemove 850 762 click 1; sleep 6
