# Send now steers a queued message into the running reply, and stops it only when it can't

> **Accepted** (#643). It supersedes [ADR 0182](0182-send-now-stops-the-reply-and-sends-one-queued-message-next.md). `sendNowRoute` and `Rush` in `src/hermes/model.ts`, `Hermes.sendQueuedNow`, `pump` and the reply-end pause in `src/hermes/transport.ts`, and the row's Send now button in `src/ui/Queue.tsx`.

Send now on a queued message stopped the running reply (`session.interrupt`) and sent the message as a new turn (ADR 0182). That threw the reply away. Usually the owner wants the reply to keep its work so far and take the new message into account, as a typed `/steer` does (ADR 0057). ADR 0182 considered steering and rejected it, because a steer carries words only and lands only at the reply's next step. This ADR keeps stop-and-send for the cases a steer can't cover, and steers in every other case.

## Decisions

- **One rule picks the route, `sendNowRoute`.** The row's tooltip and `sendQueuedNow` both call it, so the tooltip always names what the button does. The route depends on the reply and the message:
  - No reply running, or a reply already being stopped: the message goes next, as before (**send**).
  - A reply running and the message has files: the reply is stopped and the message goes next, as in ADR 0182 (**stop**). A steer carries only words.
  - A reply running and `/steer` can't run in this chat (`commands.why(STEER)`: Hermes doesn't list it, a quick or plugin command replaced it, the check is unsure or still running, or the chat is still loading): **stop**, as above.
  - Otherwise: **steer**.
- **A steer goes through `Hermes.steer`**, the same `command.dispatch` `/steer` as a typed `/steer` and a steered follow-up (ADR 0057). The reply isn't stopped and the queue isn't paused. Once Hermes takes the words, the message leaves the queue and shows at the end of the transcript marked "Steered into the reply". The rest of the queue waits for the reply to end, as usual.
- **The mark records a steer still waiting for Hermes's answer.** `ChatQueue.rush` becomes `Rush = { id, steering }`. While `steering` is set, the message keeps its place in the queue, its row shows **Now**, its Edit button is off, and the queue's state line reads "Steering yours into the reply. It joins at the reply's next step…". None of the chat's queue goes until Hermes answers, and Send now is off on every row of that queue. If the reply ends first, sending the next message on a guess could put it ahead of the one the owner chose, or race the turn Hermes starts for a late steer. The mark lives only in memory, as in ADR 0182.
- **What Hermes's answer does:**
  - Taken: the message leaves the queue, as above.
  - `"not running"` (the reply ended, or its agent wasn't ready): the mark stays, without `steering`, and the message moves to the front. It goes next through the queue's usual send (`pump`), ahead of the rest, past a pause, and without a stop.
  - Refused: the message stays where it was, the mark is cleared, and the queue isn't paused. The row says "Hermes didn't take it as a steer:" and Hermes's reason. The note shows in the pane where the owner pressed Send now.
- **An open edit holds the steer.** While a queued message is being edited, in either pane, Send now doesn't steer: the steered words could differ from what the owner saves. The message is marked to go next instead, and goes once the reply ends and the edit closes, with the saved words. ADR 0182 already let an open edit hold a marked message.
- **A reply that ends during a steer pauses the queue by the usual rules.** Only a mark without `steering` skips the pause after a stopped, failed or Approval-holding reply, because only then did the owner choose to end that reply. A pause clears the mark, so a late `"not running"` leaves the message in the paused queue for the owner.
- **Pause, removing the message, a dropped connection or a profile switch cancel the mark**, as in ADR 0182. A steer Hermes already took can't be recalled, so its message leaves the queue when the answer arrives, even from a paused queue. Otherwise a later Resume would send it a second time. A profile switch closes the connection, so the answer to a steer still waiting never arrives. The message then stays in the queue, which comes back paused, as after a dropped connection.
- **The tooltip says when "now" is.** "Send now: steers it into the reply at its next step (Ctrl+Enter)". For **stop** it reads "Send now: stops the reply." with the reason, and with no reply running "Send now (Ctrl+Enter)". The button's name adds ", steering it into the reply" or ", stopping the reply".
- **No separate stop-and-send action.** Stop, then Send now, does it: a reply already being stopped takes the **send** route, and Send now goes past the pause that the stop causes.

## Considered options

- **Keep stopping the reply (ADR 0182).** The owner loses the reply's work so far, which is rarely what they want. Rejected.
- **Take the message out of the queue while the steer waits, into a slot of its own.** Edit, remove and move couldn't reach it, so they need no checks. But a message would then live in two places, the stored queue would need to save the slot, and a crash during the request would need extra code to bring the message back. Turning Edit off on that one row covers the same case. Rejected.
- **Let the transport read the `/steer` check itself.** The check lives with the chat's command list in `App.tsx`. Reading it from the transport would need a second copy of that list, and the tooltip could then disagree with the action. The app passes `commands.why(STEER)` in, and both the row and the transport call `sendNowRoute` with it.
- **Show a refusal by pausing the queue with the reason.** A refused steer leaves the reply running and the queue in order, so a pause would hold the other messages for no reason. Rejected.
- **A second row action, or Ctrl+Shift+Enter, to stop and send.** Stop followed by Send now already does it. Rejected until the owner asks.

## Consequences

- A steer lands after the reply's next tool call. If the reply makes no more tool calls, Hermes runs the words as the next turn itself (`pending_steer`, ADR 0057). The next queued message then asks Hermes to hold it behind that turn (`queued: true`), and Hermes decides the order.
- Stopping the reply after Hermes took a steer drops the steer (ADR 0057), though the transcript shows it until the chat is read again.
- After a dropped connection, the app can't tell whether Hermes took a steer that was waiting for an answer. The message stays in the paused queue, and the history read on reconnect shows a steer row if it landed. Nothing sends it again on its own.
- A message with files, or a chat where `/steer` can't run, still stops the reply, as in ADR 0182.
