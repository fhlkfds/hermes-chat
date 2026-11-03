# Terminal screenshots

Captured on 2026-11-03 from the running Tauri debug build (WebKitGTK) on an Xvfb display. These are framebuffer captures of the 1280 × 820 window, not mockups, and nothing was composited or retouched.

The chat list comes from a stand-in dashboard with synthetic chats (`docs/screenshots/slash-commands/bridge.ts`), signed in by URL. The terminal is real: the app ran the system `ssh` to the real Hermes server (`hermes`) in its own pseudo-terminal, and everything in it was printed by that server. The login banner was cleared (Ctrl+L) before capturing, so no addresses are shown.

- `1-connected.png`: a shell on the server. The shell sees `TERM=xterm-256color` and the terminal's own size (45 rows × 111 columns), and colours come through. The app's Ctrl+K and Ctrl+A shortcuts went to bash, not to Search.
- `2-running-behind-chat.png`: back in a chat with the session still running; the rail's Terminal button has a green dot.
- `3-ended.png`: after End session. The ssh process is gone, what was printed stays, and the same target can be connected again.
- `4-ssh-error.png`: connecting to a host that doesn't exist. ssh's own message is shown as it printed it, and exit status 255 is explained above.
- `5-asks-for-target.png`: a URL sign-in has no SSH target, so the first open asks for one. Once connected, it is kept on this computer and the next open connects straight away.

Also checked by hand in the same build, not pictured: `top` filling the whole terminal, a window resize changing `stty size` from 45 × 111 to 32 × 76 and back, Ctrl+Shift+C and Ctrl+Shift+V, `exit` ending the session as "The session ended.", and the next launch connecting to the remembered target on its own.
