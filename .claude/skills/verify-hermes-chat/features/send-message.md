# Send a message

The owner opens a chat from the list, types in the composer and presses Enter. Their message appears at once, Hermes's reply streams in below it, and both are stored in the chat's history on the server. A chat that was Settled moves up into the active list.

## Sub-features

- `chat-open`: clicking a chat in the list opens its history in the pane, with a tab and a header title.
- `send-enter`: Enter sends, and Shift+Enter makes a new line.
- `send-button`: the arrow button at the composer's right sends.
- `reply-stream`: the reply appears word by word and ends complete.
- `send-persisted`: the server's history holds the user message and the reply.
- `unsettle-on-send`: a Settled chat moves to the active list after a send.

## How to get to it (user POV)

- Click a chat in the list panel (expand **Settled** first for older ones).
- Pick a search hit (see [search.md](search.md)).
- Click an open tab in the tab strip.
- Alt+↑ or Alt+↓ switches chats from the keyboard.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)).
- Chat `backup` ("Nightly backup failing") is in Settled and holds 2 messages.

- **Expand Settled.** Run `$S/wd.mjs click button Settled`. Four `.row-open` rows show, and `$S/wd.mjs eval 'return [...document.querySelectorAll(".row-open")].map(e => e.dataset.chat)'` lists `backup`, `nginx`, `vpn` and `trip`.
- **Open the chat.** Run `$S/wd.mjs click '.row-open[data-chat=backup]'`, then `$S/wd.mjs wait .msg.assistant "restic unlock"`, then `$S/wd.mjs shot 05-chat-open`. `$S/wd.mjs count .msg` prints `2`, and a tab `button.tab-open` reads "Nightly backup failing".
- **Type.** Run `$S/wd.mjs fill 'textarea[data-composer]' -- "Did the re-run finish?"`, then `$S/wd.mjs shot 06-typed`. The hint "Enter to send · Shift+Enter for a new line" shows.
- **Send with Enter.** Run `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .msg.user "Did the re-run finish?"`. The composer is empty (`$S/wd.mjs value 'textarea[data-composer]'` prints an empty line).
- **Reply streams.** Run `$S/wd.mjs wait .msg.assistant "Stand-in reply to: Did the re-run finish?" 20000`, then `$S/wd.mjs shot 07-replied`. `$S/wd.mjs count .msg` prints `4`.
- **Unsettled.** "Nightly backup failing" is now above the Settled header, and the header reads `Settled3`.
- **Send button.** Run `$S/wd.mjs fill 'textarea[data-composer]' -- "And the next one?"`, then `$S/wd.mjs click button.send`, then `$S/wd.mjs wait .msg.assistant "Stand-in reply to: And the next one?"`.
- **Proof on the server.** Run `$S/hv state | python3 -c 'import json,sys; print(json.load(sys.stdin)["transcripts"]["backup"][-2:])'`. The last two rows are the user text and its `Stand-in reply to:` reply.

## Gotchas

- `wd.mjs keys` types into whatever has focus. After clicking a list row, focus may not be in the composer, so use `fill 'textarea[data-composer]'` for text.
- An empty composer or an offline connection disables `button.send`, and `click` on it then does nothing.
- Shots taken mid-stream show a partial reply. Wait for the full reply text before the "after" shot.
- The stand-in replies to every prompt, so tools, approvals and reasoning blocks are never exercised here. Those need a real dashboard with a model.
