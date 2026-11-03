# Usage analytics screenshots

Captured on 2026-11-03 (retaken on the final code after review round 7) from the running Hermes Chat debug build (WebKitGTK, dev profile loading the Vite server) built from this branch, on an Xvfb display at 1280 × 820. The window has no window manager, so dialogs have no title bar. Nothing was composited or retouched.

The app was signed in by URL to a local stub: the repo's `FakeHermes` behind real HTTP and WebSocket on loopback (`bridge.ts` here), not a real Hermes dashboard. Every chat, model, figure and profile is synthetic, generated from a fixed seed. The stub answers `GET /api/sessions?order=created`, `GET /api/sessions/{id}` and `GET /api/analytics/usage` the way the deployed `bf0203a` does: a compressed chat is listed under its last segment with its first segment's counts, and subagent runs are stored but never listed.

The figures were also checked against the real server, read-only, with the app's own `collectUsage` (see the pull request).

- `1-analytics.png`: the Usage screen for the last 30 days in the shown profile: filters, token tiles and the recorded cost with what it covers.
- `2-filtered-breakdown.png`: All profiles, model `gpt-6.1-terra`, broken down by where each chat started and sorted by cost (the arrow on Cost). `gui` and `hermes-chat` count together as Hermes Chat.
- `3-drill-down.png`: the chats behind "Hermes desktop app". "Migrate the mail server" is a compressed chat: its two segments are added once each.
- `4a-csv-save-dialog.png`: Export CSV… opens the native Save dialog with a file name for the period. `4b-csv-saved.png`: the screen says how many chats were saved, and where. `export-sample.csv` is that file.
- `5-partial-failure.png`: the `work` profile's list answering 503. The screen names it; every total, the cost included, is marked "+" and the cost's coverage is "of the tokens read".

To run it again: build the debug binary (`cargo build` in `src-tauri`), run `npx vite --port 1420`, then
`npx rolldown docs/screenshots/usage-analytics/bridge.ts --platform node -o /tmp/usage-bridge.mjs && node /tmp/usage-bridge.mjs 47810`, start the app with its own `XDG_*` folders and `dbus-run-session` (so nothing reaches your keyring), and sign in by URL to `http://127.0.0.1:47810` with any username and password. `curl localhost:47810/__fail-work` makes the `work` profile fail.
