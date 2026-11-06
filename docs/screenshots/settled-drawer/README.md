# Settled drawer screenshots

Captured on 2026-11-06 from the running Tauri debug application (WebKitGTK), on an Xvfb display, at 1280 × 820, with the
`verify-hermes-chat` skill. The app was signed in by URL to its stand-in dashboard (the repo's `FakeHermes` behind real
HTTP and WebSocket on loopback), started with `HV_LIST=24`. It is not a real Hermes dashboard. Every chat is synthetic.
No visual elements were composited or retouched.

`HV_LIST=24` adds 24 Active, read chats to `default`, so the Inbox is longer than the list panel. The four seeded chats
start Settled.

The before and after shots come from one run. The app built from `main` (`2dfb81e`) cleared two chats with Clear from the
Inbox and closed. The app built from this branch then opened with the same saved data.

- `1-before-settled-collapsed.png`: `main`. Inbox 22, with Unsettled (2) and Settled (4) collapsed below it, out of view
  at the bottom of the scroll.
- `2-before-settled-expanded.png`: `main`, with Unsettled and Settled expanded and the list scrolled to its end. Settled
  is a section in the scroll, under 22 Inbox chats.
- `3-after-update-cleared-chats-settled.png`: this branch, first launch. There is no Unsettled section. The two cleared
  chats, "Renew the TLS certificate" and "Rotate the API keys", are in Settled (6), and the stand-in has them unpinned.
  The drawer is open because the owner left Settled expanded.
- `4-after-drawer-closed.png`: the drawer closed, then the app relaunched. It reopened closed. Six more chats were
  settled from their right-click menu. The "Settled 12" header is at the foot of the panel. The Inbox scrolls above it.
- `5-after-drawer-open.png`: the header clicked. The drawer opens upward to half the panel (410 of 820 px), with its own
  scroll.
