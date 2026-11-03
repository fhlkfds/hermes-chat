# Branch from here: screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK, `tauri build --debug
--no-bundle`) on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched.

The app was signed in by URL to a **real Hermes dashboard**: the deployed `bf0203a` checkout, started for this check
with a throwaway `HOME`/`HERMES_HOME` under `/tmp`, a throwaway basic-auth login, and bound to `127.0.0.2:19471`. Its
chats are synthetic, seeded with Hermes's own `SessionDB`. "NAS disk usage" has a hidden project instruction, a
`terminal` tool call and its result, and a message with two `@file:` refs, one to a file that exists and one to a file
that doesn't. The model is a loopback stub answering OpenAI-style chat completions with a fixed synthetic reply
(Hermes's `custom` provider). No real model, chat or file was used, and the owner's `~/.hermes` wasn't opened. The
keyring warning at sign-in came from the isolated D-Bus session; nothing was stored.

1. `1-branch-action.png`: hovering a reply shows **Branch from here** beside Read aloud. A draft is typed in the
   original's composer.
2. `2-preview.png`: the preview, read from Hermes. It shows 5 messages, that the hidden project instructions are
   copied, 1 tool call whose output isn't copied, and both files, one marked no longer on the server. It also shows the
   model, the folder, and that nothing on the server is undone. Create branch stays disabled until the missing file is
   acknowledged.
3. `3-preview-ready.png`: the missing file acknowledged, and a title typed.
4. `4-branched-chat.png`: the branch Hermes made, opened in the same pane. It is Active and has the owner's title. Its
   top links back to where it came from, and its composer is empty: the original's draft stayed with the original.
5. `5-branch-new-message.png`: a message sent in the branch, answered through Hermes. The stub model's log showed 6
   messages in, with no tool message.
6. `6-back-to-original.png`: the link back opens the original at that reply, found by its stored row and outlined.
   The original's draft is still there. The tooltip is from the pointer passing over a button.

Read back from the throwaway `state.db` afterwards:

- The original had its 9 rows unchanged.
- The branch had `source = tui`, `parent_session_id` set to the original, the owner's title, and `pinned = 1`.
- The branch's rows were the 6 copied ones (the hidden row included; the tool row and the `tool_calls` dropped),
  then the new message and its reply.

`setup/` holds what made them, run on the Hermes server from `/tmp/hc-branch` with the app built there:
`dash.sh` (the throwaway dashboard, with `seed.py` and the stub model `llm.py`), `start-app.sh` (the app under Xvfb on
its own D-Bus bus, with its data in a throwaway folder) and `signin.sh` (the sign-in clicks).
