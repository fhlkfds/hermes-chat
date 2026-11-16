# Send now stops the reply and sends one queued message next

> **Accepted.** `Hermes.sendQueuedNow` and the `rush` case of `pump` in `src/hermes/transport.ts`, `ChatQueue.rush` in `src/hermes/model.ts`, and the row's Send now button and Ctrl+Enter in `src/ui/Queue.tsx`.

A queued message waits for the reply to end, and after a stopped or failed reply the whole queue pauses until the owner resumes it (ADR 0018). Sending one queued message right away took four steps: press Stop, drag the message to the top, wait for the stop to land, then press Resume. Resume also let the rest of the queue go. The owner wants one action that sends a chosen queued message now.

## Decisions

- **Each queued message has a Send now button**, before Edit, with the composer's send arrow. Ctrl+Enter on a focused queued message does the same. While a reply runs, the button's tooltip and name say that it stops the reply.
- **Send now moves the message to the front and marks it.** The mark is `ChatQueue.rush`, the message's id. The row's badge reads **Now**, and the queue's state line says what it waits for: "Stopping the reply to send yours now…", "Yours goes the moment this reply ends." (when Hermes couldn't stop it), or "Sending yours now…". One message at a time carries the mark. Send now on another message moves the mark to that one.
- **A running reply is stopped through the same `Hermes.stop` as the Stop button** (`session.interrupt`). A chat not loaded on this connection yet is loaded first, since only loading tells whether a reply runs there. The message goes once the reply has ended, by the queue's usual send (`pump`), so it still enters the outbox before anything goes and still asks Hermes to hold it (`queued: true`) should a turn still be running.
- **The stop doesn't pause the queue.** A reply that ends while a message carries the mark skips the pause its end would cause: stopped, failed, or with an Approval or a Question in it (`pauseAfter`). The owner chose to move on from that reply. After the marked message goes, the rest of the queue goes on as before, one message after each reply.
- **The marked message goes past a pause and a Failed message.** A paused queue sends it and stays paused for the rest. A Failed message, or one Hermes may have, stays in the chat for Retry or Dismiss, as it does when the owner sends from the composer. An Approval or a Question still waiting still holds it, and so does an edit open in the queue.
- **Pause, a dropped connection, or removing the message cancels it.** Any pause clears the mark and says what stopped it (`pauseQueueFor`), a chat that couldn't be loaded among them, and a mark on a message that left the queue is dropped (`setQueue`). Resume keeps it. While a message carries the mark, the queue's head offers Pause even on a paused queue, so the owner can take Send now back without removing the message. The mark lives only in memory: a restart or a profile switch brings the queue back paused, as ADR 0018 says, with the message still first.

## Considered options

- **Steer the message into the reply instead of stopping it.** A steer carries only words and arrives after the reply's next tool call (ADR 0057). A message with files couldn't go, and "now" would depend on the reply making another tool call. Follow-up behavior already covers steering. Rejected.
- **Send while the reply runs and let Hermes's `busy_input_mode` decide.** The default `interrupt` would cut the reply and run the message. A profile set to `queue` or `steer` would do something else, and this app doesn't read that setting. Rejected for the same reason as in ADR 0018.
- **Send now as Stop, move to the top, and Resume in one click, with no mark.** Resume would also release the rest of the queue after a reply the owner never looked at, and the stopped reply's own pause would land after the Resume and hold the chosen message. Rejected.
- **A queue-wide "Send next now" in the queue's head.** It sends only the first message, so the owner would still drag the one they want to the top. The row button covers it.

## Consequences

- Stopping a reply drops a steer Hermes hasn't delivered yet (ADR 0057).
- If Hermes can't stop the reply, the marked message goes when the reply ends on its own, and that end doesn't pause the queue.
- Send now on a message while the chat has a Failed message above it sends past it. The Failed message stays where it is.
