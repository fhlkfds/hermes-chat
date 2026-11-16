#!/bin/bash
# Throwaway Hermes bf0203a dashboard on 127.0.0.2:26511, with the priced stub model on :26510.
# Fresh HOME and HERMES_HOME under /tmp/hermes605. Never the owner's ~/.hermes data. The venv is the one #601 built
# from the bf0203a tree (`uv sync --frozen --extra web --python 3.14`).
set -u
W=$HOME/.cache/hermes-601; SETUP=$(cd "$(dirname "$0")" && pwd); T=/tmp/hermes605
rm -rf $T; mkdir -p $T/home $T/fakehome $T/work
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:26510/v1\n  api_key: "stub"\nterminal:\n  cwd: %s\n' "$T/work" > $T/home/config.yaml
setsid nohup $W/venv/bin/python $SETUP/stub_model.py 127.0.0.2 26510 > $T/stub.log 2>&1 < /dev/null & echo $! > $T/stub.pid
cd $T/work
setsid nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home TERMINAL_CWD=$T/work \
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 HERMES_DASHBOARD_BASIC_AUTH_SECRET=fixture-secret-0123456789abcdef \
  bash -c "$W/venv/bin/python -m hermes_cli.main dashboard --port 26511 --host 127.0.0.2 --skip-build --no-open; echo EXIT=\$?" > $T/dash.log 2>&1 < /dev/null & echo $! > $T/dash.pid
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:26511/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:26511/api/status)"
