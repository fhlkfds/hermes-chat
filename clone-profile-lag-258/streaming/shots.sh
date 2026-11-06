#!/bin/bash
# PR screenshots: one session with a long reply streaming. Dark: Clone a profile ready, 20 real X keys typed, parts
# toggled, cloned; the search palette. Then Light: the dialog again.   shots.sh <target> <label>
set -uo pipefail
W=/home/liam/.t3/worktrees/hermes-chat/t3-f03c5e1a
S=$W/.claude/skills/verify-hermes-chat/scripts; WD=$S/wd.mjs
target=$1 label=$2
run=$(HV_LONG_REPLY=400 HV_TARGET=$target $S/hv up 2>&1 | sed -n 's/^export HV_RUN=//p'); export HV_RUN=$run
trap '$S/hv down >/dev/null 2>&1' EXIT
. $run/state.env
$W/bench/clone-profile/signin.sh >/dev/null || { echo signin failed; exit 1; }
$WD click button Settled >/dev/null; $WD click '.row-open[data-chat=backup]' >/dev/null; $WD wait .msg.assistant restic 30000 >/dev/null
$WD fill 'textarea[data-composer]' -- "long reply please" >/dev/null; $WD press Enter >/dev/null
$WD wait .msg.assistant "Step 6:" 60000 >/dev/null || echo "reply not streaming"
open() { $WD click .profile-btn >/dev/null; $WD wait button "Clone a profile…" 30000 >/dev/null; $WD click button "Clone a profile…" >/dev/null; $WD wait .clone-table "" 60000 >/dev/null; $WD gone .clone-loading "" 60000 >/dev/null; }
open
$WD shot $label-01-dialog-dark >/dev/null
$WD click input "New profile's name" >/dev/null; $WD press End >/dev/null
DISPLAY=$DISPLAY_NUM python3 -I $W/bench/clone-profile/xtype.py -team-release-notes 60 >/dev/null
$WD eval 'return new Promise((done) => { const t0 = Date.now(); const poll = () => (document.querySelector(".clone-dialog input:not([type])")?.value.length >= 30 || Date.now() - t0 > 30000 ? done(1) : setTimeout(poll, 20)); poll(); })' >/dev/null
echo "name: $($WD value input "New profile's name")"
$WD shot $label-02-typed-while-streaming >/dev/null
$WD click input "Copy Persona" >/dev/null; $WD click input "Copy Own skills" >/dev/null
echo "persona checked: $($WD eval 'return document.querySelector("input[aria-label=\"Copy Persona (SOUL.md)\"]")?.checked ?? "?"')"
$WD shot $label-03-toggled >/dev/null
$WD click button Clone >/dev/null
$WD wait .clone-dialog "Open default-copy-team-release-notes" 60000 >/dev/null || $WD wait .clone-dialog "default-copy-team-release-notes" 60000 >/dev/null
$WD shot $label-04-cloned >/dev/null
$WD press Escape >/dev/null; $WD gone .clone-dialog "" 30000 >/dev/null
$WD press Control+k >/dev/null; $WD wait '[role=dialog][aria-label="Search chats"]' "" 30000 >/dev/null
$WD keys restic >/dev/null; $WD wait .hit-row "" 30000 >/dev/null
$WD shot $label-05-palette-dark >/dev/null
$WD press Escape >/dev/null
$WD press Control+, >/dev/null
$WD click button Appearance >/dev/null && $WD click '[role=radio]' Light >/dev/null || $WD handles | head -40
$WD press Escape >/dev/null
open
$WD shot $label-06-dialog-light >/dev/null
echo "evidence $EVIDENCE"
