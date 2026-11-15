# Returned work shows as an open result card, from Hermes's display kind

When a chat's reply hands work off and the work comes back, Hermes starts a new turn in the chat by itself (ADR 0096). The row that begins that turn is a user row holding Hermes's notice to the model: `[ASYNC DELEGATION COMPLETE — …]` for a background subagent, `[IMPORTANT: Background process …]` for a process started with `notify_on_complete` (`tools/process_registry_notifications.py` at `bf0203a`). The app showed that row as it is, in a bubble that looked like the owner had typed it. The result sat under a wall of instructions written for the model, and the owner didn't find it.

## Decisions

- **Hermes's display kind decides.** A stored user row whose `display_kind` is `async_delegation_complete` or `process_complete` is a **Returned result** (`src/hermes/returned.ts`). Hermes sends both fields on `session.history` rows (`tui_gateway/session_history.py`) and in the stored REST row. Every other row stays as it was: steered messages, hidden rows, `[System:` rows, and a kanban wake's one-line notice, which has no display kind.
- **Its title is Hermes's.** The card's title is `display_metadata.display_text`, the line Hermes writes for people, such as "Subagent Task Completed: audit backups". `display_metadata` comes as an object or as its JSON text, and both are read. With no title, the card says "Background work finished" or "Background process finished".
- **Its body is the result only.** The model's envelope is stripped as the official desktop app's `asyncResultBody` does (`apps/desktop/src/lib/chat-messages/hydration.ts`): the text after `--- RESULT ---` or `--- ERROR ---`, each process's block without the batch header, a cron job's output, and no trailing transcript path. A batch keeps each task's number, outcome and goal above its result, which the desktop drops, so the owner can tell the results apart. If nothing is left, the body is the whole stored text, so a result is never lost.
- **It is open from the start.** The desktop shows these rows as a collapsed timeline line. Here the card is on Hermes's side of the transcript with the body showing, because the result is what the owner waited for. The header closes and opens it. A subagent's answer renders as Markdown, as a reply does. A process's output renders as a log. A long body scrolls inside the card.
- **It begins a turn, as the row did.** It counts where the owner's message would for where a turn starts, so a wake turn's reply, usage and tool calls stay with it. It keeps its place in the turn numbering that branches and versions use, because Hermes counts it as a user row. A reply to returned work offers no Regenerate: it answers no message of the owner's. A live wake turn reads the row back by its stored id, as before, and shows the card in its place.
- **It is kept and exported.** The Saved copy keeps it. A JSON export writes it back as a user row with its display kind and title, and a Markdown export as a **Returned:** block that Import reads back the same way.
- **A turn that ends in an error is over.** A turn started from here was forgotten only on `message.complete`. One that ended in an `error` stayed remembered, so the next wake turn counted as the owner's own and its result showed only once the chat was opened again. Now an error ends it too, unless a wake turn was the one that failed.

## Considered options

- **The desktop's collapsed timeline line.** It hides the result behind a click, and the owner's problem was not seeing it.
- **Stripping the envelope by matching its text alone.** The display kind is Hermes's own statement of what the row is; text matching would also catch a message the owner pasted.

## Consequences

- A row Hermes stored with no display kind, such as one from before display kinds, still shows the raw notice in a user bubble. `session.history` infers a kind for some untyped rows, but not for these two.
- Extensions reading a chat (`chat.read`) don't get Returned results, only the owner's messages and Hermes's replies.
- A kanban task's sheet on the Work page also shows the task's `result`, the answer its completion recorded, when it says more than the latest summary.
