# Edit and Regenerate replay a message in a new branch

**Edit**, under a message of the owner's, and **Regenerate**, under the last reply of a turn, both send an owner's message to Hermes again. The chat they come from stays exactly as it was. Each makes a new branch with Branch from here's contract (ADR 0027), then sends the message in that branch in place of its copy. Edit sends the new words. Regenerate sends the message as Hermes stored it. Hermes answers in the branch. The failed-send Edit, which takes a message Hermes didn't take back into the composer, is a different action and is unchanged.

## The calls

Probed live on 2026-11-03 against the deployed Hermes (`f0d9488`, which includes `bf0203a`; the truncation code is unchanged between the two), with a throwaway `HERMES_HOME`, seeded synthetic chats and a loopback stub model (research doc, "Edit and Regenerate"):

1. `session.branch {session_id, count, idempotency_key}` with `count` reaching **through** the owner's message. The branch's last spine row is the copy of that message. Everything ADR 0027 does around this call still applies: the preview's fingerprint, the re-check just before the call, the read-back, the idempotency key and the recovery of a lost answer, the model switch, and the local link.
2. The branch's stored rows are read back to find that copy's row id.
3. `prompt.submit {session_id, text, truncate_before_row_id: <copy>, confirm_truncate: true}` in the branch, with `confirm_empty_truncate: true` when nothing comes before the message. Hermes (`_truncate_history_for_submit`, `tui_gateway/methods_prompt.py`) replaces the copy and anything after it with the new message, and keeps the replaced rows archived (`active = 0`). The model gets the branch's history before the message, then the message.

Read back afterwards on the live server: the original's 11 stored rows were unchanged. The branch held the copied rows before the message, the edited message and the new reply. `count: 0`, or no `count`, copies the whole chat, so step 1 can't stop *before* the first message. Going through it and replacing the copy covers the first message too. Without `confirm_empty_truncate`, Hermes refuses that case with 4028.

The app never calls `prompt.submit` with a cut in the chat the owner is looking at. That would rewrite its stored transcript and hide every later message.

## What is sent

- **Edit:** the `@file:` refs the stored message starts with (as this app sends files), then the words the owner typed. The dialog opens with the stored words after those refs. A ref inside the words is part of the words.
- **Regenerate:** the stored message, unchanged, refs included. Hermes reads those files again from the server, if they're still there.
- **A message sent with an image** can't be replayed. Hermes stores the image apart from the words, and this app can't send it again. The dialog says so and offers Branch from here instead.

The dialog lists each file the message names and whether it's still on the server, as ADR 0027's preview does. A missing file must be acknowledged first.

## What the dialog says first

Before anything is sent, the dialog reads the chat's stored rows and shows:

- the edited words (Edit), with **Save as branch** and **Cancel**. Save stays disabled until the words change, and Regenerate is suggested for the same words.
- how many messages the branch starts with, and whether the project's hidden instructions are among them.
- the later messages the branch leaves out. These are the messages after the owner's message (for Regenerate, after the reply's own turn), with their first words. They stay in the original.
- how many tool calls ran after the message, and that nothing Hermes did is undone: changed files, commands run and messages sent stay as they are.
- the model.

## Version check

The preview keeps two fingerprints of the chat's stored rows (`spineKey`, no text kept):

- the rows the branch copies;
- the whole chat: how many rows there are, the newest row's id, and every spine row's words.

Both are read again before `session.branch`. If another client added, removed or changed any message, the app refuses and nothing is made. ADR 0027's own check covers only the copied rows. Edit also has to know that the later turns it says it leaves out are still the ones there.

## When it isn't offered

- A reply is running (a tool call included) or being stopped. Stop alone isn't enough: the turn must have ended, as Hermes confirms with `message.complete`.
- An Approval waits, a message isn't confirmed, or the chat is still loading or showing a Saved copy.
- Hermes isn't connected.
- This connection's Hermes answered `session.branch` with "method not found". Edit and Regenerate then say why, until the next connection.

The buttons stay, with the reason on hover, and the dialog opens with the reason and no way to send.

## Answers and edits

Each branch's link (ADR 0027) also keeps:

- what it replays: Edit or Regenerate, the owner's message by its stored row in the original, its first words, the edit's first words, `count`, and the replayed message's row in the branch once Hermes says;
- the model and settings the branch ran on when the message went, as Hermes reported them after the switch to the original's model.

Under a reply, the switch goes from **Answer 1** (the reply in this chat) to each Regenerate branch of the same owner's message, oldest first. Another answer is read from its branch's stored rows: the replies after the replayed message, up to the owner's next. It is read again when that branch's reply ends. Each answer shows:

- its model and settings;
- the message sent again;
- a link to open its branch.

Hermes doesn't record which model wrote an older reply, so Answer 1 names a model only when this app saw the reply written. After Regenerate the chat stays where it is, showing the new answer. After Edit the branch opens.

Under an owner's message, **Edited in** links to each branch it was edited in. At the top of a branch, the note says which message it edits or answers again, with a link back.

## Failures

- **The branch call fails, or its answer is lost.** ADR 0027 applies, and nothing is sent.
- **The branch can't be read back** to find the copy, or the profile changes first. The branch is kept as a plain branch ending with the original message, nothing is sent, and the owner is told.
- **Hermes refuses the message**, for example a busy session. It stays in the branch as a Failed message with its cut. Retry sends it again the same way. Hermes refuses a cut whose row is gone (4018), so a retry can't stack a second copy.
- **The connection drops before Hermes answers.** The message is Unknown, and the history read back settles it. The new row must be newer than the replaced one, since a regenerated message has the same words as its copy.
- **Hermes answers without `survivor_user_row_ids` or `survivor_row_id_map`.** It ignored the cut, as a Hermes older than the truncation parameters would. The owner is told that the branch keeps the original and has the message after it.

## What is kept where

- **Hermes keeps:** each branch, its rows (the replaced copy archived), and `parent_session_id`.
- **This computer keeps:** what each branch replays and its model, in the branch's link (`hermes-chat.branches.`, per connection and profile). A failed replay's cut is kept with its outbox row. Another computer sees the branches as ordinary branches, without the switch between answers.

## Considered options

- **`prompt.submit` with a cut in the chat itself**, as the official desktop app's rewind does. Rejected: the later messages leave the chat, and the issue requires them to stay available.
- **`session.branch` with `count` up to the message before, then an ordinary send.** This needs no cut. It can't edit or regenerate the first message, because `count: 0` copies the whole chat, and it would need two code paths.
- **Copy text into `session.create {messages}`.** Rejected in ADR 0027.
- **Show other answers by reading them from Hermes's archived rows.** Hermes doesn't list archived rows by default, and the original is never cut, so there are none to read.

## Consequences

- Every Edit and Regenerate is a new chat in the list, Active, named as Hermes names branches (`Backup plan #2`).
- An answer's switch exists only on the computer that made it, as the branch point does in ADR 0027.
- Verified against the tests' fake Hermes and live against the deployed `f0d9488`. The canonical protocol and other Hermes versions weren't tested.
