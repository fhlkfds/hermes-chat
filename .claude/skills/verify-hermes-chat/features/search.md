# Search chats

Search finds chats by title or message text across every chat, Settled ones included. Hits show the chat title, its section, its age and the matching text. Enter or a click opens the hit's chat, and a query with no hits says No matches.

## Sub-features

- `search-open`: Ctrl+K, the rail's search button, or the list panel's **Search chats** opens the palette with focus in the box.
- `search-body`: a word from a message finds its chat, including a Settled one.
- `search-open-hit`: Enter on the selected hit opens that chat and closes the palette.
- `search-empty`: a query with no hits shows "No matches".
- `search-close`: Escape closes the palette.

## How to get to it (user POV)

- Keyboard: Ctrl+K.
- Rail: the magnifier button, `aria-label` "Search all chats (Ctrl+K)".
- List panel: **Search chats** with the `Ctrl K` hint.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)).
- Chat `vpn` ("Why is the VPN slow", Settled) holds the text `MTU 1500 on a 1420 tunnel`.

- **Open with Ctrl+K.** Run `$S/wd.mjs press Control+k`, then `$S/wd.mjs wait '[role=dialog][aria-label="Search chats"]'`. The input `Words to search for` (placeholder "Search all chats, including Settled") has focus.
- **Body match.** Run `$S/wd.mjs keys MTU`, then `$S/wd.mjs wait .hit-row "Why is the VPN slow"`, then `$S/wd.mjs shot 08-search`. The hit reads "Why is the VPN slow · Settled · 2d · MTU 1500 on a 1420 tunnel…", and it is the only `.hit-row`.
- **Open the hit.** Run `$S/wd.mjs press Enter`, then `$S/wd.mjs gone '[role=dialog][aria-label="Search chats"]'`, then `$S/wd.mjs wait .msg.assistant "MTU = 1380"`. The selected tab `button.tab-open[aria-selected=true]` reads "Why is the VPN slow".
- **Miss.** Run `$S/wd.mjs press Control+k`, `$S/wd.mjs keys volcano` and `$S/wd.mjs wait '[role=dialog][aria-label="Search chats"]' "No matches"`.
- **Close.** Run `$S/wd.mjs press Escape`, then `$S/wd.mjs gone '[role=dialog][aria-label="Search chats"]'`.
- **Rail and list entries.** Run `$S/wd.mjs click button "Search all chats (Ctrl+K)"` and, after Escape, `$S/wd.mjs click button "Search chatsCtrl K"`. Each opens the same dialog.
- **Proof.** Keep the hit shot and the opened chat's shot. `bridge.log` shows `GET /api/sessions/search`.

## Gotchas

- Results come from the server after a short delay. Wait for `.hit-row` or "No matches", not a fixed time.
- `.hit-row.sel` marks the hit Enter will open. With several hits, check which one is selected first.
- Typing `keys` with the palette closed sends the text to whatever has focus. Open the palette first.
- The palette also has **Filters**, **Save filter…** and **Tag N results…**, which this recipe doesn't cover.
