# A queued message is dragged to its place, as a tab is

ADR 0018 let a queued message move one place at a time, with its ↑ and ↓ buttons or Alt+↑/↓. Moving the last of a
long queue to the front took a click per place (#217).

## Decisions

- **Drag a row to a place.** Each queued message's row can be dragged within the queue. A grip at its left shows it.
  While dragging, a bar marks where it will land: on the border of the row it goes in front of, or under the last row.
  It lands in front of the first row whose middle is below the pointer, the same rule a tab strip uses (`slotAt` in
  `bits.tsx`). Over the queue's head it goes first, and over its foot last.
- **The ↑ and ↓ buttons are gone.** Dragging replaces them. Alt+↑ and Alt+↓ on a focused message still move it one
  place, and focus stays on it. After a drop, focus goes to the moved message too. Tab now goes from a message to its
  Edit and Remove buttons, then to the next message.
- **A place, not a step.** The queue's move takes the place the message ends at (`QueueApi.moveTo(id, index)`,
  `moveQueued(chat, id, index)`), past either end meaning that end. A drop knows a place, not a number of steps, and
  Alt+↑/↓ is the place above or below. The relative `move(id, by)` is removed.
- **The same mechanism as tabs (ADRs 0046 and 0052).** It is HTML5 drag and drop. The drag carries only its own type,
  `application/x-hermes-queued`. The message being dragged, and its chat, are kept in a module variable, trusted only
  while a drag carries that type, because a drag's data can be read only on drop. A drop that would leave the message
  where it is shows no mark, and the pointer shows the drop is refused.
- **Inside the queue only.** Only a queue showing the dragged message's chat takes the drop: in either pane, since both
  show one queue. The drag carries no text, so the composer, the tab strip and the pane don't take it. Dropped anywhere
  else, nothing happens. A chat dragged from the chat list over the queue is still the pane's to take, as before.
- **Not while being edited.** A row whose words are being edited can't be dragged, and a text selection dragged out of
  its edit box isn't taken as the message. The other rows still move around it.
- **A message that goes mid-drag.** A message leaves the queue in the same step that makes it a sending message
  (ADR 0018), so a queued row is never one that is sending. If the dragged message goes before the drop, the drop
  finds it gone and changes nothing.

## Considered options

- **Pointer events in place of HTML5 drag and drop.** Rejected: the app would have two drag behaviours. HTML5 drag and
  drop works in the WebKitGTK webview for tabs, and was checked for the queue in the running app with real pointer
  drags.
- **Keeping the ↑ and ↓ buttons beside the grip.** Rejected: the issue asked for them to go, and each row had four
  buttons. The keyboard way stays.
- **Computing a step for the old `move(id, by)` from the drop.** Rejected: two meanings of a place for one call, and
  the step is wrong if the queue changes between the mark and the drop.

## Consequences

- Text in a queued row can't be selected with the mouse, since a press on it starts a drag. Edit shows the words in a
  box where they can be selected.
