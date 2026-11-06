# A pin is kept on this computer, and pinned chats sit first, in the order pinned

Issue #259. The owner wants to pin a chat so it stays at the top of the chat list, and unpin it again, from the row's right-click menu and from the chat header's More menu.

## Decisions

- **Pinned is the list's first section** (snooze.ts `chatSections`, ADR 0063). A pinned chat is in Pinned whatever else holds, Settled, Snoozed, Working or cleared, except Archived: an archived chat is hidden in every Hermes client, and it is in Pinned again once restored. The row keeps what it shows anywhere else (the unread dot, the spinner while a reply runs) and adds a small pin after the title.
- **In the order pinned, first pinned first.** A new message in a pinned chat doesn't move it within Pinned, and a new message in any other chat never puts it above Pinned. The issue offers dragging within the group as an alternative; it is left for later, on top of the same store.
- **Kept on this computer, for each connection and profile.** The pins are their own localStorage document (`hermes-chat.pins`), a time per chat as snoozes and clears are (ADR 0036, ADR 0063), and nothing goes to Hermes. Undo after Unpin puts the pin back in its old place.
- **Hermes's own pin flag is taken.** The deployed Hermes (f0d94882) has a `pinned` session column (`hermes_state_common.py:522`), written through the `sidebar` mutation (`hermes_state_mutations.py:5`, `set_session_pinned` in `hermes_state_sessions.py:1043`), and the dashboard lists every pinned row on each `GET /api/sessions` page. This app already stores Active and Settled in it (ADR 0002), so a pinned Settled chat can't be told apart from an Active one there. Hermes has no other field for it.
- **Pinned is a section like the others.** Its header collapses it, Settings → General can hide it, and Search still finds its chats. It draws no header while nothing is pinned. The display preferences go to version 2, whose step adds Pinned to a stored list of shown sections, so it shows on an install that had picked its sections.
- **A pinned chat the list doesn't reach stays.** The list reads a month back (`LIST_WINDOW_MS`). A pinned chat quiet for longer is read once by its id (`GET /api/sessions/{id}`) and kept in the list, as a chat picked from a search is. A pin of a chat Hermes no longer has is forgotten, and so is a deleted chat's.
- **Keyboard: P in the chat's menus.** Pin or Unpin is in the row's menu (right-click, the Menu key, or Shift+F10) and the header's More menu, and P picks it while either is open. The menu shell picks any item by the letter in its `aria-keyshortcuts`.
- **Alt+Up and Alt+Down go through Pinned, then the Inbox and Working**, as the list orders them.

## Considered options

- **Hermes's `pinned` flag.** Pins would follow the owner between machines, but the flag already means Active (ADR 0002). Using it for both would make every Active chat pinned.
- **Pins in the display preferences document (uiPrefs.ts).** That document holds settings, not one entry per chat; the snooze and clear stores already handle a time per chat, per scope, with a limit and another window's changes.
- **Newest activity first within Pinned.** The issue asks for pin order; a group that reorders as messages come in is the Inbox's job.

## Consequences

- **ADR 0063**: the list has seven sections, Pinned first. Each chat is still in exactly one.
- Pins don't sync between the owner's machines. If Hermes adds a field of its own for it, the store is the one place to change.
