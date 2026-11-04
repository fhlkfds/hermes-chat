#!/bin/bash
# Runs the three Screen-tab scenarios against an app already showing the Screen tab, and saves each run.
#   run.sh APP_DISPLAY XVNC_DISPLAY LABEL OUT_DIR
# BENCH_SPOTS (from `x11bench.py locate`) must be set. Prints the load average with each run: a busy machine slows
# WebKitGTK's software rendering, so compare runs made at similar load.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
app=$1 xvnc=$2 label=$3 out=$4
mkdir -p "$out"
for scenario in ${SCENARIOS:-page small busy}; do
  load=$(cut -d' ' -f1 /proc/loadavg)
  python3 "$here/x11bench.py" run "$app" "$xvnc" "$scenario" "$out/$label-$scenario.json"
  echo "load $load $(python3 "$here/analyze.py" "$out/$label-$scenario.json")"
done
