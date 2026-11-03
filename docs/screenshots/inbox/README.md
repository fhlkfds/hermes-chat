# Inbox screenshots

Captured on 2026-11-03 from the running Tauri debug application (WebKitGTK) built from this branch, on an Xvfb display, at
1280 × 800 (`7-narrow.png` at the window's minimum, 760 × 760). The app was signed in by URL to a local stub: the repo's
`FakeHermes` (`src/hermes/fakeHermes.ts`) behind real HTTP and WebSocket on loopback. It is not a real Hermes dashboard.
Every chat, profile and command is synthetic. No visual elements were composited or retouched.

The stub's `session.active_list` reports only the two sessions it was seeded with (Migrate orders database, waiting, and
Rotate TLS certificates, working, both in `work`), not the sessions the app itself starts. That is why, after switching to
`work`, the default profile's NAS Approval isn't listed: against a real dashboard it would be, as the tests show.

- `1-inbox-all.png`: All. An Approval in the shown profile (`default`) and one waiting in `work`, a failed message,
  completed and unread chats in both profiles, and work running in `work`. Each row names its state, chat, profile,
  server and time; "noticed" marks a time Hermes doesn't give.
- `2-needs-approval.png`: the Needs approval filter.
- `3-keyboard-focus.png`: moving between entries with the arrow keys.
- `4-leave-question.png`: opening the `work` entry while an Approval waits in `default` asks first; Stay has focus.
- `5-approval-in-work.png`: after Switch to work, the chat open at its Approval card. Nothing was answered.
- `6-partial-refresh.png`: the `ops` profile's list answering 503. The inbox names it and shows its entries as last seen.
- `7-narrow.png`: the narrowest window, after the connection came back: the same entries, each once.
- `8-outage.png`: the dashboard unreachable. Entries are marked "As last seen", the shown profile's live rows are dropped,
  Check now is off, and the Approval card's answers are disabled.
