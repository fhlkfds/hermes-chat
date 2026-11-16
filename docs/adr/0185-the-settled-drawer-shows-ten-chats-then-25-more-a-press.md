# The Settled drawer shows ten chats, then 25 more a press

> **Accepted.** The drawer's rows and its Show more button are `SettledList` in `src/ui/Sidebar.tsx` (`SETTLED_FIRST`, `SETTLED_PAGE`), styled by `.settled-more` in `src/styles.css`, and tested in `src/ui/chatSections.test.tsx`.

The Settled drawer (ADR 0090) drew a row for every Settled chat as soon as it opened. Settled only grows: every chat the owner puts out of the way stays there, so after a few weeks it holds hundreds of chats. The owner opens the drawer to find a recent one, and asked for it to show the first ten and offer more on request.

## Decisions

- **The open drawer draws its first ten chats.** They are the newest, in the order the drawer already sorts them. The header's count stays the whole number of Settled chats.
- **A Show more button under the rows adds 25 more a press.** It names how many it adds: "Show 25 more", and on the last press only what is left, as "Show 7 more". It goes once every chat is drawn, and isn't drawn for ten chats or fewer.
- **Closing the drawer forgets how far it was shown.** Opening it again draws ten. This is kept in the drawer, not in `chatSectionsCollapsed` or anywhere else across restarts.
- **The chat on screen is always drawn.** When the selected chat is Settled and past the rows shown, the drawer draws down to it, so opening a Settled chat from a search (which opens the drawer, ADR 0090) shows its row and marks it. Show more then counts from there.
- **A keyboard press of Show more moves focus to the first new row**, so Up and Down carry on through the list once the button is gone. A pointer click leaves focus alone: a focused row shows its Settle and Delete buttons, as a hovered row does.

## Considered options

- **Drawing every row and relying on the drawer's scroll.** That is what it did. The drawer is at most half the panel, so the owner scrolled past many rows to reach the bottom, and the app drew a row per chat, each with its menu, on every list change.
- **Loading more as the drawer scrolls to the bottom.** It hides where the list ends, and a drawer half the panel tall reaches its bottom after a few rows, so it loads more without being asked.
- **Remembering how far the drawer was shown across a close.** The owner opens the drawer for a recent chat, so starting at ten again is what they want most often.

## Consequences

- A Settled chat past the rows shown has no row until the owner presses Show more. Search (which includes Settled chats) still finds it, and opening it draws its row.
- A row dragged onto the drawer is still settled, whatever the drawer shows (ADR 0090).
- Tests find the button by its text, `Show <n> more`, inside `.settled-drawer`.
