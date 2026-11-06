set -e
S=$1; . $HV_RUN/state.env
$S/wd.mjs open
$S/wd.mjs wait button "Get started" 60000
$S/wd.mjs click button "Get started"
$S/wd.mjs select select "Connect through" -- "Web address"
$S/wd.mjs fill input "Dashboard URL" -- $DASHBOARD_URL
$S/wd.mjs click button "Test the route"
$S/wd.mjs wait '[role=status]' "Reached Hermes 0.17.0" 30000
$S/wd.mjs click button Next
$S/wd.mjs fill input "Dashboard username" -- verify
$S/wd.mjs fill input "Dashboard password" -- verify-pass
$S/wd.mjs click button "Test connection"
$S/wd.mjs wait '[role=status]' "At least one route works" 30000
$S/wd.mjs click button "Save and connect"
$S/wd.mjs wait .setup-ok "You're ready to chat" 30000
$S/wd.mjs click button Skip
$S/wd.mjs gone '[role=dialog]'
