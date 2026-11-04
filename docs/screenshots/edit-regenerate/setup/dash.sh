#!/bin/bash
# A throwaway Hermes dashboard for issue #63's checks: the deployed checkout, a fresh HERMES_HOME and HOME under /tmp,
# a throwaway basic-auth login, bound to 127.0.0.2, its model a loopback stub (llm.py). Never the owner's ~/.hermes.
set -u
R=/tmp/hc63; T=$R/run
[ -f $T/dash.pid ] && kill $(cat $T/dash.pid) 2>/dev/null; [ -f $T/llm.pid ] && kill $(cat $T/llm.pid) 2>/dev/null; sleep 1
rm -rf $T; mkdir -p $T/home $T/fakehome $T/files
printf '# Backup policy\n\n- 7 daily snapshots\n- 4 weekly snapshots\n' > $T/files/backup-policy.md
cat > $T/home/config.yaml <<YAML
model:
  default: stub-model
  provider: custom
  base_url: http://127.0.0.2:19632/v1
  api_key: ""
YAML
cd ~/.hermes/hermes-agent
env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home DEMO_FILES=$T/files PYTHONPATH=$PWD venv/bin/python $R/seed.py || exit 1
nohup /usr/bin/python3 $R/llm.py 19632 > $T/llm.log 2>&1 & echo $! > $T/llm.pid
nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-63 \
  venv/bin/python -m hermes_cli.main dashboard --port 19631 --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 & echo $! > $T/dash.pid
for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:19631/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:19631/api/status) dash=$(cat $T/dash.pid) llm=$(cat $T/llm.pid)"
