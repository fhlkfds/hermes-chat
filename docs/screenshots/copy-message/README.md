# Copy under messages and replies: screenshots

Captured on 2026-11-04 from the running Hermes Chat debug build of this branch at `844aba4` (WebKitGTK, frontend
embedded with `tauri/custom-protocol`), on an Xvfb display at 1280 × 860 under openbox, driven with xdotool. Nothing
was composited or retouched.

The app was signed in by URL to a local stub: the repo's `FakeHermes` behind real HTTP and WebSocket on loopback
(`bridge.ts` here), not a real Hermes dashboard. The chat, its thinking, its tool call and its reply are synthetic. The
app ran on its own D-Bus session and `XDG_*` folders, so no keyring or other session was reached.

What each clipboard held was read back with `xclip -o -selection clipboard` on the same display.

1. `1-hover-user-message.png`: hovering the owner's message shows **Copy** beside Edit and Branch from here.
2. `2-user-message-copied.png`: after clicking it, it reads **Copied**. The clipboard held the message as typed,
   `**14 days**` included: `Can you rotate the nginx logs and keep **14 days**? Compress anything older than a day.`
3. `3-hover-reply.png`: hovering the reply shows **Copy** beside Regenerate and Branch from here.
4. `4-reply-copied.png`: after clicking it, it reads **Copied**. The clipboard held the reply's Markdown (backticks,
   bold, the list and the fenced `nginx` block), without the Thought or the `terminal` call.
   `4b-reply-copy-again.png`: 1.5 s later it reads **Copy** again.
5. `5-selection-ctrl-c.png`: part of the reply selected with the mouse and copied with Ctrl+C. The clipboard held only
   the selection: `compress with delaycompress, so yesterday's log stays plain`.

To run it again: `npm run build`, then `cargo build --features tauri/custom-protocol --bins` in `src-tauri`, then
`npx rolldown docs/screenshots/copy-message/bridge.ts --platform node -o /tmp/copy-bridge.mjs && node /tmp/copy-bridge.mjs 47864`,
start the app with its own `XDG_*` folders and D-Bus session, and sign in by URL to `http://127.0.0.1:47864` with any
username and password. The chat is under Settled.
