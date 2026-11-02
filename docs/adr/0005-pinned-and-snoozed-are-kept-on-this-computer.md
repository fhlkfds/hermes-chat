# Pinned and Snoozed are kept on this computer, and a snooze wakes through Hermes's flags

The chat menu adds two states Hermes has no column for. **Pinned** keeps an Active chat at the top of the list. **Snoozed** settles a chat until a set time, then brings it back Active and unread. Both are kept in this app's local storage, per profile (`hermes-chat.marks`). Clearing the cache in Settings doesn't touch them.

What each one changes on the server goes through flags Hermes already has (ADR 0002). Pinning a Settled chat pins it on the server, because it becomes Active. Snoozing unpins it, because it becomes Settled. When a snooze wakes, the app sends `PATCH {pinned: true}` and `PATCH {unread: true}`, so the chat comes back Active and unread in every Hermes client, not only here.

## Considered options

- **Hermes's `pinned` flag for Pinned.** It already stores Active (ADR 0002), so it can't mean both.
- **Hermes's `hidden` or `archived` flag for Snoozed.** Both hide the chat in the official app and the dashboard, which a snooze shouldn't do. Archived chats also leave this app's list.
- **Encoding the state in the title.** It would show up in every Hermes client and break search by title.

## Consequences

- Pins and snoozes don't follow the owner to their other computer, unlike Active and Settled. On the other computer a Pinned chat is an ordinary Active chat and a Snoozed one is Settled, until it wakes.
- A snooze wakes only while this app is running and connected. A wake time that passed while the app was closed fires at the first list sync after connecting. Snoozes in other profiles wake too, by REST with that profile.
- The other machine can contradict the local state. When the list shows a Pinned chat as Settled, it's unpinned, and when it shows a Snoozed chat as Active, the snooze ends.
- Pinned and Snoozed chats stay in the list however old they are, so the month-long window never hides them.
