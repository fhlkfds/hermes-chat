#!/usr/bin/env bash
# Signs the headless app in to the verify skill's stand-in (features/sign-in.md). Needs HV_RUN from `hv up`.
set -euo pipefail
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
. "$HV_RUN/state.env"
W=$S/wd.mjs
$W open
$W wait button "Get started" 60000
$W click button "Get started"
$W select select "Connect through" -- "Web address"
$W fill input "Dashboard URL" -- "$DASHBOARD_URL"
$W click button "Test the route"
$W wait '[role=status]' "Reached Hermes" 30000
$W click button Next
$W fill input "Dashboard username" -- verify
$W fill input "Dashboard password" -- verify-pass
$W click button "Test connection"
$W wait '[role=status]' "At least one route works" 60000
$W click button "Save and connect"
$W wait .setup-ok "You're ready to chat" 30000
$W click button Skip
$W gone '[role=dialog]'
