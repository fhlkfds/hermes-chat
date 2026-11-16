#!/bin/bash
# Creates the "Nightly disk check" job on the throwaway dashboard from dash.sh, runs it twice, and marks the first run
# unread on the server, so the app can show that a run Hermes counts as unread stays out of its counts.
set -eu
B=http://127.0.0.2:26311; T=/tmp/hermes-jobrun; C=$T/cookies
curl -sf -c $C -H 'content-type: application/json' -d '{"provider":"basic","username":"fixture","password":"fixture-pass-123"}' $B/auth/password-login > /dev/null
JOB=$(curl -sf -b $C -H 'content-type: application/json' \
  -d '{"name":"Nightly disk check","prompt":"Check the disk usage on the server and say whether anything needs cleaning.","schedule":"0 3 * * *","deliver":"local"}' \
  "$B/api/cron/jobs?profile=default" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
for i in 1 2; do curl -sf -o /dev/null -b $C -X POST "$B/api/cron/jobs/$JOB/trigger?profile=default"; done
FIRST=$(curl -sf -b $C "$B/api/cron/jobs/$JOB/runs?profile=default&limit=5" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runs"][-1]["id"])')
REV=$(curl -sf -b $C "$B/api/sessions/$FIRST/mutation-snapshot?profile=default" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runtime_revision"])')
curl -sf -o /dev/null -b $C -X PATCH -H 'content-type: application/json' -d "{\"unread\":true,\"request_id\":\"run-job-unread\",\"expected_revision\":$REV}" "$B/api/sessions/$FIRST?profile=default"
curl -sf -b $C "$B/api/sessions?profile=default&sources=cron&limit=5" | python3 -c 'import json,sys; [print(r["id"], r["title"], "unread" if r["unread"] else "read") for r in json.load(sys.stdin)["sessions"]]'
