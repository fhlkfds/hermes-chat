#!/bin/bash
# Builds the throwaway Hermes the Automations work is verified on: the deployed bf0203a with this folder's patch
# applied, and a throwaway HERMES_HOME. Loopback only, scrubbed environment, no credentials. Never touches ~/.hermes.
#   setup.sh [HERMES_CHECKOUT]   (default ~/.hermes/hermes-agent; W=/tmp/hc-wh)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HOME/.hermes/hermes-agent}
W=${W:-/tmp/hc-wh}
# Keep the dashboard's built web UI across rebuilds: building it takes minutes and the patch doesn't touch it.
[ -d "$W/hermes/hermes_cli/web_dist" ] && rm -rf "$W/web_dist.keep" && mv "$W/hermes/hermes_cli/web_dist" "$W/web_dist.keep"
rm -rf "$W/hermes" "$W/home" "$W/cookies.txt" && mkdir -p "$W/hermes" "$W/home" "$W/fakehome"
(cd "$SRC" && git archive bf0203a) | tar -x -C "$W/hermes"
[ -d "$W/web_dist.keep" ] && mv "$W/web_dist.keep" "$W/hermes/hermes_cli/web_dist"
(cd "$W/hermes" && patch -p1 -s < "$HERE/hermes-bf0203a.patch")
printf 'platforms:\n  webhook:\n    enabled: true\n    extra:\n      host: 127.0.0.1\n      port: %s\n' "${HOOK_PORT:-18683}" > "$W/home/config.yaml"
echo "setup done: $W"
