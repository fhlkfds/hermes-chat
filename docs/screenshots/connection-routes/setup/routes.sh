#!/bin/bash
# routes.sh: first-run Setup with four routes, against the stand-in dashboards (bridge.ts) on 127.0.0.2 and 127.0.0.3.
# Route 1 and 2 go nowhere (they time out), route 3 is the stand-in, route 4 is an SSH host that doesn't resolve.
# Coordinates are for the 1280x820 window that start-app.sh makes.
export DISPLAY=:191
x(){ xdotool "$@"; sleep 0.7; }
x mousemove 830 568 click 1                                   # Get started
x mousemove 640 301 click 1; xdotool type --delay 15 "Home server"
x mousemove 475 463 click 1; x mousemove 432 494 click 1      # route 1: LAN
x mousemove 600 526 click 1; xdotool key ctrl+a; xdotool type --delay 15 "192.168.77.10:9119"; x key Tab
x mousemove 457 619 click 1                                   # Add a route (Tailscale)
x mousemove 600 590 click 1; xdotool type --delay 15 "100.101.102.103"; x key Tab
x mousemove 457 705 click 1                                   # Add a route (SSH)
x mousemove 600 746 click 1; xdotool type --delay 15 "liam@hermes-box"
x mousemove 640 600 click 5 click 5 click 5 click 5 click 5
x mousemove 457 720 click 1                                   # Add a route, made LAN
x mousemove 640 600 click 5 click 5 click 5 click 5 click 5
x mousemove 503 585 click 1; x mousemove 461 616 click 1
x mousemove 600 627 click 1; xdotool type --delay 15 "127.0.0.2:19191"; x key Tab
x mousemove 747 585 click 1                                   # move it up, above SSH
