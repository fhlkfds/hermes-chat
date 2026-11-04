#!/bin/bash
# End-to-end run of webhooks/1 on a fresh throwaway Hermes (setup.sh; loopback, no credentials). Starts its own gateway
# and dashboard, and stops only the processes it started. The tasks fail: the throwaway profile has no model.
#   e2e.sh [HERMES_CHECKOUT]
HERE=$(cd "$(dirname "$0")" && pwd)
W=${W:-/tmp/hc-wh}
export HOOK_PORT=${HOOK_PORT:-18683} DASH_PORT=${DASH_PORT:-19083} W
P=${PY:-$HOME/.hermes/hermes-agent/venv/bin/python}
D=7b1c0a10-0000-4000-8000-0000000000
cd "$HERE" || exit 1
step() { echo; echo "### $*"; }
start_gateway() { setsid "$HERE/run.sh" gateway > "$W/gateway.log" 2>&1 & echo $! > "$W/gateway.pid"
  for _ in $(seq 1 60); do curl -s -m 2 -o /dev/null http://127.0.0.1:$HOOK_PORT/health && return; sleep 1; done; echo "gateway didn't start"; exit 1; }
# /health answers before the profile is served; until then Hermes answers 503 "retry this delivery" (nothing stored as run).
ready_gateway() { start_gateway; sleep 20; }
stop_gateway() { local pid; pid=$(cat "$W/gateway.pid"); kill -- -"$pid" 2>/dev/null
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done; echo "gateway didn't stop"; exit 1; }
"$HERE/setup.sh" "$@" || exit 1
if curl -s -m 2 -o /dev/null http://127.0.0.1:$HOOK_PORT/health || curl -s -m 2 -o /dev/null http://127.0.0.2:$DASH_PORT/; then
  echo "A throwaway Hermes is already running on $HOOK_PORT or $DASH_PORT; stop it first." >&2; exit 1
fi
setsid "$HERE/run.sh" dashboard > "$W/dash.log" 2>&1 & echo $! > "$W/dash.pid"
ready_gateway
for _ in $(seq 1 240); do curl -s -m 2 -o /dev/null http://127.0.0.2:$DASH_PORT/ && break; sleep 1; done  # the first start builds the web UI
trap 'stop_gateway; kill -- -"$(cat "$W/dash.pid")" 2>/dev/null' EXIT
send() { $P send.py --home "$W/home" "$@"; }
deliveries() { $P probe.py "GET /api/webhooks/triage/deliveries?profile=default" | grep -E '"(delivery_id|state|reason|outcome|duplicates|retry_of|retryable|retry_needs_confirmation|count|bad_signature|stale_timestamp|missing_delivery_id|too_large|rate_limited|paused|no_secret)"|^[A-Z]+ /|Error'; }
retry() { $P probe.py "POST /api/webhooks/triage/deliveries/${D}10/retry?profile=default {\"idempotency_key\":\"retry-key-0001\",\"confirm_side_effects\":$1}" | tr -d '\n' | sed 's/  */ /g'; echo; }

step "1. The server announces the contract"
$P probe.py "GET /api/webhooks?profile=default" | grep -E '"contract"|"providers"' -A1
step "2. Create a GitHub automation, paused, with a filter (action is opened)"
$P probe.py 'POST /api/webhooks?profile=default {"name":"triage","provider":"github","events":["issues"],"filters":[{"field":"action","equals":"opened"}],"prompt":"Triage #{issue.number}: {issue.title}","enabled":false,"create_only":true}' | grep -E '"(name|provider|enabled|secret_ref|revision|secret|filters)"'
step "3. A signed event while paused: refused, counted, not stored"
send triage issues ${D}01
step "4. Resume"
$P probe.py 'PUT /api/webhooks/triage/enabled?profile=default {"enabled":true}' | grep -E '"enabled"'
step "5. A signed event (GitHub's HMAC-SHA256 over the body)"
send triage issues ${D}10
step "6. The same event with a bad signature"
send triage issues ${D}11 --bad-signature
step "7. Duplicate id: the same delivery again (GitHub's redelivery)"
send triage issues ${D}10
step "8. Replay: the same signed body under a NEW delivery id (X-GitHub-Delivery is outside GitHub's signature)"
send triage issues ${D}12
step "9. Signed, but the filter doesn't match (action closed)"
send triage issues ${D}13 --action closed
step "10. Signed, but an event type the automation doesn't take"
send triage push ${D}14 --number 99
step "11. Oversized (2 MiB)"
$P -c 'import json; print(json.dumps({"action":"opened","pad":"x"*2_100_000}))' > "$W/big.json"
send triage issues ${D}15 --payload "$W/big.json"
step "12. A body-only generic signature on a GitHub automation"
send triage issues ${D}16 --scheme v1 --number 77
sleep 6
step "13. Delivery history (the task in 5 failed: no model in the throwaway profile)"
deliveries
step "14. Pause while that task's row is in the history, then a new signed event"
$P probe.py 'PUT /api/webhooks/triage/enabled?profile=default {"enabled":false}' | grep -E '"enabled"'
send triage issues ${D}18 --number 43
step "15. Retry while paused"
retry true
$P probe.py 'PUT /api/webhooks/triage/enabled?profile=default {"enabled":true}' | grep -E '"enabled"'
step "16. Retry the failed delivery without confirming (its run had started)"
retry false
step "17. Retry, confirmed"
retry true
step "18. The same retry again (its answer was lost): same key"
retry true
step "19. Restart the gateway, then the duplicate and the replay again"
stop_gateway; ready_gateway
send triage issues ${D}10
send triage issues ${D}17
sleep 4
step "20. History after"
deliveries
