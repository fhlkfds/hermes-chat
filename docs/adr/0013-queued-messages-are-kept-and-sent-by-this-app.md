# Queued messages are kept and sent by this app, one after each finished reply

While Hermes replies, the composer stays editable, and Enter or the Queue button adds the message to the chat's queue. Stop is a separate button. The composer's hint says "Enter to queue" whenever Enter queues: while a reply runs, while Hermes isn't connected, and while the chat already has queued messages, so a new message never jumps ahead of them. The queue shows above the composer, in both panes when two panes show the chat. Each message shows its words, how many files it has, its position, and whether it goes next, waits, or is paused. It can be edited in place, moved with its buttons or Alt+↑/↓, and removed with its button or Delete. The queue can be paused and resumed.

The queue belongs to this app, not to Hermes. Legacy `prompt.submit {queued: true}` asks Hermes to hold a message until the running turn ends. Legacy has no call to list, edit, reorder or cancel a held message (research doc, "A legacy `prompt.submit` while a turn runs"). So Hermes Chat keeps the queue itself, and sends a message only when the chat is ready for it:

- the app is running and connected, and shows the chat's profile;
- the queue isn't paused, and none of its messages is being edited;
- no reply is running, the chat isn't loading or sending, and no Approval is waiting;
- the chat has no Failed message, and no message that Hermes may have.

A chat that isn't loaded on this connection is loaded first. Loading reads whether a reply is running, and settles from the history any message that Hermes may have (ADR 0006). Each message goes with `queued: true`: if this app's view is out of date and a turn is still running, Hermes holds the message instead of redirecting or interrupting that turn. Hermes then answers `status: queued`. The next queued message waits for the held message's own turn to start and end, not for the end of the turn it was held behind. Two messages held together could be merged into one turn.

A message has these states: **queued**, then **sending**, then **confirmed**, **failed** or **unknown**. Queued means it is in the queue. The other states belong to the outbox (ADR 0006). As it goes, the message leaves the queue and enters the chat's outbox in one synchronous step, and each write must be kept on this computer before anything is sent. If storage refuses either write, the message goes back into the queue unsent, and the queue pauses and says storage is full. A crash can't lose the message, and can't leave it in both places. An update's restart holds every queue from the moment it takes its snapshot, so the restarted app can't put back, and resend, a message that went after the snapshot. If the restart fails, the hold is lifted. From then on it is an outgoing message like any other: Hermes's answer confirms it, a refusal marks it failed, and a drop before the answer marks it unknown until the history settles it. Nothing sends it again on its own, so a reconnect or a restart can't send it twice. This app can't promise that Hermes runs a message exactly once. It promises only that it sends each queued message once, unless the owner retries it.

The queue pauses on its own, with the reason shown, when the owner should look before the next message goes:

- the last reply was stopped, ended with an error, or failed;
- Hermes asked for an Approval during the last reply;
- a queued message didn't go, or may not have gone;
- the connection dropped, so the end of the reply went unseen;
- the queue was loaded from this computer, at launch or when switching back to its profile.

Resume lets the queue go again. The next message still waits until a Failed message, or one Hermes may have, is retried, dismissed or settled.

The queue is kept in webview local storage under `hermes-chat.queue.`. Each connection, profile and chat has its own key, as drafts and the outbox do. A chat holds up to 20 queued messages. Attachments stay as paths to files on this computer, and the queue keeps its screenshots: they go once the message is confirmed, removed, or dismissed after failing. Startup cleanup keeps them (`outboxAttachmentPaths` includes the queues). If storage refuses a write, the queue says so and is kept in memory until the app closes. It is also kept across a profile switch and in an update's restart snapshot (`DRAFT_PREFIXES`). Clear local cache keeps the queues, as it keeps drafts. Deleting a chat discards its queue.

## Considered options

- **Hermes's own queue (`prompt.submit {queued: true}` while the turn runs).** Hermes would keep the messages across the app closing. Rejected as the queue itself: legacy can't list, edit, reorder, cancel or pause a held message. Queued messages would also send whatever followed an Approval or a failure. It is kept as a safety net for each send.
- **Sending while the reply runs, the way Hermes's default `busy_input_mode` treats it.** Rejected: the default `interrupt` cuts the running reply short or redirects it.
- **Sending the next message as soon as the reply ends, whatever happened in it.** Rejected: a stopped or failed reply, or one that needed an Approval, can make the next instruction wrong.
- **Leaving a queue running after a restart.** Rejected: while the app was closed, the chat may have run, failed or waited for an Approval, and nothing saw it. The owner checks the chat and resumes.

## Consequences

- Queued messages go only while Hermes Chat is open, connected and showing their profile. Closing the app, signing out, or switching profile leaves them waiting on this computer, never on the server. Other Hermes clients and computers don't see them.
- An unknown queued message that the history read back can't settle (ADR 0006) holds the rest of the queue. The owner retries or dismisses it.
- Attachments are paths: a file moved or deleted before its message goes makes that message fail, with "Couldn't attach …", and the queue pauses.
- If localStorage is full, the queue lasts only until the app closes. The panel says so.
- A server on the canonical protocol isn't supported (README). If Hermes Chat supports it later, `prompt.receipt` and `prompt.resolve_unknown` could settle an unknown send more directly than reading history.
