#!/bin/bash
# Before/after for Clone a profile in the real app: alternates two builds, one fresh `hv up` and sign-in per session,
# so drift and the box's load fall on both sides alike. Each build is an `hv build` target (HV_TARGET).
# With STREAM=1 each session times the dialog while a long reply streams behind it (stream.sh) instead of run.sh.
#   bench/clone-profile/compare.sh <before target> <after target> <out dir> [sessions per side] [runs per session] [delay ms]
# Then: node bench/clone-profile/summary.mjs <out dir>/before.jsonl <out dir>/after.jsonl
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
before=$1 after=$2 out=$3 sessions=${4:-3} runs=${5:-5}
export HV_DELAY_MS=${6:-0}
script=run.sh
if [ "${STREAM:-0}" = 1 ]; then script=stream.sh; export HV_LONG_REPLY=400; fi
mkdir -p "$out"
for i in $(seq 1 "$sessions"); do
  for side in before after; do
    target=$before
    [ "$side" = after ] && target=$after
    run=$(HV_TARGET=$target "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
    [ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
    export HV_RUN=$run
    trap '"$S/hv" down >/dev/null 2>&1' EXIT
    echo "session $i $side: $(uptime | sed 's/.*load/load/') $run"
    "$HERE/signin.sh" >/dev/null
    "$HERE/$script" "$runs" "$out/$side.jsonl"
    cp "$(. "$run/state.env"; echo "$EVIDENCE")/bridge.log" "$out/bridge-$side-$i.log"
    "$S/hv" down >/dev/null 2>&1
    trap - EXIT
  done
done
