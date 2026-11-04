# The Terminal is the owner's own ssh, run in a pseudo-terminal

The Terminal screen opens a shell on the Hermes server by running the system `ssh` to an SSH target in a pseudo-terminal (PTY) that Rust opens. The webview draws the screen with xterm.js. Rust only moves bytes: what the owner types goes to ssh as it is, and what ssh prints comes back as raw bytes, base64 in a channel event. The owner's `~/.ssh/config`, keys and agent apply, as they do for the sign-in tunnel (ADR 0003). The target is the sign-in's own SSH target. For a URL sign-in, which has none, the owner types one, and the app keeps it on this computer for next time.

It opens from the rail, as an app-level action (ADR 0001), and covers the chat panes, as Server files does. Unlike the other screens, it stays mounted once opened. Going back to a chat hides it and leaves ssh running, and a dot on the rail button shows that. Signing out closes it.

## Considered options

- **Run commands through Hermes's own terminal tool.** Rejected: that runs as the agent, through Approvals, in a chat's history. The owner asked for their own shell.
- **The dashboard's own `/api/pty` socket.** Rejected: it runs Hermes's chat TUI in a PTY, not a shell (`hermes_cli/web_routers/chat_ws.py`, `/api/pty` → `_resolve_chat_argv_async`, read on the deployed `bf0203a`). Its sibling `/api/console` never spawns a PTY or shell at all.
- **Reuse the sign-in tunnel's ssh (one connection, a second channel).** Rejected for now: the tunnel runs `ssh -N` with `BatchMode=yes`, and sharing it needs a ControlMaster socket. A second ssh is simpler, can ask for a passphrase in the terminal, and works with a URL sign-in too.
- **A Rust PTY crate (`portable-pty`).** Rejected: `openpty`, `setsid`, `TIOCSCTTY` and `TIOCSWINSZ` from `libc`, which the app already uses, are all Linux needs.

## Consequences

- It runs `ssh -t -o ServerAliveInterval=15 -- <target>`. Unlike the tunnel, there's no `BatchMode` and no `StrictHostKeyChecking=accept-new`: in a terminal ssh can ask for a passphrase, a password or an unknown host key, and the owner answers there. The target is checked as the tunnel checks it: no leading `-`, no whitespace.
- This is a full shell as the SSH user. It doesn't go through the dashboard, so the Server files screen's read-only limits and credential denylist (ADR 0012) don't apply. The terminal can do nothing the owner's own `ssh` from another terminal can't.
- One session at a time. Ending it, or ssh exiting, keeps what was printed, and the screen offers to connect again below it. Exit status 255 is ssh's own failure, and ssh has already printed why.
- The app's window-wide shortcuts (Ctrl+K, Ctrl+N, Ctrl+B, Ctrl+F…) don't fire while the terminal has the keys. Shells need those keys. Ctrl+Shift+C and Ctrl+Shift+V copy and paste, as in other Linux terminals.
- The PTY closes when the app exits, and ssh gets a hangup, so no shell outlives the app.
- xterm.js loads only when the Terminal is first opened, so it adds nothing to startup.
- Since ADR 0039 the Terminal is a tab of the side panel beside the chat, not a screen over it, and it has a shell on this computer too.
