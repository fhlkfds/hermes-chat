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

## Everywhere (issue #608)

The scope switch **This profile** / **Everywhere** beside the words searches every profile of every live connection. Rows name `server · bot` in `.hit-where`. Proof needs two live connections, so this recipe runs a second stand-in by hand.

- **Two servers.** Start `hv up` with `HV_EVERYWHERE=1 HV_LIST=120`: `default` holds 120 extra chats that all say "Nothing", `work` holds "Offsite copy" and a third profile `ops` holds "Snapshot schedule", both about the backup. Bundle a second stand-in with `npx rolldown "$S/bridge.ts" --platform node -o <dir>/bridge.mjs` (the entry path must be absolute), start it with `setsid node <dir>/bridge.mjs <free port> <dir>/state.json &` and keep its PID: `hv down` doesn't stop it. Sign in to the first as `Alpha` (see [sign-in.md](sign-in.md), filling `input "Name"` after the route test), then in Settings set `select "Live at once"` to 2, **Add connection** and sign in to the second as `Bravo`. Bravo becomes the target and the rail reads "1 more live".
- **Merged rows.** `Control+k`, `click button Everywhere`, `keys backup`, then `wait .hit-where "Alpha · ops"`. Four rows: Bravo · default, Alpha · default, Alpha · work and Alpha · ops, each with its snippet.
- **Cap.** `fill input "Words to search for" -- nothing`, then `wait .palette-note "hit that"`: 100 rows and "default on Alpha hit that, so more chats may match there".
- **Filters.** `click button Filters` shows only Bot, Model, Active from and Until. A model in `input Model` adds the note "The model and the dates are checked here, after Hermes has picked its best 100 chats for each bot".
- **Opening.** `click .hit-row "Offsite copy"` (Alpha, in the background) makes Alpha the target, switches to `work` and opens find-in-chat on "backup" with `mark.current` in the assistant message. Then a row on Alpha's other profile, then one in the profile on screen (`keys MTU`, `click .hit-row "Alpha · default"`), land the same way.
- **Four at once.** Run both stand-ins with `HV_DELAY_MS=1500`. In the two `bridge.log`s, the search's two `GET /api/profiles` arrive together, then four `GET /api/sessions/search`, and the fifth only 1.5 s later, when one of the four answers.

## Gotchas

- Results come from the server after a short delay. Wait for `.hit-row` or "No matches", not a fixed time.
- `.hit-row.sel` marks the hit Enter will open. With several hits, check which one is selected first.
- Typing `keys` with the palette closed sends the text to whatever has focus. Open the palette first.
- The palette also has **Filters**, **Save filter…** and **Tag N results…**, which this recipe doesn't cover.
