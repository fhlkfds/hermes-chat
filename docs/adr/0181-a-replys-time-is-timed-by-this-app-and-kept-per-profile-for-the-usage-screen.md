# A reply's time is timed by this app and kept per profile for the Usage screen

> **Accepted.** The timing is in `src/hermes/transport.ts` (`turnBegan`, at `message.start` and `message.complete`), the kept times and their summary in `src/hermes/replyTimes.ts`, the reply's line in `src/ui/Usage.tsx` and the Usage screen's Reply time section in `src/ui/UsageAnalytics.tsx`.

The owner wants to see how long each reply took beside its tokens, and how long replies take on the Usage screen (ADR 0026). Hermes records no time per reply. `message.complete` carries the text, status and usage counters but no time (`tui_gateway/prompt_turn.py` at `b200f5bc`), and a stored session row keeps only `started_at`, `ended_at` and `last_activity_at` (`hermes_state_common.py`). Its messages have a timestamp each, but reading every chat's messages to work out reply times would mean one request per chat, with every message's text, for up to 5,000 chats a period.

## Decisions

- **The app times a reply from Hermes's `message.start` to its `message.complete`.** That is Hermes's own turn, so the time includes every model call, tool call and wait on an Approval or Clarify in it, and not the moment between the owner pressing Send and Hermes taking the message. A turn the app didn't see start, as after a reconnect part of the way through it, isn't timed. The time is kept on the reply's usage (`ReplyUsage.ms`) and saved with it in the Saved copy, so it shows wherever the reply's usage shows.
- **The time ends the reply's usage line.** "8.3k in · 53.5k cache · 249 out · 12.4 s". Its breakdown has a Time row and says the app timed it. A reply with no usage has no line, so no time either.
- **Each finished reply's time is kept on this computer.** One list per connection and profile (`hermes-chat.reply-times.` and the scope), the newest 1,000, each entry the chat's id, when it finished and how long it took. It is listed in `PROFILE_KEYS` (ADR 0156), so renaming a profile moves it, and deleting the profile or removing the connection forgets it. A reply that was stopped or failed isn't kept, since it ended early.
- **The Usage screen sums up the kept times of the chats it counts.** The Reply time section shows the typical (median), average and longest reply, and how many replies were timed in how many of the chats shown. It follows the period, profile, project and model filters, since they pick chats. A compressed chat's replies count under any of its segments' ids. Its note says Hermes doesn't record reply times, so only replies this app watched finish count.

## Considered options

- **Working reply times out from Hermes's stored message timestamps.** That would cover replies from every client, but costs a request per chat with all its messages' text. The Run view (ADR 0178) already does this for one reply at a time.
- **Summing up the times in the Saved copies.** Only chats opened lately have one, and clearing the cache deletes them, so the figure would change with what the owner happened to open.
- **Timing from the owner pressing Send.** It adds the wait for Hermes to take the message, and doesn't exist for a turn Hermes started itself, such as returned work.

## Consequences

- Replies from other clients, and replies this app wasn't open for, have no time and don't count on the Usage screen.
- Clearing the cache keeps the reply times; they can't be read again from Hermes.
- A reply with tool calls or questions that waited on the owner counts as long, since the time is the whole turn's.
