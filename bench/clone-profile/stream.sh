#!/bin/bash
# Times Clone a profile while a long reply streams in the chat behind it (probe.js): frame intervals with the dialog
# closed and open, each of 20 keys typed as real X key presses 60 ms apart from when it reached the X server to the
# frame that drew it, and each part checkbox click to its frame. Needs a signed-in app under the verify skill with
# $HV_RUN exported and a stand-in started with HV_LONG_REPLY set (compare.sh does both). Appends one JSON line per run.
#   bench/clone-profile/stream.sh <runs> <out.jsonl>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
. "$HV_RUN/state.env"
runs=${1:-5} out=${2:?out.jsonl}
reply() { $W eval 'return document.querySelector(".msg.assistant:last-of-type")?.innerText.length ?? 0'; }

$W click button Settled >/dev/null
$W click '.row-open[data-chat=backup]' >/dev/null
$W wait .msg.assistant restic 30000 >/dev/null
$W fill 'textarea[data-composer]' -- "long reply please" >/dev/null
$W press Enter >/dev/null
$W wait .msg.assistant "Step 2:" 30000 >/dev/null
$W eval "$(cat "$HERE/probe.js")" >/dev/null
for i in $(seq 1 "$runs"); do
  closed=$($W eval 'return window.__lag.frames(2500).then(JSON.stringify)')
  $W click .profile-btn >/dev/null
  $W wait button "Clone a profile…" 30000 >/dev/null
  $W click button "Clone a profile…" >/dev/null
  $W wait .clone-table "" 60000 >/dev/null
  $W gone .clone-loading "" 60000 >/dev/null
  open=$($W eval 'return window.__lag.frames(2500).then(JSON.stringify)')
  $W click input "New profile's name" >/dev/null
  $W press End >/dev/null
  start=$($W value input "New profile's name")
  before=$(reply)
  $W eval 'window.__lag.events = []; window.__lag.gaps = []; return 1' >/dev/null
  sent=$(DISPLAY=$DISPLAY_NUM python3 -I "$HERE/xtype.py" abcdefghijklmnopqrst 60)
  $W eval 'return new Promise((done) => { const t0 = Date.now(); const poll = () => (document.querySelector(".clone-dialog input:not([type])")?.value.length >= '"${#start}"' + 20 || Date.now() - t0 > 30000 ? done(1) : setTimeout(poll, 20)); poll(); })' >/dev/null
  for p in "Copy Persona" "Copy Own skills" "Copy Persona" "Copy Own skills"; do $W click input "$p" >/dev/null; done
  $W eval 'return new Promise((r) => setTimeout(() => r(1), 300))' >/dev/null
  after=$(reply)
  name=$($W value input "New profile's name")
  [ "$name" = "${start}abcdefghijklmnopqrst" ] || { echo "run $i: the name field holds \"$name\", not every key" >&2; exit 1; }
  [ "$after" -gt "$before" ] || { echo "run $i: the reply stopped streaming ($before -> $after characters)" >&2; exit 1; }
  json=$($W eval 'return JSON.stringify(window.__lag)')
  echo "{\"run\":$i,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"reply\":[$before,$after],\"sent\":$sent,\"closed\":$closed,\"open\":$open,\"lag\":$json}" >>"$out"
  $W press Escape >/dev/null
  $W gone .clone-dialog "" 30000 >/dev/null
done
