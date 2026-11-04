# Edit and Regenerate: screenshots

Captured on 2026-11-04 (server time) from the running Tauri debug build of this branch (WebKitGTK, `tauri build --debug
--no-bundle`) on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched.

The app was signed in by URL to a **real Hermes dashboard**: the deployed checkout (`f0d94882e8`, a descendant of
`bf0203a`), started for this check with a throwaway `HOME`/`HERMES_HOME` under `/tmp`, a throwaway basic-auth login,
bound to `127.0.0.2:19491`. Its chats are synthetic, seeded with Hermes's own `SessionDB`. The model is a loopback stub
answering OpenAI-style chat completions with fixed synthetic replies (Hermes's `custom` provider). It gives a different
reply each time, so the answers of a turn's versions differ. A message asking for "the long disk check" gets a
`terminal` call that sleeps. No real model, chat or file was used, and the owner's `~/.hermes` wasn't opened. The
keyring warning at sign-in came from the isolated D-Bus session; nothing was stored.

1. `1-edit-action.png`: hovering a message of the owner's shows **Edit** beside Branch from here. A draft is typed in the
   composer.
2. `2-edit-dialog.png`: the Edit dialog, read from Hermes.
   - It opens on the message's words, without the `@file:` ref, and the words are edited.
   - It lists the 4 messages the new branch leaves out, which stay in the chat.
   - The file goes with the edited message, and is still on the server.
   - It shows the model, and that nothing Hermes did is undone.
   - Its buttons are **Save as branch** and **Cancel**.
3. `3-edited-branch.png`: the branch, "NAS disk usage #2".
   - The edited message went with its file ref and has the stub's reply.
   - The switcher under the reply reads **2 / 2 · Edited · stub-model · custom**.
   - Its composer is empty: the draft stayed with the original.
4. `4-original-keeps-draft.png`: back in the original.
   - Its answer is unchanged, with **1 / 2 · Original · stub-model · custom (the chat's model now)**, and **Regenerate**.
   - The draft is still in the composer.
5. `5-regenerate-dialog.png`: the Regenerate dialog. It shows the message it sends again, the answer that stays in this
   chat, what the branch leaves out, the file, the model and the warning.
6. `6-regenerate-versions.png`: after regenerating twice, the turn has four versions, and this one reads
   **4 / 4 · Regenerated**.
7. `7-switch-version.png`: **Previous version** opened "NAS disk usage #3" at the same turn: **3 / 4**, with its own
   answer.
8. `8-blocked-while-tool-runs.png`: a `terminal` call is running in another chat. Edit and Branch from here are greyed
   out, and Edit's tooltip says why.
9. `9-blocked-dialog.png`: clicking Edit while the tool runs opens the dialog with the reason, and only Close.
10. `10-edit-after-stop.png`: after **Stop**, once Hermes said the turn ended (the reply is marked Stopped), Edit works
    again.
11. `11-regenerate-from-version.png`: Regenerate under the answer of version 3, rebuilt after the fix described below.
    The message it sends again is the owner's words and file ref only.

Read back from the throwaway `state.db` afterwards (only rows Hermes counts as active):

- The original had its 8 rows unchanged.
- Each version had `source = tui` and `parent_session_id` set to the original. It held the 3 copied rows (the tool row
  left out), then the message sent again once, then its own answer. The branch's copy of the original message was
  soft-deleted by `session.undo`, so it isn't active.
- The chat whose `terminal` call was stopped stored the tool row as `[Command interrupted]`.

## A fix found here

The first run showed Hermes storing a message sent with an `@file:` ref with its context footer appended
(`--- Context Warnings ---`, or `--- Attached Context ---` with the file's contents). Regenerate from such a row would
have sent the footer again, and the preview counted the ref inside it as a second, missing file. Hermes Chat now strips
the footer with Hermes's own rule before it sends, edits or lists files. The rule is `_CONTEXT_FOOTER_RE` in
`agent/title_generator.py`. Screenshot 11 is from the rebuild with the fix.

`setup/` holds what made them, run on the Hermes server from `/tmp/hc-edit` with the app built there:

- `dash.sh`: the throwaway dashboard, with `seed.py` and the stub model `llm.py`;
- `start-app.sh`: the app under Xvfb on its own D-Bus bus, with its data in a throwaway folder;
- `shot.sh`: one xdotool step and a capture.
