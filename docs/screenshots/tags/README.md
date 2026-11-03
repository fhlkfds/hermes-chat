# Tags and Saved filters screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK) on an Xvfb display, 1280 × 820.
These are framebuffer captures. Nothing was composited or retouched. The app was signed in by URL to `bridge.ts` in
this folder: the repo's `FakeHermes` behind real HTTP and WebSocket on loopback, with synthetic chats. It is not a real
Hermes dashboard. Every chat, model and tag is made up. The app ran on its own D-Bus session bus, so it couldn't save
the password in a keyring. It said so, and the password was typed again after each restart.

The app was driven by hand with `xdotool`, not by a script. Every tag, filter and bulk edit shown was made through
the UI. Images 1–5 and 7 come from the build before the last two fixes: the bulk preview's singular wording, and
focus going back to the search box when a panel closes. Image 6 is from the final build. Between builds the app was
restarted on the same data folder, and the tags and the Saved filter were still there.

- `1-tag-editor.png`: the tag editor, opened from a chat's right-click menu, renaming "Backups" while two other
  tags are named with an emoji and with CJK characters. Before this, typing "backups" was refused: "There's already a
  tag called "Backups"".
- `2-chat-menu-tags.png`: a chat's menu with its tags checked, and Edit tags….
- `3-tag-filter.png`: Filters with Tag "Backups & restores" and no words. It lists the two tagged chats, each with its
  tags as text, and shows the filter as a removable chip under "In default:".
- `4-words-and-model-filter.png`: the words "backup" with Model "opus". It found "restic retention policy", which
  is 6 weeks old: older than the list's month, so not in the list.
- `5-saved-filter-reopened.png`: the Saved filter "Opus backup chats", in its own section of the chat list above
  Active, reopened. The chip line names it, and the results show the bulk edit from image 7.
- `6-bulk-preview.png`: Tag 3 results… → Infrastructure → Preview. The preview names the two chats that would change
  and says one already has the tag. This one was cancelled, and the chats stayed as they were.
- `7-bulk-applied.png`: an earlier bulk edit adding "Backups & restores", confirmed after one was cancelled. The
  cancelled one changed nothing, and this one tagged exactly the two chats it previewed. Settled still says 4: running
  filters put no chat in the list.
