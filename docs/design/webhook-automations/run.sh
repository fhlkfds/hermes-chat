#!/bin/sh
# Runs the throwaway gateway (webhook listener on 127.0.0.1:$HOOK_PORT, default 18683) or dashboard (127.0.0.2:$DASH_PORT, default 19083) from setup.sh.
#   run.sh gateway|dashboard
W=${W:-/tmp/hc-wh}
P=${PY:-$HOME/.hermes/hermes-agent/venv/bin/python}
cd "$W/hermes" || exit 1
case $1 in
  gateway) exec env -i HOME=$W/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$W/home $P -m hermes_cli.main gateway run ;;
  dashboard) exec env -i HOME=$W/fakehome PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME=$W/home \
    HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=fixture-pass-123 \
    $P -m hermes_cli.main dashboard --port ${DASH_PORT:-19083} --host 127.0.0.2 --skip-build --no-open ;;
  *) echo "run.sh gateway|dashboard" >&2; exit 2 ;;
esac
