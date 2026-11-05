# Follow-up behavior: queue or steer (#189)

Captured on 2026-11-04 from the running Tauri debug app (WebKitGTK) on an Xvfb display at 1280 × 860. The app loaded its
frontend from Vite: `main` at `0e8c7bf` for the `before-` shots, this branch for the `after-` shots. It signed in by URL
to `bridge.ts` in this folder, a loopback stand-in for the Hermes dashboard served by the tests' `FakeHermes`, with
synthetic chats. It is **not** a real Hermes server, and no model ran. Hermes's side of the reply is scripted
(`/__stream`, `/__continue`, `/__finish`), so it repeats the same `/etc` restore text. Everything Hermes Chat shows and
does is the real app. No visual element was composited or retouched. The keyring couldn't save the password on the
throwaway D-Bus bus, so nothing was written to a real keyring.

Before:

- `before-1-reply-running.png`: a reply running, a follow-up typed. "Enter to queue" and the Queue button: queueing
  was the only choice.
- `before-2-settings-general.png`: Settings → General has four groups, with nothing about follow-ups.

After:

- `after-1-settings-chats.png`: the new Chats group with Follow-up behavior, Queue by default.
- `after-1b-settings-steer.png`: Steer picked.
- `after-2-queue-mode.png`: with Queue, the same screen as `before-1`; the hint now says "Enter to queue · Ctrl+Enter
  to steer".
- `after-3-steered.png`: Ctrl+Enter sent the words into the running reply. They show marked "Steered into the reply",
  nothing was queued, and the reply carries on.
- `after-4-steer-mode.png`: with Steer, the hint says "Enter to steer · Ctrl+Enter to queue" and the button beside Stop
  is the Steer button.
- `after-5-enter-steered.png`: Enter steered the message.
- `after-6-no-steer-fallback.png`: the stand-in restarted with `NO_STEER=1`, a Hermes that doesn't list `/steer`.
  With Steer picked, Enter queued the message and said why; the hint says "Enter to queue".
- `after-6b-second-no-note.png`: the next message queued without repeating the note.
