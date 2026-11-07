#!/usr/bin/env bash
# cpu.sh <seconds> [samples]: the app's CPU use over <seconds>, as a percentage of one core, `samples` times in a row.
# Counts every process on this run's display that the app started (the app and its WebKit web, network and GPU
# processes), and leaves out the harness's own (openbox, tauri-driver, WebKitWebDriver) and Xvfb, which has no DISPLAY.
# Reads $HV_RUN like the other commands. Prints one line per sample, then each process's share of the last one.
# HV_MATCH=<VAR=value> counts the processes with that variable in their environment instead, for an app started some
# other way (on a real desktop, where DISPLAY would match every app on it).
set -euo pipefail
secs=${1:?usage: cpu.sh <seconds> [samples]}
samples=${2:-1}
[ -n "${HV_RUN:-}" ] && [ -f "$HV_RUN/state.env" ] || { echo "cpu.sh: HV_RUN is unset or has no state.env" >&2; exit 1; }
# shellcheck disable=SC1091
. "$HV_RUN/state.env"
hz=$(getconf CLK_TCK)

pids() {
  local p comm
  for p in /proc/[0-9]*; do
    p=${p#/proc/}
    grep -qz "^${HV_MATCH:-DISPLAY=$DISPLAY_NUM}$" "/proc/$p/environ" 2>/dev/null || continue
    comm=$(cat "/proc/$p/comm" 2>/dev/null) || continue
    case $comm in openbox | tauri-driver | WebKitWebDriver | bash | sh | zsh) continue ;; esac
    echo "$p"
  done
}
# utime + stime in clock ticks, fields 14 and 15 of /proc/<pid>/stat (after the parenthesised name).
ticks() { awk '{ sub(/^.*\) /, ""); print $12 + $13 }' "/proc/$1/stat" 2>/dev/null || echo 0; }

for ((i = 1; i <= samples; i++)); do
  declare -A before=() names=()
  for p in $(pids); do before[$p]=$(ticks "$p"); names[$p]=$(cat "/proc/$p/comm" 2>/dev/null || echo "?"); done
  sleep "$secs"
  total=0
  detail=""
  for p in "${!before[@]}"; do
    d=$(($(ticks "$p") - ${before[$p]}))
    total=$((total + d))
    detail+="$(awk -v d="$d" -v hz="$hz" -v s="$secs" 'BEGIN { printf "%.1f", 100 * d / hz / s }')% ${names[$p]} ($p)"$'\n'
  done
  awk -v t="$total" -v hz="$hz" -v s="$secs" -v i="$i" 'BEGIN { printf "sample %d: %.1f%% of one core over %ss\n", i, 100 * t / hz / s, s }'
  unset before names
done
printf '%s' "$detail" | sort -rn
