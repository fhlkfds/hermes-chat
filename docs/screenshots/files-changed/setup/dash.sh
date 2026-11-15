#!/bin/bash
# Throwaway Hermes bf0203a dashboard on 127.0.0.2:26011 with the stub model on :26010 and checkpoints on.
# Fresh HOME and HERMES_HOME under /tmp/hermes601. Never the owner's ~/.hermes data.
set -u
W=$HOME/.cache/hermes-601; SETUP=$(dirname "$0"); T=/tmp/hermes601; SRC=$HOME/.cache/hermes-fleet-survey/trees/bf0203a
rm -rf $T; mkdir -p $T/home $T/fakehome $T/work
printf 'alpha original\n' > $T/work/a.txt; printf 'beta original\n' > $T/work/b.txt
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:26010/v1\n  api_key: "stub"\ncheckpoints:\n  enabled: %s\nterminal:\n  cwd: %s\n' "${CHECKPOINTS:-true}" "$T/work" > $T/home/config.yaml
setsid nohup $W/venv/bin/python $SETUP/stub_model.py 127.0.0.2 26010 > $T/stub.log 2>&1 < /dev/null & echo $! > $T/stub.pid
cd $T/work
setsid nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home TERMINAL_CWD=$T/work \
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 HERMES_DASHBOARD_BASIC_AUTH_SECRET=fixture-secret-0123456789abcdef \
  $W/venv/bin/python -m hermes_cli.main dashboard --port 26011 --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 < /dev/null & echo $! > $T/dash.pid
for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:26011/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:26011/api/status) dash=$(cat $T/dash.pid) stub=$(cat $T/stub.pid)"
