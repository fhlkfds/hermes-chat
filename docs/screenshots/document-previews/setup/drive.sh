#!/usr/bin/env bash
# Signs in to the stand-in and opens each sample file in the Preview, one shot per file.
# Usage: HV_RUN=<run> drive.sh <scripts dir> <prefix> <folder holding the samples> <file>...
set -euo pipefail
S=$1 prefix=$2 dir=$3; shift 3
. "$HV_RUN/state.env"
W="$S/wd.mjs"
$W open
$W wait button "Get started" 60000
$W click button "Get started"
$W select select "Connect through" -- "Web address"
$W fill input "Dashboard URL" -- "$DASHBOARD_URL"
$W click button "Test the route"
$W wait '[role=status]' "Reached Hermes" 60000
$W click button Next
$W fill input "Dashboard username" -- verify
$W fill input "Dashboard password" -- verify-pass
$W click button "Test connection"
$W wait '[role=status]' "At least one route works" 60000
$W click button "Save and connect"
$W wait .setup-ok "You're ready to chat" 60000
$W click button Skip
$W gone '[role=dialog]' 20000
$W click button "Open the side panel"
$W click button Preview
for f in "$@"; do
  $W fill input Address -- "$dir/$f"
  $W press Enter
  sleep 4
  $W shot "$prefix-${f//./-}"
  $W eval 'return document.querySelector("aside.preview:not([hidden]) .preview-body, aside.preview:not([hidden])")?.innerText.slice(0, 300)'
done
