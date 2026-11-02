# Archive is Hermes's `archived` flag, separate from Settle, and confirmed by reading it back

Archive and Restore write only the session's `archived` flag (`PATCH /api/sessions/{id} {archived}`), through the same fenced single-session write as Settle (`request_id` plus the revision from the mutation snapshot). They never touch `pinned`, so a restored chat comes back Active or Settled as it was, and settling never archives. After every write, whether Hermes answered, refused or the answer was lost, the app reads the session back (`GET /api/sessions/{id}`) and shows the chat as Hermes has it. Only that read-back decides whether the archive or restore worked.

## Considered options

- **Archive by unpinning too.** The official desktop app drops its own pin when it archives. Rejected: here `pinned` is Active (ADR 0002), so archiving would also settle the chat, and restoring would lose where it was.
- **Retry any revision conflict, as the pin and read writes do.** Rejected for this flag: a conflict can be another client archiving or restoring the same chat, and retrying would overwrite that newer change. The archive goes again only while Hermes still has the flag as the owner saw it. If the flag already matches, there is nothing to write. Otherwise the chat shows as Hermes has it, and the list says why.
- **Trust the PATCH answer.** Rejected: a lost answer over the tunnel says nothing about whether the edit committed. When the read-back fails too, the chat stays where the owner put it and the next refresh reads it back before claiming either way.

## Consequences

- A pinned (Active) chat that is archived is still listed by `GET /api/sessions`, because Hermes back-fills every pinned row whatever its `archived` flag. The app hides it by that flag. The official desktop app, which keeps its pins separately, may still show it.
- The archived view lists `GET /api/sessions?archived=only`, which back-fills the pinned chats that aren't archived too; the app keeps only the archived rows. It is read only while the view is open.
- Search asks Hermes for archived chats with every query, as Hermes has no option to leave them out. Leaving them out is the app's filter.
- A chat with a reply running is neither archived nor restored, so archiving never stops a reply. A chat archived in another client while its reply runs here stays on screen, and the reply keeps running.
- A conflict that keeps an edit from landing twice in a row (another client editing the same chat continuously) shows the chat as Hermes has it, with the reason. The owner can archive it again.
