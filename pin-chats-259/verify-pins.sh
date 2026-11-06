#!/usr/bin/env bash
# Drives issue #259's checks in the real app: run after `hv up`, with hv.sh sourced.
set -euo pipefail
. "$(dirname "$0")/hv.sh"
W=$S/wd.mjs
pinned() { $W eval 'return [...document.querySelectorAll(".row[data-section=pinned] .row-open")].map(e => e.dataset.chat).join(",")' | tr -d '"'; }
heads() { $W eval 'return [...document.querySelectorAll(".section-toggle")].map(e => e.textContent).join(" ")' | tr -d '"'; }
expect() { [ "$1" = "$2" ] && echo "PASS $3: $1" || { echo "FAIL $3: got '$1', want '$2'"; exit 1; }; }
signin_again() { $W open; $W wait button Connect 60000; $W fill input "Dashboard password" -- verify-pass; $W click button Connect; $W wait button "Search all chats (Ctrl+K)"; }

$W open
$W wait button "Get started" 60000; $W click button "Get started"
$W select select "Connect through" -- "Web address"; $W fill input "Dashboard URL" -- $DASHBOARD_URL
$W click button "Test the route"; $W wait '[role=status]' "Reached Hermes 0.17.0" 30000; $W click button Next
$W fill input "Dashboard username" -- verify; $W fill input "Dashboard password" -- verify-pass
$W click button "Test connection"; $W wait '[role=status]' "At least one route works" 30000
$W click button "Save and connect"; $W wait .setup-ok "You're ready to chat" 30000; $W click button Skip; $W gone '[role=dialog]'
$W click button Settled; $W shot 01-signed-in

# Row menu, by right-click.
$W rightclick '.row-open[data-chat=nginx]'; $W wait '[role=menuitem]' Pin; $W shot 02-row-menu
$W click '[role=menuitem]' Pin; $W wait .section-toggle Pinned
expect "$(pinned)" nginx "row menu pins"

# Keyboard: Down to the next row, Shift+F10, then P.
$W press ArrowDown
expect "$($W eval 'return document.activeElement.dataset.chat' | tr -d '"')" backup "focus moved by keyboard"
$S/hv x key shift+F10; $W wait '[role=menuitem]' Pin; $W shot 03-shift-f10-menu
$W press p; $W gone '[role=menu]'
expect "$(pinned)" nginx,backup "keyboard pins, in pin order"
$W shot 04-two-pinned

# A message in an unpinned chat leaves it below the pinned ones.
$W click '.row-open[data-chat=vpn]'; $W wait '.chat-title' "Why is the VPN slow"
$W fill 'textarea[data-composer]' -- "Any change since the reboot?"; $W press Enter
$W wait .msg.assistant "Stand-in reply to: Any change since the reboot?" 30000
expect "$(pinned)" nginx,backup "pinned unchanged after a message in vpn"
expect "$($W eval 'return document.querySelector(".row-open[data-chat=vpn]").closest(".row").dataset.section' | tr -d '"')" inbox "vpn moved to the Inbox, below Pinned"
expect "$(heads | cut -d' ' -f1)" Pinned2 "Pinned is the first section"
$W shot 05-message-in-unpinned

# Header More menu: Pin shows for vpn; Unpin for nginx sends it back to Settled.
$W click button More; $W wait '[role=menuitem]' Pin; $W shot 06-more-menu-pin; $W press Escape
$W click '.row-open[data-chat=nginx]'; $W wait '.chat-title' "Rotate nginx logs"
$W click button More; $W wait '[role=menuitem]' Unpin; $W shot 07-more-menu-unpin
$W click '[role=menuitem]' Unpin; $W gone '[role=menu]'
expect "$(pinned)" backup "header More unpins"
expect "$($W eval 'return document.querySelector(".row-open[data-chat=nginx]").closest(".row").dataset.section' | tr -d '"')" settled "nginx back in Settled"
$W shot 08-unpinned

# Menu key on a focused row: pins trip.
$W click '.row-open[data-chat=nginx]'
for i in 1 2 3; do [ "$($W eval 'return document.activeElement.dataset.chat' | tr -d '"')" = trip ] && break; $W press ArrowDown; done
expect "$($W eval 'return document.activeElement.dataset.chat' | tr -d '"')" trip "focus on trip"
$S/hv x key Menu; $W wait '[role=menuitem]' Pin; $W shot 09-menu-key-menu
$W press p; $W gone '[role=menu]'
expect "$(pinned)" backup,trip "Menu key pins"

# Restart: pins are kept.
$W close; signin_again
$W wait '.row[data-section=pinned] .row-open[data-chat=trip]' ''
expect "$(pinned)" backup,trip "pins kept across a restart"
$W shot 10-after-restart
$S/hv state > "$EVIDENCE/server-state-final.json"
echo "verify-pins: all ok"
