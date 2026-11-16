#!/bin/bash
# Throwaway Hermes dashboard for the Run view's drops (#602) on 127.0.0.2:$PORT, stub model on $PORT-1, and a proxy
# on $PORT+1 that the app connects through, at commit $TREE. Fresh HOME and HERMES_HOME under /tmp/hermes602gaps-$TREE.
# Never the owner's ~/.hermes data. Drop the app's connection with: touch $T/$((PORT+1)).hold; kill -USR1 <proxy pid>;
# and let it back with: rm $T/$((PORT+1)).hold.
set -u
TREE=${TREE:-bf0203a}; PORT=${PORT:-26411}; MPORT=$((PORT-1)); PPORT=$((PORT+1))
V=$HOME/.cache/hermes-601/venv; D=$(cd "$(dirname "$0")" && pwd); T=/tmp/hermes602gaps-$TREE; SRC=$HOME/.cache/hermes-fleet-survey/trees/$TREE
rm -rf $T; mkdir -p $T/home $T/fakehome $T/work
printf 'model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:%s/v1\n  api_key: "stub"\ndisplay:\n  tool_progress: all\nterminal:\n  cwd: %s\n' "$MPORT" "$T/work" > $T/home/config.yaml
setsid nohup $V/bin/python $D/stub_model.py 127.0.0.2 $MPORT > $T/stub.log 2>&1 < /dev/null &
(cd $T && setsid nohup $V/bin/python $D/proxy.py 127.0.0.2 $PPORT 127.0.0.2 $PORT > $T/proxy.log 2>&1 < /dev/null &)
cd $T/work
setsid nohup env -i HOME=$T/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$T/home TERMINAL_CWD=$T/work PYTHONPATH=$SRC \
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 HERMES_DASHBOARD_BASIC_AUTH_SECRET=fixture-secret-0123456789abcdef \
  $V/bin/python -m hermes_cli.main dashboard --port $PORT --host 127.0.0.2 --skip-build --no-open > $T/dash.log 2>&1 < /dev/null &
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.2:$PPORT/api/status 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "status via proxy: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.2:$PPORT/api/status) tree=$TREE port=$PORT proxy=$PPORT"
ss -ltnp 2>/dev/null | grep -E "127.0.0.2:($PORT|$MPORT|$PPORT)\b"
