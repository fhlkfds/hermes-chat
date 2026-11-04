#!/bin/bash
# Signs the app on :63 in to the throwaway dashboard by URL with its throwaway basic-auth login.
export DISPLAY=:63
x() { xdotool "$@"; sleep 0.6; }
O=/tmp/hc63/shots/out
x mousemove 828 566 click 1; sleep 0.5
x mousemove 759 380 click 1
x mousemove 640 407 click 1; xdotool type --delay 15 "http://127.0.0.2:19631"
x mousemove 849 611 click 1; sleep 1.5
import -window root $O/01-signin-a.png
x mousemove 640 412 click 1; xdotool type --delay 15 "fixture"
x mousemove 640 484 click 1; xdotool type --delay 15 "fixture-pass-63"
x mousemove 814 576 click 1; sleep 20
import -window root $O/01-signin-b.png
echo done
