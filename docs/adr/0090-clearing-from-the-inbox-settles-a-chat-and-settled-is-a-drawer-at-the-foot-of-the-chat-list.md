# Clearing from the Inbox settles a chat, and Settled is a drawer at the foot of the chat list

Issue #278. ADR 0063 gave the chat list two places for a chat the owner was done with: Unsettled, for a chat cleared from the Inbox until something newer happened in it, and Settled. A clear was kept on this computer only, so it didn't follow the owner to their laptop. The owner ended up clearing and settling the same chats, and scrolling past both sections. This ADR replaces two of ADR 0063's decisions: the Unsettled section with its Clear action, and "Settled leaves the foot of the list". The rest of 0063 stands.

## Decisions

- **Settle is how a chat leaves the Inbox.** The Settle button on an Inbox row and Settle in its right-click menu are the one way to clear a chat. A settled chat is Settled on Hermes (`pinned = false`, ADR 0002), so it syncs between machines and stays put when a message arrives from another platform. When Hermes refuses the write (a chat without a gateway route), the state is kept in this computer's list, as ADR 0002 says.
- **Unsettled and Clear go.** The Unsettled section, its switch in Settings, the row's Clear from the Inbox button, the Clear from the Inbox and Back to the Inbox menu items, and the local clear store (`hermes-chat.cleared`) are gone. Unsettle stays: on a Settled row, in the chat's header and in the menu, it moves the chat back to the Inbox.
- **Settled is a drawer at the foot of the chat list.** Its "Settled (n)" header sits at the bottom of the list panel, outside the list's scroll, however long the Inbox is. Clicking the header opens the drawer upward, to at most half the panel, with its own scroll; clicking it again closes it and hides the settled chats. The Inbox and the other sections keep scrolling above it. It starts closed, and open or closed is kept across restarts in the same preference as every section (uiPrefs.ts `chatSectionsCollapsed`). The Settled switch in Settings still hides it completely. Opening a Settled chat from elsewhere (a search, a link) opens the drawer.
- **Archived stays a section in the scroll.** When Settings shows it, it is last in the scroll, above the drawer. Settled is the only drawer. The order is Pinned, Inbox, Working, Snoozed and Archived in the scroll, then the Settled drawer.
- **Up and Down walk the rows on screen, the open drawer's included.** From the last row in the scroll, Down moves to the drawer's first row.
- **The chats in Unsettled are settled once.** The first time the updated app has read a profile's chat list from Hermes, each chat whose clear still held, the ones Unsettled showed, is settled, one write to Hermes each, as pressing Settle sends. That connection and profile's clears are then deleted, and the stored document goes once no profile has any left. Clears that no longer held are dropped. A chat missing from the list (archived while Archived was hidden, or older than the list reaches) is dropped too, since Unsettled didn't show it.
- **Old display preferences drop Unsettled.** Version 3 of the display preferences removes `unsettled` from the sections shown and the sections collapsed. An owner who showed only Unsettled gets the default sections back.

## Considered options

- **Keeping Clear, kept on Hermes.** Hermes has one flag for the owner's attention, `pinned`, and Settled already uses it. A second state would have nowhere to live but this computer.
- **Settled as a section in the scroll, as ADR 0063 had it.** Its chats were out of the way only while collapsed, and opening it pushed the Inbox off screen. With Unsettled gone, Settled is the one section that can hold every chat the profile has had, so it earns its own scroll again.
- **Archived as a second drawer.** Two drawers at the foot would leave little room for the scroll, and Archived is off until the owner turns it on.
- **Leaving the cleared chats in the Inbox.** The owner had already said they were done with them; putting them back would undo that across the whole list at once.

## Consequences

- **ADR 0063**: the list has six sections, not seven (ADR 0085 added Pinned), and Settled is a drawer, not a section in the scroll. Collapsing works the same for every section; for Settled, collapsed is the drawer closed.
- **ADR 0036**: an Active chat shows in Snoozed, Working or the Inbox. There is no fourth place.
- **ADR 0002**: Settled chats are in a drawer at the list's foot again.
- A row's right-click menu gains Settle and Unsettle, where Clear from the Inbox was. Before, they were only the row's hover button and the chat header's More menu, so with Clear gone the menu would have had no way to clear a chat.
- A row that moves between the scroll and the drawer (settled or unsettled with the drawer open) is drawn anew, so it doesn't keep focus or an open menu. A closed drawer already drew no rows.
- The migration settles chats on Hermes, which other Hermes clients will show as unpinned. That is what pressing Settle on each would have done.
- Tests find the drawer by `data-drawer="settled"`, its header by `data-section-head="settled"`, and its rows by `data-section="settled"`.
