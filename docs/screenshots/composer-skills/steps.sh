x mousemove 830 568 click 1; sleep 0.8
x mousemove 758 435 click 1
x mousemove 640 473 click 1; xdotool key ctrl+a BackSpace; sleep 0.3; xdotool type --delay 80 "http://127.0.0.1:47810"; sleep 0.5
x mousemove 850 660 click 1; sleep 1.5
x mousemove 640 410 click 1; xdotool type --delay 60 "demo"
x mousemove 640 486 click 1; xdotool type --delay 60 "synthetic"; sleep 0.3
x mousemove 814 580 click 1; sleep 25
x mousemove 808 651 click 1; sleep 15
x mousemove 851 765 click 1; sleep 3
x mousemove 150 181 click 1; sleep 1.5
x mousemove 800 706 click 1
x type "/"; shot 1 after-1-slash-menu
x key Up; x key Up; shot 0.8 after-2-slash-menu-skills
x key Escape; x key ctrl+a; x key BackSpace
x type "Clear the stale lock using \$re"; shot 1 after-3-dollar-menu
x key Down; x key Return; shot 0.8 after-4-runs-with
x key Return; sleep 1.5; curl -s localhost:47810/__finish > /dev/null; sleep 1.5; shot 0.5 after-5-sent
x mousemove 800 706 click 1
x type "/help"; x key Return; x key Return; shot 1 after-6-help
touch /tmp/skshots/q/stop
