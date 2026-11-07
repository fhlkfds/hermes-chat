#!/usr/bin/env bash
# Office HQ stage 1 (#281, ADR 0089) in the real headless app, against the verify skill's stand-in: a chat that
# delegates to two subagents, an Approval, a failed subagent, a stopped one, a stopped reply, and a disconnect. Takes
# the PR's screenshots and prints frame counts and CPU. Real input only: clicks and keys through WebDriver, and the
# camera's double-click and the hover through xdotool on the run's display. Needs HV_RUN from a fresh `hv up`.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
. "$HV_RUN/state.env"
out=${OUT:-$here/..}
shot() { $W shot "$out/$1.png" >/dev/null && echo "shot $1"; }
# Frames the building drew over `ms`, read from its counter.
frames() { $W eval "const b=document.querySelector('.bld');const a=+b.dataset.frames;return new Promise(r=>setTimeout(()=>r(+b.dataset.frames-a),$1))"; }
at() { $W eval "const r=document.querySelector('$1').getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height*${2:-0.5})].join(' ')" | tr -d '"'; }
xpoint() { set -- $(at "$1" "${2:-0.5}"); echo $((WX + $1)) $((WY + $2)); }
compose() { $W click 'textarea[data-composer]' >/dev/null && $W keys "$1" >/dev/null; }

"$here/signin.sh" >/dev/null
$W gone '*' "Couldn't save the password" 30000 >/dev/null || true
# The window's top left on the X screen, for xdotool.
read -r WX WY < <($S/hv x search --onlyvisible --class hermes getwindowgeometry | awk '/Position/ { split($2, p, ","); print p[1], p[2] }')

# 1. A chat that delegates to two subagents: three agents at work.
$W press Control+n >/dev/null
compose 'Please delegate the repo audit\n'
$W wait .row-open "delegate" 20000 >/dev/null
sleep 3
echo "CPU, office closed, three agents working: $("$here/cpu.sh" 30)"
$W click .office-btn >/dev/null
$W wait '.bld-agent[data-placed]' "" 20000 >/dev/null
sleep 2
echo "frames in 10 s, three typing: $(frames 10000)"
echo "CPU, office open, three typing: $("$here/cpu.sh" 30)"
shot 01-building-three-typing
set -- $(xpoint .room-workroom 4)
$S/hv x mousemove "$1" "$2" sleep 0.2 click --repeat 2 --delay 80 1
sleep 1
shot 02-workroom-team
set -- $(xpoint '.bld-agent[data-desk$="sa-2"]' 0.6)
$S/hv x mousemove "$1" "$2"
sleep 0.5
shot 03-hover-tag
$W click button "Read the tests, Running" >/dev/null
$W wait .bld-card "Has run" >/dev/null
sleep 1.2
shot 04-card
$W text .bld-card | tr '\n' ' '; echo
$W press Escape >/dev/null
# The character whose card closed is still placed and clickable.
$W eval 'return "after the card closed: "+(document.querySelector(".bld-agent[data-desk$=\"sa-2\"]").hasAttribute("data-placed")?"placed":"NOT placed")'
$W click button "Reset the view" >/dev/null

# 2. An Approval, a failed subagent and a stopped one.
$W press Escape >/dev/null
$W press Control+n >/dev/null
compose 'This needs approval to run\n'
$W wait .approval "" 20000 >/dev/null
curl -sf -X POST "$DASHBOARD_URL/__subagent?id=sa-1&status=failed" >/dev/null
$W click .row-open "delegate" >/dev/null
$W wait .chat-head "delegate" >/dev/null
$W click button "Subagents" >/dev/null
$W click button "RunningRead the tests" >/dev/null
$W click button "Stop it…" >/dev/null
$W click '.btn.danger:not([disabled])' "Stop it" >/dev/null
$W wait button "1 failed · 2 in all" 10000 >/dev/null
$W click .office-btn >/dev/null
$W wait '.bld-agent.state-stopped[data-placed]' "" 10000 >/dev/null
sleep 1
shot 05-every-room-dark
$W eval 'return [...document.querySelectorAll(".bld-agent")].map(b=>b.getAttribute("aria-label").split(".")[0]).join("\n")'

# 3. The reply stopped too: nothing moves, so nothing is drawn.
$W press Escape >/dev/null
$W click button.stop >/dev/null
$W gone button.stop 15000 >/dev/null
$W click .office-btn >/dev/null
$W wait '.bld-agent[data-placed]' "" 10000 >/dev/null
sleep 2
echo "frames in 10 s, nothing moving: $(frames 10000)"
$W press f >/dev/null
sleep 2.5
shot 06-nothing-moves-0-frames
$W text .bld-frames
echo "CPU, office open, nothing moving: $("$here/cpu.sh" 30)"
$W press f >/dev/null
$W press Escape >/dev/null
echo "CPU, office closed, nothing working: $("$here/cpu.sh" 30)"

# 4. Light mode, then List.
$W press 'Control+,' >/dev/null
$W click button Appearance >/dev/null
$W click 'button[role=radio]' Light >/dev/null
$W press Escape >/dev/null
$W click .office-btn >/dev/null
$W wait '.bld-agent[data-placed]' "" 10000 >/dev/null
sleep 1
shot 07-every-room-light
$W click button List >/dev/null
$W wait .office-list >/dev/null
shot 08-list-light
$W click button Building >/dev/null
$W wait '.bld-agent[data-placed]' "" 10000 >/dev/null
# Settings opens where it was left, on Appearance.
$W press Escape >/dev/null
$W press 'Control+,' >/dev/null
$W wait 'button[role=radio]' Dark 10000 >/dev/null || $W click button Appearance >/dev/null
$W click 'button[role=radio]' Dark >/dev/null
$W press Escape >/dev/null

# 5. A disconnect: everyone as last seen, greyed and frozen.
$W click .office-btn >/dev/null
$W wait '.bld-agent[data-placed]' "" 10000 >/dev/null
kill "$BRIDGE_PID"
$W wait .inbox-note "every agent is as last seen" 30000 >/dev/null
sleep 1
shot 09-disconnected-as-last-seen
$W eval 'return document.querySelectorAll(".bld-agent.is-stale").length+" of "+document.querySelectorAll(".bld-agent").length+" stale"'
