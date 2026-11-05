# Jobs: Troubleshoot (#175)

Captured on 2026-11-04 from the running Tauri debug app (WebKitGTK, frontend embedded), on an Xvfb display at
1280 × 900 with openbox. The app signed in by URL to `bridge.ts` in this folder. The bridge is a loopback stand-in for
the Hermes dashboard, served by the tests' `FakeHermes`, with synthetic `[fixture]` jobs and runs. It is **not** a real
Hermes server, and no model ran. Hermes's side of the chat is scripted: `GET /__fix` shows the agent calling its
`cronjob` tool, changes the job's delivery and prompt on the stand-in server as that tool would, and streams a reply
listing the changes. Everything Hermes Chat shows and does is the real app: the buttons, the message it builds, the
new chat, the end-of-reply detection, the reload and the changes list. The `token=sk-fixture…` in run 1's reply is a
fake key put there to show the redaction. No visual element was composited or retouched.

- `1-job-list.png`: the list, with a Troubleshoot button on each job. The digest job's delivery problem is flagged.
- `2-preview-from-list.png`: Troubleshoot pressed on the list. The job opens with the preview: what will happen, what
  was hidden ("provider key"), and the whole message in an editable box. Nothing is sent yet.
- `3-failed-run-buttons.png`: the job's runs. Each failed run has "Troubleshoot this run"; the successful one doesn't.
- `4-preview-picked-run-redacted.png`: the preview opened from the failed delivery run, scrolled into view. It shows
  run 2 marked "(the run I picked)" and run 1's reply with `token=[redacted key]`.
- `5-chat-first-message.png`: after Start the chat. A new chat in the `default` profile (the job's) opens with the
  message as its first turn, and Hermes is working.
- `6-chat-reply-and-toast.png`: Hermes's reply, with its two `cronjob` calls and the changes it made. The toast says
  the reply has ended and offers "See what changed".
- `7-reloaded-job-what-changed.png`: the job read again. The Troubleshooting panel lists each changed field (the
  prompt in full, before and now; the delivery `discord → telegram`) and offers "Run now to check the fix".
- `8-run-now-confirm.png`: "Run now to check the fix" opens the usual Run now confirmation. It wasn't run.

Taken again at commit `1ac9eed`, after the Codex review fixes. Screenshots 1–8 above are from commit `1438795`; the fixes
after it changed when the panel says what changed (only after a read that started once the reply had ended), not what
these screens show.

- `9-working-panel.png`: the job opened from the rail while Hermes works. The panel says Hermes is working, with
  Read the job again (shows the changes so far without ending the wait) and Open the chat.
- `10-reloaded-while-open.png`: the same screen after Hermes's reply ended, with no click in between. The screen read
  the job again by itself and lists what changed.
