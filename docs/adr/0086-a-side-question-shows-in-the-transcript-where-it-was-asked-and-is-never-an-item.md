# A side question shows in the transcript where it was asked, and is never an item

Issue #260. A `/btw` side question (ADR 0070) showed as a card above the composer, apart from the transcript. The owner wants it in the transcript, where it was asked, as a pair of messages: theirs, then Hermes's. Each message is marked as a side question that isn't part of the conversation. ADR 0070's rule stays: a side question is never saved and never goes back to Hermes. This ADR replaces ADR 0070's decision about the cards above the composer and their scrolling. The rest of 0070 stands.

## Decisions

- **Side questions stay out of the chat's items.** They stay on `Chat.sideQuestions`, apart from `Chat.items`. Only the transcript's rendering merges the two lists. The Saved copy, exports, branches, the chat list kept on this computer, Edit and Regenerate all read `items` or Hermes's stored rows, so none of them can see a side question. No save path needs a filter, and a new save path gets the same rule without a change.
- **A side question remembers how many items came before it.** `SideQuestion.after` is the number of the chat's items when it was asked. The transcript shows it after that many items and before the next one. A reply streaming when it was asked goes on growing above it, and anything after that (a tool call, the next reply, the next message) shows below it. Side questions after the same item show in the order they were asked. A run of tool calls that a side question falls inside shows as two groups.
- **A count, not an item id or a time.** Hermes's history has new item ids when the chat's items are read again, as after a reconnect, so an id would lose its place. Items streamed in this session have no stored time, so a time would have nothing to compare with. A count keeps its place while the session runs. After a reload of the items it can be a few items off. If it is past the end, the side question shows last.
- **Shown as a pair of messages, marked and tinted.** The question is on the owner's side, and the answer is on Hermes's side. Both have a dashed border in the accent color and the tag "Side question · not part of the conversation". The answer shows the same states as the card did: a waiting line, the answer as Markdown with Copy, or why there's no answer. One Dismiss button takes away the pair. Neither message has a stored time, Edit, Regenerate, Branch or Read aloud, and the status bar's jump to a time skips them.
- **Asking one scrolls the transcript to the bottom,** where the new question shows, as sending a message does. The composer keeps its whole height.

## Considered options

- **Side questions as a kind of item.** That puts them where they were asked by construction. But every reader of `items` would then need to leave them out: the Saved copy, the Markdown and other exports, branching, Edit and Regenerate, turn counting, the queue and the history merge on resume. One missed filter would save a side question or send it to Hermes. Rejected.
- **Keeping the cards and adding a marker in the transcript.** This keeps the composer area crowded, which is what the issue asks to fix.

## Consequences

- Dismissing a side question still drops any answer that comes later (ADR 0070).
- A transcript read again from Hermes, as after a reconnect, can put a side question a few messages away from where it was asked.
- Find in chat doesn't search side questions, as it didn't search the cards.
