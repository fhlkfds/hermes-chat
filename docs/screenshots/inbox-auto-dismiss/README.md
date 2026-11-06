# Rail inbox auto-dismiss and Clear done screenshots

Captured on 2026-11-06 from the running Tauri debug application (WebKitGTK) built from this branch, on an Xvfb display, at
1280 × 820, with the `verify-hermes-chat` skill. The app was signed in by URL to its stand-in dashboard (the repo's
`FakeHermes` behind real HTTP and WebSocket on loopback), started with `HV_INBOX=1`. It is not a real Hermes dashboard.
Every chat and profile is synthetic. No visual elements were composited or retouched.

`HV_INBOX=1` gives `work` two Unread chats: "Morning brief, Monday", last active 3 days ago, and "Convert 12 GB to MB", an
hour ago. In `default`, a prompt starting with `fail` ended with an error, and one with `approval` asked for an Approval.

- `1-before-off.png`: auto-dismiss Off. All four entries show, and Clear done is in the header.
- `2-setting-2-days.png`: Settings → Chats, Rail inbox, set to 2 days. The rail badge drops from 4 to 3 at once.
- `3-after-2-days.png`: after Check now. The 3-day-old completed entry is gone. The Approval, the failure and the
  hour-old completed entry stay.
- `4-relaunched-off.png`: set back to Off, then the app closed and relaunched. The 3-day-old entry stays dismissed: it
  was stored as a dismissal. The failure from before the relaunch is gone because Hermes keeps no error rows a reload can
  read (ADR 0019), not because it was dismissed. Its dismissal record holds only `completed work brief`.
- `5-before-clear-done.png`: a new failure made after the relaunch, with the Approval and the hour-old completed entry.
- `6-after-clear-done.png`: after Clear done. The completed entry is gone. The Approval and the failure stay, and the
  button hides once no completed entry is shown.
