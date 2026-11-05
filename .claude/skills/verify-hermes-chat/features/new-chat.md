# New chat

The owner starts a fresh chat. The pane shows "What should Hermes work on?" with an empty composer. The first message creates the chat on the server, and the chat appears at the top of the list, titled by its first words until Hermes gives it a title.

## Sub-features

- `new-rail`: the rail's New chat button.
- `new-list`: the list panel's **New chat** row (`Ctrl N`).
- `new-shortcut`: Ctrl+N from anywhere in the main window.
- `new-tab`: the `+` (**New tab**) in the tab strip.
- `new-first-send`: the first message creates the session on the server and adds it to the list.

## How to get to it (user POV)

- Rail: the pencil button, `aria-label` "New chat (Ctrl+N)".
- List panel: **New chat** with the `Ctrl N` hint.
- Keyboard: Ctrl+N.
- Tab strip: **New tab** (`+`).

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)).
- The stand-in holds the 4 seeded sessions (`$S/hv state` lists them).

- **Rail entry.** Run `$S/wd.mjs click button "New chat (Ctrl+N)"`, then `$S/wd.mjs wait .chat-title "New chat"`. The empty state "What should Hermes work on?" shows.
- **First message.** Run `$S/wd.mjs fill 'textarea[data-composer]' -- "Check certificate expiry on the proxy"`, `$S/wd.mjs press Enter` and `$S/wd.mjs wait .msg.assistant "Stand-in reply to: Check certificate expiry" 20000`.
- **In the list.** Run `$S/wd.mjs eval 'return [...document.querySelectorAll(".row-open")].map(e => e.dataset.chat + " " + e.textContent.trim())'`. The first row is a new id whose text starts "Check certificate expiry on the proxy".
- **On the server.** Run `$S/hv state | python3 -c 'import json,sys; print([(s["id"], s["title"], s["preview"]) for s in json.load(sys.stdin)["sessions"]])'`. It shows a fifth session with title `None` and that preview.
- **Keyboard entry.** From an open chat, run `$S/wd.mjs press Control+n`, then `$S/wd.mjs wait .chat-title "New chat"`. The new chat replaces the chat in the current tab, and `$S/wd.mjs count button.tab-open` stays the same.
- **List entry.** From an open chat, run `$S/wd.mjs click button "New chatCtrl N"`, then `$S/wd.mjs wait .chat-title "New chat"`.
- **Tab entry.** From an open chat, run `$S/wd.mjs click button "New tab"`, then `$S/wd.mjs wait .chat-title "New chat"`. `$S/wd.mjs count button.tab-open` goes up by one, and the old chat keeps its tab.
- **Proof.** Take `wd.mjs shot` images of the empty state and the list with the new row, and keep the `hv state` output.

## Gotchas

- A new chat with no message sent never reaches the server. Assert the server side only after the first send.
- The stand-in never generates titles, so the row keeps showing the first words. A real Hermes renames it later.
- `Ctrl+N` typed while the composer has focus still opens a new chat. That is intended.
- Only **New tab** opens a tab. The other entry points reuse the current one, so assert the tab count to tell them apart.
