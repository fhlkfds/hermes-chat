#!/bin/bash
# A throwaway Hermes dashboard: Hermes at bf0203a (git archive), a fresh HERMES_HOME and HOME under /tmp, a
# throwaway basic-auth login, bound to 127.0.0.2. Never the owner's ~/.hermes data.
set -u
T=/tmp/hc75/run; rm -rf $T; mkdir -p $T/home $T/fakehome $T/src
git -C ~/.hermes/hermes-agent archive bf0203a | tar -x -C $T/src
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:19752/v1\n  api_key: ""\n' > $T/home/config.yaml
cd $T/src
env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home PYTHONPATH=$PWD ~/.hermes/hermes-agent/venv/bin/python /tmp/hc75/setup/seed.py || exit 1
nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home PYTHONPATH=$PWD HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 \
  ~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main dashboard --port 19751 --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 & echo $! > $T/dash.pid
for i in $(seq 1 60); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:19751/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:19751/api/status) dash=$(cat $T/dash.pid)"
