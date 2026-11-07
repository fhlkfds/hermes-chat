# Approval mode pill screenshots

Captured on 2026-11-06 from the running Tauri debug application (WebKitGTK) built from this branch, on an Xvfb display, at
1280 × 820, with the `verify-hermes-chat` skill. The app was signed in by URL to a real Hermes dashboard at upstream
`f0d94882`, run in a private home on loopback, with a stub model. A prompt starting with `danger` makes the stub model ask
Hermes's `terminal` tool to `rm -rf` a scratch folder, which Hermes's detector flags as dangerous. Hermes's smart-mode
checker gets `APPROVE` from the stub model. No visual elements were composited or retouched.

`10-narrow-long-model-name.png` is the one exception. The stub model's name, `fake`, is too short to show the narrow
layout's point, so this shot is the same React app rendered in headless Chromium against the repo's `FakeHermes`
(`tools/shots`), with the model `claude-sonnet-4-5`.

- `1-unknown.png`: a new chat while Hermes builds its agent. The pill reads "Approvals" and is disabled until Hermes
  reports the mode.
- `2-smart.png`: Hermes reported `approval_mode: smart`, `yolo: false`. The status bar no longer has a YOLO item.
- `3-menu.png`: the menu. Smart and Manual are tagged "Profile default", YOLO "This chat", and the note names the profile
  that Smart and Manual change.
- `4-manual-prompts.png`: after picking Manual, the next dangerous command asks for an Approval. The checker isn't
  consulted.
- `5-yolo-warning.png`: picking YOLO shows the warning before anything is sent. It is shown every time YOLO is turned on.
- `6-yolo-no-prompt.png`: YOLO on for this chat. Two dangerous commands ran with no Approval. The profile stays Manual.
- `7-back-to-smart.png`: after picking Smart, the next dangerous command goes to the checker and runs with no Approval.
  The pill stayed Smart through the 5 s checked. Hermes can send a stale `yolo: true` frame around this write (ADR 0089).
- `8-all-chats.png`: the profile's mode set to `off` in `config.yaml`, then a reasoning change made Hermes re-send
  `session.info`. The pill reads "YOLO · all chats".
- `9-narrow-820.png`: an 820 px window. The pill shows only its icon and chevron; its accessible name is still
  "Approval mode: Smart".
- `10-narrow-long-model-name.png`: an 820 px window with a long model name. The name stays whole beside the icon-only
  pill.
