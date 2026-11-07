#!/usr/bin/env bash
# The app's CPU over N seconds (default 30): the Tauri process and its WebKit web, network and GPU processes on this
# run's display, as a percent of one core. Read-only: it reads /proc and kills nothing. Needs HV_RUN from `hv up`.
set -euo pipefail
. "$HV_RUN/state.env"
secs=${1:-30}
ours() {
  for d in /proc/[0-9]*; do
    comm=$(cat "$d/comm" 2>/dev/null) || continue
    case "$comm" in hermes-chat | WebKitWebProces | WebKitNetworkPr | WebKitGPUProces) ;; *) continue ;; esac
    tr '\0' '\n' <"$d/environ" 2>/dev/null | grep -qx "DISPLAY=$DISPLAY_NUM" && echo "${d#/proc/}"
  done
}
ticks() { local t=0; for p in $(ours); do set -- $(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null); t=$((t + ${12:-0} + ${13:-0})); done; echo $t; }
a=$(ticks)
sleep "$secs"
b=$(ticks)
hz=$(getconf CLK_TCK)
awk -v d=$((b - a)) -v hz="$hz" -v s="$secs" 'BEGIN { printf "%.1f%% of one core over %d s\n", d / hz / s * 100, s }'
