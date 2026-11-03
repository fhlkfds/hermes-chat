# Branches are made by Hermes's `session.branch`, between replies

**Branch from here**, under a message of the owner's or a reply with text, starts a new chat holding the chat's history up to that message. The chat it came from stays as it was. Hermes makes the copy: legacy `session.branch {session_id, count, idempotency_key}` forks the live session into a new stored session whose `parent_session_id` is the parent (`tui_gateway/methods_session_branch.py` at the deployed `bf0203a`). The app never builds a branch out of display text with `session.create {messages}`, which would drop reasoning and message identities, and would not be linked to its parent.

## What Hermes copies

These facts were probed live on 2026-11-03 against the deployed `bf0203a`, with a throwaway `HERMES_HOME` and seeded synthetic sessions (research doc, "Branching"):

- Hermes copies the first `count` rows of the parent's **branch spine**: its user and assistant rows that have text, oldest first. Hidden rows count, such as a project's instructions (ADR 0017), so they are copied and stay hidden.
- Tool rows aren't in the spine, and an assistant row is copied without its `tool_calls`. Tool outputs aren't copied as context. Reasoning is copied.
- A message's content is copied as stored. A file sent with it is an `@file:` ref to a path on the server, so the branch can read it while it's still there. An image is copied as Hermes stored it.
- The branch runs in the parent's folder. It runs on the profile's model, not the parent's. Its source is the live record's, which is `tui` after the sourceless resume this app does. Its title is the parent's next in its lineage (`Disk check #2`), unless `name` is sent.
- A `name` already in use in the profile fails the call with 5008, **after** an untitled branch row is stored. So the app never sends `name`. It renames the branch afterwards, as a Rename does, and a refused title leaves Hermes's name.
- The same `idempotency_key` answers with the same branch for 5 minutes (`_IDEMPOTENCY_KEY_TTL`), from any connection, while Hermes still has the branch live.
- `session.branch` doesn't check that no turn is running, and copies a running turn's in-memory rows too.

## Where the branch ends

`count` is an index into Hermes's spine, not into what the app shows. So the app reads the chat's stored rows (`GET /api/sessions/{id}/messages`, oldest first, `inline_images=false`) and builds the spine with Hermes's rule. It finds the message by its stored row id. A user message gets its row id from history, or from `prompt.submit`'s `user_row_id` once its turn ends. A message whose row isn't known, such as a reply's first segment seen live, is found by its words and by how many messages before it have the same words. A message that can't be found isn't branched from, and the preview says why.

The preview keeps a fingerprint of the copied rows: whose each is, whether it's hidden, and its words exactly as stored (two 32-bit FNV-1a hashes; no text is kept). The spine is read again just before the call. If any row up to the message changed, the app refuses and asks the owner to look again. Just as the call goes, the app checks again that no reply has started, and that the profile and connection are the ones the chat was resumed on, since a runtime id means nothing on another connection. After the call, the branch's stored rows are read back the same way the parent's were, and must have the same fingerprint. If they don't, the app deletes the branch and says so, so the owner never gets a branch they didn't see. If the branch can't be read back, it is kept and the app says it couldn't check.

## When a branch can't be made

No branch is offered while:

- a reply is running or being stopped;
- an Approval is waiting;
- a message to the chat isn't confirmed;
- the chat is still loading, or only its Saved copy is on screen;
- Hermes isn't connected.

A reply in flight has no settled end, so `count` could cut through it. The button stays, with the reason on hover, and the preview opens with the reason and no Create button. A Hermes without `session.branch` (JSON-RPC −32601) gets "This Hermes server can't branch chats", and nothing is made.

## The preview

The preview opens before anything is sent. It lists:

- the messages copied, and the message the branch ends with;
- whether hidden project instructions are copied;
- how many tool calls came before that point, and that their outputs aren't copied;
- each file the copied messages refer to, and whether it is still on the server (`GET /api/fs/list` of its folder);
- how many images are copied;
- the model, and that the branch runs in the same folder;
- that branching undoes nothing on the server, such as files Hermes changed.

A file that is no longer on the server must be acknowledged before Create branch is enabled. Hermes's name for the branch is the default, and the owner may type another.

## Recovery

The attempt is written to this computer before `session.branch` goes, with:

- its idempotency key, the parent, `count`, the branch point and the fingerprint;
- the ids of the parent's branches Hermes listed just before.

If the answer is lost, every read of the chat list looks for it. It reads the profile's sessions newest-made first, archived ones too, back to an hour before the attempt (for the server's clock), up to 10 pages. A candidate is a session with that `parent_session_id` that wasn't listed before. It is the branch only if its stored rows are exactly the attempt's: `count` of them, with its fingerprint. A longer branch from a later message shares the same first rows, so it only makes the outcome uncertain. The branch is adopted as one made here only when the search reached back far enough and found exactly one such session and no longer one.

Branching again from the same point, while its attempt is unsettled, sends the same idempotency key. So until Hermes forgets the key, Hermes answers with the branch it made, if it made one. Lost attempts from other messages of the chat are kept as they are. After 5 minutes, an attempt still not found is settled. If the search was complete and nothing matched, the app says Hermes didn't make it. Otherwise it says it can't tell, and asks the owner to look in the list. Nothing is sent again on its own.

A call refused with "method not found" or "nothing to branch" stored nothing, so the attempt goes. Any other refusal can come after Hermes stored the branch, as `agent init failed on branch` does. The app then looks for the branch at once. It drops the attempt only if it is sure none was made. If it can't tell, it keeps the attempt and says so. If the connection changes while a branch is read back, the branch is kept without its runtime id, and opening it resumes it on the new connection. A branch's link back is forgotten only once Hermes has deleted the branch.

## What is kept where

- **Hermes keeps:** the branch, its history, its title, and `parent_session_id`. These are the same in every Hermes client.
- **This computer keeps** (`hermes-chat.branches.`, per connection and profile):
  - each branch made here: its parent's id and title, and whose message it ends with, its first words and its stored row id in the parent;
  - attempts whose answer was lost.

  Clear local cache keeps them, as it keeps drafts. Deleting a branch forgets its link.

A branch made here is shown as this app's chat, and Active. Hermes stores `tui` only because of how the legacy resume records the live session. Its Draft, Queued messages and outbox are its own, by its chat id. The top of the branch says where it came from, with a link that opens the parent at that message, found by its stored row id, not its words.

## Considered options

- **Copy the display text into `session.create {messages}`.** Rejected: that copies words only. It loses reasoning, message identities and the parent link, and Hermes's `session.branch` exists for this.
- **`session.branch_stored`, or `session.branch` with no `count`.** These branch the whole chat only, not from a message.
- **Canonical `session.mutate {operation: "branch"}`.** This app speaks only the legacy protocol (ADR 0003).
- **Send `name` with the call.** Rejected: a title in use leaves an orphan, untitled branch behind.
- **Branch during a reply from an earlier message.** A prefix of finished rows would be consistent. But Hermes reconciles the running turn's in-memory rows into the spine, and may compress mid-turn. So the app waits for the reply to end.
- **Resume with `source: gui`, so Hermes stores branches as this app's.** Rejected: that would change the platform every resumed chat's turns run as, for every chat, beyond this feature.

## Consequences

- Another computer, or the official desktop app, shows the branch with Hermes's `tui` source, and without the branch point. Hermes keeps no branch point. It shows the parent, if it reads `parent_session_id`.
- The branch is made on the profile's model, then switched to the parent's with a session-scoped `config.set`. If the switch is refused, the branch keeps the profile's model, and the app says so.
- A branch's stored rows are copies. Deleting the parent doesn't delete the branch, and the link then names a chat no longer in the list.
- Chats over 10,000 stored rows can't be branched from here: the app can't read the spine to place the boundary.
- Verified against the fake Hermes in the tests, and live against `bf0203a` with seeded synthetic sessions in a throwaway home. The canonical protocol and other Hermes versions weren't tested.
