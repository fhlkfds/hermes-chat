#!/bin/bash
# A throwaway Hermes dashboard: the deployed checkout, a fresh HERMES_HOME and HOME under /tmp, a throwaway basic-auth
# login, bound to 127.0.0.2, its model a loopback stub (llm.py). Never the owner's ~/.hermes.
set -u
T=/tmp/hc82/run; rm -rf $T; mkdir -p $T/home $T/fakehome
cat > $T/home/config.yaml <<YAML
model:
  default: stub-model
  provider: custom
  base_url: http://127.0.0.2:19483/v1
  api_key: ""
YAML
cd ~/.hermes/hermes-agent
setsid nohup /usr/bin/python3 "$(dirname "$0")/llm.py" 19483 > $T/llm.log 2>&1 < /dev/null & echo $! > $T/llm.pid
setsid nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 \
  venv/bin/python -m hermes_cli.main dashboard --port 19482 --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 < /dev/null & echo $! > $T/dash.pid
for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:19482/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:19482/api/status) dash=$(cat $T/dash.pid) llm=$(cat $T/llm.pid)"
