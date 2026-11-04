# Edit and Regenerate: screenshots

Captured on 2026-11-03 from the real Tauri debug build of this branch (WebKitGTK, `tauri build --debug --no-bundle`).
It ran on an Xvfb display at 1280 × 820 and was driven with xdotool. Nothing was composited or retouched.

## Setup

The app was signed in by URL to a **real Hermes dashboard**, Hermes 0.22.6:

- **Code:** the deployed checkout at `f0d9488`, which includes `bf0203a`.
- **Data:** a throwaway `HOME`/`HERMES_HOME` under `/tmp`, with a throwaway basic-auth login, bound to `127.0.0.2:19631`.
- **Chats:** synthetic, seeded with Hermes's own `SessionDB` (`setup/seed.py`):
  - "Backup plan" has a hidden project instruction, a `terminal` tool call with its result, and a message sent with an `@file:` ref.
  - "Weekend hike" is two messages.
  - "Photo of the router" starts with Hermes's `[image]` placeholder, as dashboard REST shows an image with `inline_images=false`. No real image was uploaded.
- **Model:** a loopback stub, `setup/llm.py`, answering OpenAI-style chat completions with `Variant reply #N (model M) to: <last words>`, so each answer can be told apart. Its counter also counts Hermes's title requests. A message containing "run the long command" first gets a `terminal` call to `sleep 25`.

No real model, chat or file was used, and the owner's `~/.hermes` wasn't opened. The keyring warning at sign-in came from the isolated D-Bus session; nothing was stored.

## The screenshots

1. `1-edit-action.png`: hovering an early message in "Backup plan" shows **Edit** beside Branch from here. A draft is typed in the composer.
2. `2-edit-dialog.png`: the Edit dialog, read from Hermes, with the words changed. It shows:
   - the branch starts with the 2 earlier messages and the project's instructions;
   - the 6 later messages it leaves out (2 of yours, 4 replies), listed, which stay in Backup plan;
   - the model;
   - the warning that 1 tool call ran after this message and nothing is undone;
   - **Save as branch** and **Cancel**. Save stayed disabled until the words changed.
3. `3-edited-branch.png`: after Save as branch, the branch Hermes made, "Backup plan #2", opened in the same pane. Its note says which message is replaced and links back. It has:
   - the 2 earlier messages;
   - the edited message in place of the original;
   - Hermes's reply to the edited words, through the stub;
   - an empty composer.
4. `4-back-to-original.png`: the link back opens "Backup plan". All of it is still there. Under the edited message, **Edited in Backup plan #2** links to the branch. The draft is still in the composer.
5. `5-regenerate-dialog.png`: **Regenerate** under the reply. The reply itself isn't listed as left out; the 5 messages after its turn are.
6. `6-regenerate-variants.png`: after Regenerate twice, the reply shows **Answer 3 of 3**:
   - "Regenerated in Backup plan #4";
   - that branch's answer, read from Hermes;
   - the model, and the message sent again.

   The chat stayed where it was, with its draft.
7. `7-variant-2-of-3.png`: Previous shows answer 2 of 3, from "Backup plan #3".
8. `8-original-answer.png`: answer 1 of 3 is the original reply, "Original answer".
9. `9-blocked-hover.png`: in "Weekend hike", a reply is running a `terminal` tool call (`sleep 25`). Edit is dimmed, and hovering it says to wait for the reply to finish.
10. `10-blocked-dialog.png`: clicking Edit anyway opens the dialog with that reason and no way to save. Once the turn ended, Edit was offered again. Stop alone doesn't count; the turn must end.
11. `11-stale-revision.png`: Edit on the first message of "Weekend hike" was open with new words when another client added a turn to the chat (`setup/p2.py`, a second `/api/ws` connection). Save as branch was refused: "This chat changed since this opened…". The database showed no branch of that chat.
12. `12-first-message-edited.png`: Cancel, Edit again, and save. Editing the very first message gives a branch holding only the edited message and its reply, using `confirm_empty_truncate`. Hermes's auto-titler named that branch on its first turn; the odd title is the stub model answering Hermes's title request.
13. `13-image-restriction.png`: Regenerate under the reply to a message with an image says why it can't be sent again, and offers Branch from here.

## Read back from the throwaway `state.db` afterwards

- "Backup plan" still had its 11 rows, all active.
- **Backup plan #2 (Edit):**
  - the 3 copied rows (the hidden instruction included, no tool row);
  - the copy of the original message, archived (`active = 0`);
  - the model-switch marker stored after it by the switch to the parent's model, also archived;
  - the edited message and Hermes's reply.
- **Backup plan #3 and #4 (Regenerate):** the 3 copied rows, the archived copy, the same message sent again, and each its own reply.
- **The stub model's log:** for each replay, the model got `system, user, assistant, user`, meaning the earlier turns and the message replayed. Neither the replaced message nor any later turn was sent. Hermes merges the hidden instruction into the first user turn.
- **The first-message branch of "Weekend hike":** the archived copy, then the edited message and its reply.

## What made them

`setup/` holds the scripts. They were run on the Hermes server from `/tmp/hc63`, with the app built there:

- `dash.sh`: the throwaway dashboard, with `seed.py` and the stub model `llm.py`;
- `start-app.sh`: the app under Xvfb on its own D-Bus bus, with its data in a throwaway folder;
- `signin.sh` and `x.sh`: the clicks;
- `probe.py` and `p1.py`: the hand probe of the contract before any code was written;
- `p2.py`: the other client in screenshot 11.
