# Edit and Regenerate branch through the message, then take the branch's copy back

**Edit**, under a message of the owner's, sends a changed version of it. **Regenerate**, under the last reply of a turn, asks Hermes for another answer to the message that turn answered. Neither changes the chat it is asked from: its stored messages, its answer and everything after stay as they were. Each makes a new chat, a **Branch** (ADR 0027), holding another version of that turn.

This is a separate action from the Edit of a Failed message, which takes the words of a message Hermes didn't take back into the composer. That Edit is unchanged.

## How a version is made

Hermes has no call that replays a session from a message boundary into a new session. So each version takes three steps, all with legacy calls the deployed server has:

1. **`session.branch {session_id, count, idempotency_key}`** through the owner's message, exactly as Branch from here does from that message. The boundary, the fingerprint of the copied rows, the re-check just before the call, the read-back, recovery after a lost answer, the switch to the parent's model, and the refusals while a reply runs or an Approval waits all come from ADR 0027.
2. **`session.undo {session_id}`** on the **branch's** live session. It takes the last user turn out of that session's history, which is the branch's copy of the owner's message. The parent is never sent `session.undo`.
3. **`prompt.submit`** in the branch, through the app's usual send and outbox (ADR 0006, 0018). Edit sends the owner's new words, after the `@file:` refs the original was sent with, so its files go with it. Regenerate sends the message exactly as Hermes stored it.

Branching through the message and taking it back is needed because `session.branch` reads `count = 0` as "copy everything". So a branch can't end before a chat's first message, and the first message is the one owners most often want to edit. Branching through it and undoing it works the same for every message. The steps were probed live on 2026-11-03 against the deployed checkout, with a throwaway `HERMES_HOME`, a stub model and a seeded synthetic chat (research doc, "Edit and Regenerate"):

- A branch with `count = 1`, then `session.undo`, answered `{removed: 1}` and left the branch with no stored rows. A second `session.undo` answered `{removed: 0}`.
- A `prompt.submit` then stored the edited message and its reply as the branch's only rows.
- Rows `session.undo` took back aren't in `GET /api/sessions/{id}/messages`.
- A message with an `@file:` ref, sent again as stored, reached the model with the file's context.
- `session.undo` during a running turn was refused with 4009 `session busy`.
- The parent's 8 rows were unchanged afterwards.

After `session.undo`, the app reads the branch's stored rows back. They must be exactly the rows before the message, by the same fingerprint as ADR 0027. If they aren't, nothing is sent, and the owner is told to look at the branch. A Hermes without `session.undo` (−32601) gets the branch deleted again, with "This Hermes server can't take a message back". A Hermes without `session.branch` is refused before anything is made, as in ADR 0027.

## What can't be sent again

- **Images.** A message sent with an image shows `[image]` in its stored text. Hermes keeps the image as it saw it, not as a file the app could attach again, and Hermes's own `/retry` refuses "attached media" for the same reason. Edit and Regenerate are refused for such a message, and the owner is told to branch from the message before it and attach the image again.
- **Files.** A file sent with a message is an `@file:` ref to a path on the server, so it can be sent again while it's there. The preview checks each one, as Branch from here does. A file no longer there must be acknowledged before the version is made.
- **Side effects.** Nothing is undone on the server. Files Hermes changed, commands it ran and anything it sent after the original message stay as they are, and the preview says so before anything goes. Taking a message back with `session.undo` changes only the new branch's history.

## When it can't be made

Edit and Regenerate are refused, with the reason on the button and in the dialog, whenever Branch from here is (ADR 0027). Two cases get their own wording:

- **A reply or its tools are running.** The owner stops it or waits. Edit and Regenerate work again once Hermes says the turn ended. While a stop is on its way, they say so.
- **Another client changed the chat.** The preview keeps a fingerprint of the chat's whole spine, not only the copied part. If another client added or changed a message before the owner confirms, nothing is made, and the owner is asked to look again.

## The dialog

- **Edit** opens on the message's words as Hermes stored them. Its buttons are **Save as branch** and **Cancel**. Escape or a click outside doesn't close an edit that has changes.
- **Regenerate** shows the answer that stays in this chat.

Both list:

- what the new branch leaves out: the message, every message after it and the tool calls among them, which stay in this chat;
- how many messages the branch starts with;
- the files and their state;
- the model and its settings.

The composer's Draft is never touched. The new branch opens with its own empty Draft.

## Versions of a turn

A version is numbered by its **turn**: how many of the owner's shown messages come before it. That number is the same in a chat and in every branch copied from it, since a branch copies every message before the message. A version records:

- its kind, Edit or Regenerate;
- its **root**, the chat whose turn it is another version of;
- its turn;
- the model and settings Hermes reported for the branch once it was made.

A version of a version's same turn has the same root. A version of an earlier turn of a version has that version's root, since those turns are copies of the root's.

Under the last reply of a turn that has more than one version, the switcher shows which version this chat is, as **2 / 3**. It shows how the version came about (Original, Edited or Regenerated) and the model and settings. Previous and Next open that version's chat in the same pane, at that turn. Hermes keeps no model per reply. For the original, the switcher shows the model its chat runs on now, and says so.

## Recovery

The attempt is kept on this computer before `session.branch` goes, as ADR 0027 does. It also keeps the words to send, and the fingerprints of the rows the branch keeps and of the rows through the
original message. A branch found after a lost answer, or one whose `session.undo` or send didn't happen, keeps those until its message goes. Its top says the message hasn't gone yet, with **Send it now**. That reads the branch's stored rows first and does only what is left:

- If the copy of the original is still there, it takes it back, then sends. The copy must be exactly the message the
  branch was made with, by the fingerprint of the rows through it. If another client changed it, nothing is taken
  back or sent.
- If only the rows before the message are there, it sends.
- If there is more, it sends nothing and says so.

After each read, and again just before the message goes, it checks that the profile and connection are the ones it
started on, that no reply, Approval or other message is under way in the branch, and that the branch holds nothing
new. If any of these changed, it stops, sends nothing, and keeps the words for the next try. A branch left with no
messages has no Saved copy, so the message taken back can't come back after a restart. Whichever way, the branch then shows its history before the message, even when an earlier try took the copy back
and its answer was lost. Only one try runs at a time for a branch, so two panes asking at once take back and send
once. So asking again never sends twice. Once the message goes, the outbox owns it, as any message: a failed send shows Retry in the branch.

## What is kept where

- **Hermes keeps:** each version's chat, its history and `parent_session_id`, as for any branch.
- **This computer keeps:** with each branch made here (`hermes-chat.branches.`, per connection and profile), its kind, root, turn and model. Until its message has gone, it also keeps the words to send. Clear local cache keeps them, as it keeps Drafts. Other computers see each version as a branch of its parent, without its turn.

## Considered options

- **`/undo` or `/retry` in the chat itself, or canonical `session.mutate {operation: "rewind"}`.** Rejected. These rewrite the chat's own stored history: the original answer and every later turn would be gone from it. The issue asks that the original stay recoverable, and that stored transcript text never be silently rewritten.
- **Branch with `count` set to the rows before the message, and no undo.** This works for every message but the first, because `count = 0` copies the whole chat. One path for every message was chosen over two.
- **Show other versions' text inline in this chat.** A version's later turns are its own chat's. Opening its chat at that turn keeps each transcript whole, with its own Draft and Queued messages.
- **Pick another model when regenerating.** Not done here. The version runs on its parent's model, as a branch does, and shows which. The owner can switch the branch's model afterwards with the model picker.

## Consequences

- Each version is a chat in the list, titled like a branch (`Disk check #2`), so regenerating often makes many chats. Deleting one removes it from its turn's versions.
- Other Hermes clients see the versions as branches, and don't show turns.
- The first version of a turn made here starts the switcher. A branch made elsewhere, or with Branch from here, isn't a version.
- Verified against the fake Hermes in the tests, and live against the deployed checkout with a throwaway home. The canonical protocol and other Hermes versions weren't tested.
