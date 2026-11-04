# Sidebar rail screenshots (#176)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1280 × 900 with openbox. Nothing was composited or retouched. The app was signed in by URL to the repo's `FakeHermes` stub on loopback (`docs/screenshots/usage-analytics/bridge.ts`), so every chat is synthetic. The pointer was moved with `xdotool`; each tip was captured 0.4 s after the pointer arrived.

- `1-rail.png`: the rail at 1280 × 820. The H mark, New chat, Search and Inbox at the top; **Work** (Server files, Outputs, Repository, Terminal) and **Server** (Scheduled jobs, Automations, Logs, Usage) below, each under its label; the connection dot and Settings at the foot.
- `2-tip-new-chat.png`: hovering New chat shows its name and Ctrl+N at once.
- `3-tip-automations.png`: a tool without a shortcut shows its name and a line about it.
- `4-tip-settings.png`: Settings, with Ctrl+, and a reminder that Import lives there.
- `5-logs-open.png`: Logs open, marked by the accent bar at the rail's edge.
- `6-min-size.png`: the window at its minimum, 760 × 500. The group labels give way to their rules, the buttons close up, and every button still fits without scrolling.
- `7-min-size-tip.png`: a tip at the minimum size.

The Inbox badge and the Terminal's running dot weren't captured: the stub has no inbox entries and no ssh target.
