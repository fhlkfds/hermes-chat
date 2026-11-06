# A side question shows in the transcript where it was asked, and is never an item

Issue #260. A `/btw` side question (ADR 0070) showed as a card above the composer, apart from the transcript. The owner wants it in the transcript, where it was asked, as a pair of messages: theirs, then Hermes's. Each message is marked as a side question that isn't part of the conversation. ADR 0070's rule stays: a side question is never saved and never goes back to Hermes. This ADR replaces ADR 0070's decision about the cards above the composer and their scrolling. The rest of 0070 stands.

## Decisions

- **Side questions stay out of the chat's items.** They stay on `Chat.sideQuestions`, apart from `Chat.items`. Only the transcript's rendering merges the two lists. The Saved copy, exports, branches, the chat list kept on this computer, Edit and Regenerate all read `items` or Hermes's stored rows, so none of them can see a side question. No save path needs a filter, and a new save path gets the same rule without a change.
- **A side question remembers the item it was asked after.** `SideQuestion.after` is the id of the chat's last item when it was asked, or none when the chat had no items. The transcript shows it right after that item. A reply streaming when it was asked goes on growing above it, and anything after that (a tool call, the next reply, the next message) shows below it. An item put in before it, such as the "Thought" Hermes sends with the reply's reasoning at the turn's end, can't move it. Side questions after the same item show in the order they were asked. A run of tool calls that a side question falls inside shows as two groups.
- **When that item goes, the side question takes its place.** Hermes's history has new item ids when the chat's items are read again, as after a reconnect, and an Edit or another client taking a turn back cuts them short. Whenever the chat's items change and a side question's item isn't among them, it moves to the item now at that item's place in the list, or to the last item if the list is shorter. From then on it stays after that item, so a message sent later shows below it.
- **An item id, not a count or a time.** A count of the items before it moved whenever an item went in before that point: a Thought put before the reply as the turn ended moved the side question above the reply it was asked during. Items streamed in this session have no stored time, so a time would have nothing to compare with.
- **Shown as a pair of messages, marked and tinted.** The question is on the owner's side, and the answer is on Hermes's side. Both have a dashed border in the accent color and the tag "Side question · not part of the conversation". The answer shows the same states as the card did: a waiting line, the answer as Markdown with Copy, or why there's no answer. One Dismiss button takes away the pair. Neither message has a stored time, Edit, Regenerate, Branch or Read aloud, and the status bar's jump to a time skips them.
- **Asking one scrolls the transcript to the bottom,** where the new question shows, as sending a message does. The composer keeps its whole height.

## Considered options

- **Side questions as a kind of item.** That puts them where they were asked by construction. But every reader of `items` would then need to leave them out: the Saved copy, the Markdown and other exports, branching, Edit and Regenerate, turn counting, the queue and the history merge on resume. One missed filter would save a side question or send it to Hermes. Rejected.
- **Keeping the cards and adding a marker in the transcript.** This keeps the composer area crowded, which is what the issue asks to fix.

## Consequences

- Dismissing a side question still drops any answer that comes later (ADR 0070).
- A transcript read again from Hermes, as after a reconnect, can put a side question a few messages away from where it was asked, when the history read has more or fewer items before it than were shown. It still never moves after that.
- Text that streams into a reply after a side question was asked shows above the side question, since the reply is one item.
- Find in chat doesn't search side questions, as it didn't search the cards.
