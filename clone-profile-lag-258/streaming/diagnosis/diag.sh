#!/bin/bash
# Diagnosis only: one session, a long reply streaming into a short chat, Clone a profile… open. For each round, each
# variant's CSS is put in a <style id=__diag> (diagnosis only, no React-owned node is touched) and 2.5 s of rAF frame
# intervals are measured; per-thread CPU of this run's WebKitWebProcess is sampled over the same window.
#   diag.sh <target> <out.jsonl> <rounds> <label> <variant names...>
set -uo pipefail
W=/home/liam/.t3/worktrees/hermes-chat/t3-f03c5e1a
S=$W/.claude/skills/verify-hermes-chat/scripts; WD=$S/wd.mjs
HERE=$(cd "$(dirname "$0")" && pwd)
target=$1 out=$2 rounds=$3 label=$4; shift 4
variants=("$@")
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
blog=$HERE/bridge-$label.log
STRESS_TURNS=${STRESS_TURNS:-0} STRESS_PARAS=${STRESS_PARAS:-400} setsid node $HERE/bridge-stress.mjs $port $HERE/state-$label.json >$blog 2>&1 &
bpid=$!
trap '$S/hv down >/dev/null 2>&1; kill $bpid 2>/dev/null' EXIT
for i in $(seq 1 100); do grep -q "ready" $blog && break; sleep 0.2; done
run=$(HV_TARGET=$target $S/hv up --dashboard http://127.0.0.1:$port 2>&1 | sed -n 's/^export HV_RUN=//p'); export HV_RUN=$run
[ -n "$run" ] || { echo "hv up failed"; exit 1; }
. $run/state.env
$W/bench/clone-profile/signin.sh >/dev/null || { echo signin failed; exit 1; }
wp=""
for p in $(pgrep -f WebKitWebProcess); do tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -qx "DISPLAY=$DISPLAY_NUM" && wp=$p; done
echo "threads: $(cat /proc/$wp/task/*/comm | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
echo "env: $(tr '\0' '\n' </proc/$wp/environ | grep -E 'WEBKIT|GL|GSK|GDK' | tr '\n' ' ')"
echo "session $label display $DISPLAY_NUM webprocess $wp load $(cut -d' ' -f1 /proc/loadavg)"
$WD click button Settled >/dev/null; $WD click '.row-open[data-chat=backup]' >/dev/null; $WD wait .msg.assistant "restic" 60000 >/dev/null
$WD fill 'textarea[data-composer]' -- "long reply please" >/dev/null; $WD press Enter >/dev/null
$WD eval "$(cat $HERE/probe2.js)" >/dev/null
$WD eval 'return new Promise((r) => setTimeout(() => r(1), 3000))' >/dev/null
M='return new Promise((r) => { const xs = []; let last = performance.now(); const t0 = last; const f = (t) => { xs.push(t - last); last = t; if (t - t0 < 2500) requestAnimationFrame(f); else { xs.sort((a, b) => a - b); r(JSON.stringify({ n: xs.length, med: Math.round(xs[xs.length >> 1]), p90: Math.round(xs[Math.floor(xs.length * 0.9)]), max: Math.round(xs[xs.length - 1]), len: document.querySelector(".msg.assistant:last-of-type")?.innerText.length })); } }; requestAnimationFrame(f); })'
setcss() { $WD eval "let s = document.getElementById('__diag'); if (!s) { s = document.createElement('style'); s.id = '__diag'; document.head.appendChild(s); } s.textContent = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"); return 1" >/dev/null; }
css() {
  case $1 in
    open|closed) echo "" ;;
    nobackdrop) echo ".leave-overlay { background: transparent !important; }" ;;
    noshadow) echo ".leave-dialog { box-shadow: none !important; }" ;;
    nobackdrop-noshadow) echo ".leave-overlay { background: transparent !important; } .leave-dialog { box-shadow: none !important; }" ;;
    hidden) echo ".leave-overlay { visibility: hidden !important; }" ;;
    noradius) echo ".leave-dialog { border-radius: 0 !important; }" ;;
    noshadow-noborder) echo ".leave-dialog { box-shadow: none !important; border-color: transparent !important; border-width: 0 !important; }" ;;
    noshadow-nooverflow-noborder) echo ".leave-dialog { box-shadow: none !important; border-width: 0 !important; } .leave-overlay .leave-dialog.clone-dialog { overflow: visible !important; max-height: none !important; }" ;;
    all-flat) echo ".leave-dialog { box-shadow: none !important; border-radius: 0 !important; } .leave-overlay { background: transparent !important; }" ;;
    k1) echo ".leave-dialog { box-shadow: none !important; } .leave-overlay { overflow-y: auto; } .leave-overlay .leave-dialog.clone-dialog { overflow: visible !important; max-height: none !important; margin: auto; }" ;;
    r4) echo ".leave-dialog { box-shadow: none !important; border-radius: 4px !important; }" ;;
    r8) echo ".leave-dialog { box-shadow: none !important; border-radius: 8px !important; }" ;;
    k2) echo ".leave-dialog { box-shadow: none !important; border-width: 0 !important; } .leave-overlay { overflow-y: auto; } .leave-overlay .leave-dialog.clone-dialog { overflow: visible !important; max-height: none !important; margin: auto; }" ;;
    palette-flat) echo ".palette { box-shadow: none !important; border-radius: 0 !important; }" ;;
    noshadow-noradius) echo ".leave-dialog { box-shadow: none !important; border-radius: 0 !important; }" ;;
    noshadow-nooverflow) echo ".leave-dialog { box-shadow: none !important; } .leave-overlay .leave-dialog.clone-dialog { overflow: visible !important; max-height: none !important; }" ;;
    noshadow-willchange) echo ".leave-dialog { box-shadow: none !important; } .leave-overlay { will-change: transform; }" ;;
    nooverflow) echo ".leave-overlay .leave-dialog.clone-dialog { overflow: visible !important; max-height: none !important; }" ;;
    smallshadow) echo ".leave-dialog { box-shadow: 0 2px 8px rgba(0,0,0,.5) !important; }" ;;
    isolate) echo ".leave-overlay { isolation: isolate; contain: strict; }" ;;
    willchange) echo ".leave-overlay { will-change: transform; }" ;;
    dialogwill) echo ".leave-dialog { will-change: transform; }" ;;
    chatcontain) echo ".chat-pane, .messages, .chat-scroll { contain: strict; }" ;;
    *) echo "$1" ;;
  esac
}
cpu() {
  # per-thread CPU jiffies of the web process, summed by thread name
  for t in /proc/$wp/task/*; do echo "$(cat $t/comm 2>/dev/null | tr ' ' _)/${t##*/} $(awk '{print $14+$15}' $t/stat 2>/dev/null)"; done | sort
}
isopen=0
for i in $(seq 1 "$rounds"); do
  for v in "${variants[@]}"; do
    if [ "$v" = closed ] && [ $isopen = 1 ] && [ -n "${PALETTE:-}" ]; then setcss ""; $WD click input "Words to search for" >/dev/null; $WD press Escape >/dev/null; $WD gone '[role=dialog][aria-label="Search chats"]' "" 30000 >/dev/null; isopen=0; fi
    if [ "$v" = closed ] && [ $isopen = 1 ]; then setcss ""; $WD click input "New profile's name" >/dev/null; $WD press Escape >/dev/null; $WD gone .clone-dialog "" 30000 >/dev/null; isopen=0; fi
    if [ "$v" != closed ] && [ $isopen = 0 ] && [ -n "${PALETTE:-}" ]; then
      $WD press Control+k >/dev/null; $WD wait '[role=dialog][aria-label="Search chats"]' "" 30000 >/dev/null; isopen=1
    fi
    if [ "$v" != closed ] && [ $isopen = 0 ]; then
      $WD click .profile-btn >/dev/null; $WD wait button "Clone a profile…" 30000 >/dev/null; $WD click button "Clone a profile…" >/dev/null
      $WD wait .clone-table "" 60000 >/dev/null; $WD gone .clone-loading "" 60000 >/dev/null; isopen=1
    fi
    setcss "$(css "$v")"
    c0=$(cpu)
    f=$($WD eval "$M")
    c1=$(cpu)
    th=$(join -a1 -e0 -o 0,1.2,2.2 <(echo "$c0") <(echo "$c1") | awk '{d=$3-$2; if (d>5) printf "%s%s:%d", (n++?",":""), $1, d}')
    keys=null
    if [ -n "${KEYS:-}" ] && [ "$v" != closed ]; then
      $WD fill input "New profile's name" -- n >/dev/null; $WD press End >/dev/null
      n0=$($WD eval 'return document.querySelector(".clone-dialog input:not([type])").value.length')
      $WD eval 'window.__v.inputs = []; window.__v.toggles = []; return 1' >/dev/null
      sent=$(DISPLAY=$DISPLAY_NUM python3 -I $HERE/xtype.py abcdefghijklmnopqrst 60)
      $WD eval "return new Promise((r) => { const t0 = Date.now(); const p = () => (document.querySelector('.clone-dialog input:not([type])')?.value.length >= $n0 + 20 || Date.now() - t0 > 30000 ? r(1) : setTimeout(p, 20)); p(); })" >/dev/null
      for p in "Copy Persona" "Copy Own skills" "Copy Persona" "Copy Own skills"; do $WD click input "$p" >/dev/null; done
      $WD eval 'return new Promise((r) => setTimeout(() => r(1), 300))' >/dev/null
      keys="{\"sent\":$sent,\"v\":$($WD eval 'return JSON.stringify({inputs: window.__v.inputs, toggles: window.__v.toggles})')}"
    fi
    echo "{\"label\":\"$label\",\"round\":$i,\"variant\":\"$v\",\"load\":\"$(cut -d' ' -f1 /proc/loadavg)\",\"frames\":$f,\"cpu\":\"$th\",\"keys\":$keys}" >> $out
    echo "$label $i $v load $(cut -d' ' -f1 /proc/loadavg) frames $f cpu $th $(python3 -I $HERE/keysum.py "$keys")"
  done
done
[ -n "${SHOT:-}" ] && $WD shot "diag-$label" >/dev/null
echo "evidence $EVIDENCE"
