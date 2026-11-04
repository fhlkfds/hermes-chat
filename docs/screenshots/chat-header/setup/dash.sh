#!/bin/bash
# A throwaway Hermes dashboard for the screenshots: the deployed checkout, a fresh HERMES_HOME and HOME under ~/hc173,
# a throwaway basic-auth login, bound to 127.0.0.2. No model is called: the screenshots send nothing.
set -u
H=$(cd "$(dirname "$0")" && pwd)
T=$HOME/hc173/run; rm -rf $T; mkdir -p $T/home $T/fakehome
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:19174/v1\n  api_key: ""\n' > $T/home/config.yaml
cd ~/.hermes/hermes-agent
env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home PYTHONPATH=$PWD venv/bin/python $H/seed.py || exit 1
setsid nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 \
  venv/bin/python -m hermes_cli.main dashboard --port 19173 --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 &
for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:19173/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:19173/api/status)"
