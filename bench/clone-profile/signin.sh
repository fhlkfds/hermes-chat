#!/bin/bash
# Opens the app under the verify skill and signs in to the stand-in (features/sign-in.md), with $HV_RUN exported.
set -euo pipefail
S=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
. "$HV_RUN/state.env"
$W open
$W wait button "Get started" 30000
$W click button "Get started"
$W select select "Connect through" -- "Web address"
$W fill input "Dashboard URL" -- "$DASHBOARD_URL"
$W click button "Test the route"
$W wait '[role=status]' "Reached Hermes" 20000
$W click button Next
$W fill input "Dashboard username" -- verify
$W fill input "Dashboard password" -- verify-pass
$W click button "Test connection"
$W wait '[role=status]' "At least one route works" 20000
$W click button "Save and connect"
$W wait .setup-ok "You're ready to chat" 20000
$W click button Skip
$W gone '[role=dialog]' 10000
