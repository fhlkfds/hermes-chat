#!/bin/bash
# shot.sh <computer> <name>: a framebuffer capture of the Xvfb display.
DISPLAY=:97 import -window root /tmp/hc75/$1/out/$2.png
