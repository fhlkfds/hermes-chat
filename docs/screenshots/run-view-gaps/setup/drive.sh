#!/bin/bash
# Drives the real app against the throwaway Hermes from dash.sh, through its proxy, and drops the connection while the
# turn's tool runs, so the Run view shows the time it heard nothing (#602). Needs `hv up --dashboard <proxy URL>` first,
# with HV_RUN exported. Usage: drive.sh <proxy pid> <proxy port>
set -eu
PROXY_PID=$1; PPORT=$2; T=/tmp/hermes602gaps-${TREE:-bf0203a}
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
. $HV_RUN/state.env
W=$S/wd.mjs

$W open
$W wait button "Get started" 60000
$W click button "Get started"
$W select select "Connect through" -- "Web address"
$W fill input "Dashboard URL" -- "$DASHBOARD_URL"
$W click button "Test the route"
$W wait '[role=status]' "Reached Hermes" 60000
$W click button Next
$W fill input "Dashboard username" -- fixture
$W fill input "Dashboard password" -- fixture-pass-123
$W click button "Test connection"
$W wait '[role=status]' "At least one route works" 90000
$W click button "Save and connect"
$W wait '[role=dialog]' "Model providers" 60000
sleep 3
$W click button Skip
$W gone '[role=dialog]' 20000

$W click button "New chat (Ctrl+N)"
$W wait .chat-title "New chat" 20000
$W fill 'textarea[data-composer]' -- "check disk on the box"
$W press Enter
# The stub model asks for `terminal` (sleep 10) after 0.8 s; drop while it runs.
$W wait .tool "terminal" 30000
sleep 1
$W shot 01-tool-running
touch $T/$PPORT.hold
kill -USR1 $PROXY_PID
sleep 4
$W shot 02-dropped
rm $T/$PPORT.hold
$W wait .msg.assistant "The disk check ran after a long wait." 60000
$W shot 03-replied
$W click button Run
$W wait '[role=dialog]' "What this app heard live" 20000
$W shot 04-run-view
$W click ".run-gap .run-row"
$W wait .run-detail "heard nothing of the turn until it reconnected" 5000
$W shot 05-not-heard
