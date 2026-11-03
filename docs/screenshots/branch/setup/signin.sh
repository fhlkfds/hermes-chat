#!/bin/bash
export DISPLAY=:98
x() { xdotool "$@"; sleep 0.6; }
x mousemove 828 566 click 1; sleep 0.5
x mousemove 759 380 click 1
x mousemove 640 407 click 1; xdotool type --delay 15 "http://127.0.0.2:19471"
x mousemove 849 611 click 1; sleep 1.5
x mousemove 640 412 click 1; xdotool type --delay 15 "fixture"
x mousemove 640 484 click 1; xdotool type --delay 15 "fixture-pass-123"
x mousemove 814 576 click 1; sleep 25
x mousemove 807 647 click 1; sleep 12
x mousemove 846 752 click 1; sleep 5
x mousemove 133 127 click 1; sleep 3
import -window root /tmp/hc-branch/shots/out/10.png; echo signed in
