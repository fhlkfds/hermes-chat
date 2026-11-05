#!/bin/bash
# shots.sh NAME: Setup against the stand-in dashboard (bridge.ts on 127.0.0.2:19223), then the chat, then Outputs,
# for the 1280x820 window start-app.sh makes. Screenshots go to /tmp/hc223/out/NAME-*.png.
export DISPLAY=:223; O=/tmp/hc223/out/$1
x(){ xdotool "$@"; sleep 0.8; }
x mousemove 828 566 click 1                                     # Get started
x mousemove 473 461 click 1; x mousemove 432 491 click 1        # route: LAN
x mousemove 600 523 click 1; xdotool key ctrl+a; xdotool type --delay 20 "127.0.0.2:19223"; x key Tab
x mousemove 849 677 click 1                                     # Next
x mousemove 640 412 click 1; xdotool type --delay 20 liam
x mousemove 640 484 click 1; xdotool type --delay 20 fixture-pass-123
x mousemove 814 576 click 1; sleep 35                           # Test connection
x mousemove 807 647 click 1; sleep 3                            # Save and connect
x mousemove 850 643 click 1; sleep 4                            # Skip providers
x mousemove 160 180 click 1; sleep 2                            # Verify the skills installer
x mousemove 28 220 click 1; sleep 5                             # Outputs
x mousemove 800 600; sleep 1; import -window root $O-1-outputs.png
