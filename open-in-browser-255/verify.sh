#!/usr/bin/env bash
# Issue #255 in the real app: both "Open in your browser" entry points reach the default browser this computer's
# mimeapps.list names, by exactly the URL, and a failure shows the browser's own reason.
# Usage: verify.sh <repo>   (HV_TARGET set to a built target)
set -euo pipefail
REPO=$1
S=$REPO/.claude/skills/verify-hermes-chat/scripts
B=$(cd "$(dirname "$0")" && pwd)
export HV_RUN=$($S/hv up | sed -n 's/^export HV_RUN=//p')
. "$HV_RUN/state.env"
echo "HV_RUN=$HV_RUN EVIDENCE=$EVIDENCE"
LOG=$EVIDENCE/browser.log
: > "$LOG"
rm -f "$B/fail"

cat > "$B/fakebrowser" <<EOF
#!/bin/sh
{ printf 'ARGV:'; for a in "\$@"; do printf ' [%s]' "\$a"; done; printf '  PARENT: %s  STARTUP: %s\n' "\$(ps -o args= -p \$PPID)" "\${DESKTOP_STARTUP_ID:-none} \${XDG_ACTIVATION_TOKEN:-none}"; } >> $LOG
if [ -e $B/fail ]; then echo "fakebrowser: starting" >&2; echo "cannot open display: wayland-1" >&2; exit 1; fi
exit 0
EOF
chmod +x "$B/fakebrowser"
mkdir -p "$RUN/data/applications" "$RUN/config"
printf '[Desktop Entry]\nType=Application\nName=Fake Browser\nExec=%s %%u\nStartupNotify=true\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n' "$B/fakebrowser" > "$RUN/data/applications/fakebrowser.desktop"
printf '[Default Applications]\nx-scheme-handler/http=fakebrowser.desktop\nx-scheme-handler/https=fakebrowser.desktop\n' > "$RUN/config/mimeapps.list"

assert_log() { grep -qxF "$1" <(sed 's/  PARENT:.*//' "$LOG") || { echo "FAIL: browser.log lacks: $1"; cat "$LOG"; exit 1; }; echo "ok browser got: $1"; }
toast() { $S/wd.mjs wait '.toast' "$1" 30000; }

bash "$B/signin.sh" "$S" > /dev/null
$S/wd.mjs click button Settled > /dev/null
$S/wd.mjs click '.row-open[data-chat=backup]' > /dev/null
$S/wd.mjs wait .msg.assistant "restic unlock" 20000 > /dev/null
$S/wd.mjs fill 'textarea[data-composer]' -- "Read https://docs.example.com/crash?a=1&b=2#frag please" > /dev/null
$S/wd.mjs press Enter > /dev/null
$S/wd.mjs wait .msg.assistant "Stand-in reply to: Read" 20000 > /dev/null
DOCS='https://docs.example.com/crash?a=1&b=2#frag'
LINK='.msg.assistant a[href*="docs.example.com"]'

echo "== 1. link menu, browser opens"
$S/wd.mjs rightclick "$LINK" > /dev/null
$S/wd.mjs wait '[role=menu]' > /dev/null
$S/wd.mjs shot 01-link-menu > /dev/null
$S/wd.mjs click '[role=menuitem]' "Open in your browser" > /dev/null
toast "Opened in Fake Browser."
$S/wd.mjs shot 02-menu-opened-toast
assert_log "ARGV: [$DOCS]"

echo "== 2. link menu, browser fails"
touch "$B/fail"
$S/wd.mjs rightclick "$LINK" > /dev/null
$S/wd.mjs wait '[role=menu]' > /dev/null
$S/wd.mjs click '[role=menuitem]' "Open in your browser" > /dev/null
toast "Couldn't open it in your browser: Fake Browser stopped with exit code 1: cannot open display: wayland-1"
$S/wd.mjs shot 03-menu-failed-toast
rm -f "$B/fail"

echo "== 3. refused page in the Preview, browser opens"
$S/wd.mjs fill 'textarea[data-composer]' -- "Search https://www.google.com/ now" > /dev/null
$S/wd.mjs press Enter > /dev/null
$S/wd.mjs wait .msg.assistant "Stand-in reply to: Search" 20000 > /dev/null
$S/wd.mjs click '.msg.assistant a[href*="google.com"]' > /dev/null
$S/wd.mjs wait '[role=alert]' "doesn't allow being shown inside other apps" 60000 > /dev/null
$S/wd.mjs shot 04-refused-note > /dev/null
$S/wd.mjs click '[role=alert] button' "Open in your browser" > /dev/null
$S/wd.mjs wait '.preview-opened' "Opened in Fake Browser." 30000
$S/wd.mjs shot 05-refused-opened-note
assert_log "ARGV: [https://www.google.com/]"

echo "== 4. refused page in the Preview, browser fails"
touch "$B/fail"
$S/wd.mjs click '[role=alert] button' "Open in your browser" > /dev/null
$S/wd.mjs wait '.preview-opened.failed' "Fake Browser stopped with exit code 1: cannot open display: wayland-1" 30000
$S/wd.mjs shot 06-refused-failed-note
rm -f "$B/fail"

echo "== 5. no default browser"
rm "$RUN/config/mimeapps.list" "$RUN/data/applications/fakebrowser.desktop"
sleep 2
$S/wd.mjs rightclick "$LINK" > /dev/null
$S/wd.mjs wait '[role=menu]' > /dev/null
$S/wd.mjs click '[role=menuitem]' "Open in your browser" > /dev/null
toast "Couldn't open it in your browser: No default browser is set."
$S/wd.mjs shot 07-no-default-toast

echo "== browser.log"
cat "$LOG"
echo "verify-255: all ok"
