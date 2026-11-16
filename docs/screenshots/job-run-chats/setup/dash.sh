#!/bin/bash
# Throwaway Hermes v0.23.1 dashboard on 127.0.0.2:26311 with the stub model on :26310.
# Fresh HOME and HERMES_HOME under /tmp/hermes-jobrun. Never the owner's ~/.hermes data.
set -u
SRC=$HOME/.hermes/hermes-agent; PY=$SRC/venv/bin/python; SETUP=$(cd "$(dirname "$0")" && pwd); T=/tmp/hermes-jobrun
rm -rf $T; mkdir -p $T/home $T/fakehome $T/work
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:26310/v1\n  api_key: "stub"\nterminal:\n  cwd: %s\napprovals:\n  mode: off\n' "$T/work" > $T/home/config.yaml
setsid nohup $PY $SETUP/stub_model.py 127.0.0.2 26310 > $T/stub.log 2>&1 < /dev/null & echo $! > $T/stub.pid
cd $T/work
ENV="env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home TERMINAL_CWD=$T/work HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 HERMES_DASHBOARD_BASIC_AUTH_SECRET=fixture-secret-0123456789abcdef"
setsid nohup $ENV bash -c "$PY -m hermes_cli.main dashboard --port 26311 --host 127.0.0.2 --skip-build --no-open; echo EXIT=\$?" > $T/dash.log 2>&1 < /dev/null & echo $! > $T/dash.pid
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:26311/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:26311/api/status)"
