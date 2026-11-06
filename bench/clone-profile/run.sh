#!/bin/bash
# Times Clone a profile in the real app (probe.js): click to ready, each key of a 20-character name to its frame,
# each part checkbox to its frame, and the stand-in requests each step made (bridge.log). Needs a signed-in app under
# the verify skill (`hv up`, `wd.mjs open`, signin.sh) with $HV_RUN exported. Appends one JSON line per run.
#   bench/clone-profile/run.sh <runs> <out.jsonl>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
. "$HV_RUN/state.env"
runs=${1:-5} out=${2:?out.jsonl}
log=$EVIDENCE/bridge.log
lines() { wc -l <"$log"; }
api() { sed -n "$(($1 + 1)),$2p" "$log" | grep -c ' /api/' || true; }

$W eval "$(cat "$HERE/probe.js")" >/dev/null
for i in $(seq 1 "$runs"); do
  $W eval 'window.__lag.events = []; window.__lag.gaps = []; window.__lag.open = undefined; return 1' >/dev/null
  $W click .profile-btn >/dev/null
  $W wait button "Clone a profile…" >/dev/null
  a=$(lines)
  $W click button "Clone a profile…" >/dev/null
  $W wait .clone-table "" 30000 >/dev/null
  $W gone .clone-loading "" 30000 >/dev/null
  b=$(lines)
  $W click input "New profile's name" >/dev/null
  $W keys "abcdefghijklmnopqrst" >/dev/null
  c=$(lines)
  for p in "Copy Persona" "Copy Own skills" "Copy Persona" "Copy Own skills"; do $W click input "$p" >/dev/null; done
  d=$(lines)
  $W eval 'return new Promise((r) => setTimeout(() => r(1), 300))' >/dev/null
  e=$(lines)
  [ "$($W value input "New profile's name")" = "default-copyabcdefghijklmnopqrst" ] || { echo "run $i: the name field didn't get every key" >&2; exit 1; }
  json=$($W eval 'return JSON.stringify(window.__lag)')
  echo "{\"run\":$i,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"reqs\":{\"open\":$(api "$a" "$b"),\"typing\":$(api "$b" "$c"),\"toggles\":$(api "$c" "$d"),\"after\":$(api "$d" "$e")},\"lag\":$json}" >>"$out"
  $W press Escape >/dev/null
  $W gone .clone-dialog >/dev/null
done
