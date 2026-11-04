# Logs follow Hermes's log tail, and every line is redacted before it is kept

Diagnosing a dropped connection or a failing agent meant reading log files outside the app. The Logs screen (issue #76) shows two kinds of source, one at a time, picked by name: this app's own diagnostics, and the profile's Hermes logs.

The only supported way to read Hermes's logs is the dashboard's `GET /api/logs?file=&lines=&profile=` (`hermes_cli/web_routers/status.py`, the same at `bf0203a` and `f0d9488`). It answers `{file, lines}`: the last `lines` lines, at most 500, of one of the profile's files under `$HERMES_HOME/logs/`. It has no cursor, offset, stream or rotation signal. The dashboard's own Logs page polls it every 5 seconds.

## Decisions

- **Following is polling the tail.** While a Hermes log is on screen and the app is connected, it asks for the last 500 lines every 2 seconds, one request at a time. Each answer is matched against the previous one: the longest run at the end of the old answer that starts the new one marks where the new lines begin. No overlap means lines may be missing, and a note in the list says which case it looks like. A file shorter than 500 lines was rotated or emptied. A full answer means more than 500 lines came between two reads. The app never guesses the missing lines.
- **Sources are Hermes's own names.** `agent`, `errors`, `gateway` and `mcp` (`agent.log`, `errors.log`, `gateway.log`, `mcp-stderr.log`). The `gui`, `desktop`, `update` and `handoff` logs belong to the official desktop app and `hermes update`, and the route reads `update` and `handoff` from the wrong home for a non-default profile, so they aren't offered. A server without the route (404), or without a file name (400 "Unknown log file"), is reported and not asked again. Other failures, such as a refused permission or a lost connection, are shown and retried.
- **Gaps are notes in the list.** A stop is noted where reading picks up again, with the times and the reason: a lost connection, a failed read, or another source shown. It is followed by the rotation or missed-lines note if the answers don't overlap. Notes show whatever the filters are.
- **A ring buffer for each source.** Each Hermes log keeps its newest 5,000 lines and this app keeps its newest 2,000. The screen says how many older lines were dropped. Listeners hear of changes at most every 100 ms, and rows off screen skip layout (`content-visibility: auto`), so a burst is one render.
- **Pausing freezes the view, not the reading.** Pause, or scrolling up, a click or an upward key in the list, shows what was there at that moment while reading carries on, and counts the new lines. Follow shows everything again and goes to the newest line.
- **Redaction happens before anything is kept.** Each line loses its terminal CSI codes (colors, cursor moves), so a code can't hide a secret from the patterns. Then known secret shapes are replaced with `[redacted]`: private keys, `Authorization` and cookie headers, bearer tokens, URL credentials, JWTs, common provider key prefixes, bot tokens, and values of keys named like a secret. Then the other control characters and bidi overrides are written out (`\x1b`, `‮`). The screen, Copy, Export and the support bundle use only that text. Hermes's own `RedactingFormatter` has already run on most lines, but `mcp-stderr.log` is raw stderr, and the app doesn't rely on the server. The bundle says redaction covers known shapes and may miss a secret written another way.
- **Plain text only.** Lines are React text children, never HTML.
- **Two times.** Each line shows when this app received it, in this computer's time, UTC, or hidden. The time inside a Hermes line is the server's clock in its own zone, which Hermes doesn't name, so the app doesn't convert it.
- **This app's diagnostics** are the connection's changes (with the route and profile), the chat list's sync failures, every toast shown, console warnings and errors, uncaught errors and unhandled rejections. They are in memory only, for this run of the app, across sign-ins.
- **The support bundle** is one text file with the sources ticked in its preview: this app and each Hermes log read since Logs opened, with every line kept, whatever the filters show. The preview lists the sources, line counts, what was dropped, how many of each kind of secret were redacted, and the file's first 400 lines. Nothing is uploaded: Save opens the native Save dialog (`logs_export`). Hermes's own `/api/ops/debug-share`, which uploads to a paste service, isn't used.

## Considered options

- **Tailing the files over SSH or the Terminal**: this would read beyond the supported API, and wouldn't work for a direct-URL sign-in.
- **Asking Hermes to filter** (`level`, `search`): its search reads at most 2,000 lines and its level filter changes the tail, which breaks the overlap matching. The app filters what it kept.
- **Keeping logs on disk**: nothing asked for it, and a file of redacted-but-maybe-not-clean text is a liability. The owner saves what they want.

## Gaps

- Overlap matching works on text, since Hermes gives no offsets. A run of identical lines can hide a repeat of itself, and more than 500 lines in 2 seconds (250 a second) can't all be read. A server change that adds a byte offset or a since-cursor to `/api/logs` would close both gaps.
- Polling stops while another source is shown or Logs is closed. What was read goes when Logs closes or the profile changes.
- Redaction is pattern-based. A password in a sentence, or a key with an unknown prefix and an unrevealing name, can get through.
