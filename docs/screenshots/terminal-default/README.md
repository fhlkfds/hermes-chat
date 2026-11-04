# Terminal opens on the Hermes server (#170)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1280 × 900 with openbox. Nothing was composited or retouched. Full-size shots are cropped to the window; minimum-size shots to the 760 × 500 window.

How the "server" was reached, so the shots show a real SSH sign-in and a real ssh terminal:

- The dashboard was the repo's `FakeHermes` stub on loopback (`docs/screenshots/copy-message/bridge.ts`), so every chat is synthetic.
- The "Hermes server" was a private `sshd` run as the same user on 127.0.0.1:2270, with its own host key and authorized key. The app's `HOME` held an `~/.ssh/config` alias `hermes` for it.
- The app's `PATH` had a small `ssh` wrapper that added `-F <that config>` (plain `ssh` reads the passwd home's config, not `$HOME`'s). For the sign-in tunnel only, it remapped the remote port 9119 to the stub's port, because another session on this box held 9119. Every other argument was the app's own (`ssh -t -o ServerAliveInterval=15 -- hermes` for the terminal).
- So both shells run on the same machine. `$SSH_CONNECTION` (server side) and `$HOME` (this computer's side, the harness's fake home) tell them apart.

- `1-default-hermes-server.png`: a fresh app, signed in over SSH to `hermes`. Opening the Terminal from the rail shows **Hermes server**, already connected over ssh to the sign-in's target. This computer's shell isn't started.
- `2-switched-to-this-computer.png`: **This computer** picked: the local login shell starts. The Hermes server button keeps its running dot.
- `3-back-to-server-same-session.png`: back on **Hermes server**: the same ssh session (same client port in `$SSH_CONNECTION`), its output kept. The app's ssh log shows one `ssh -t` in all.
- `4-min-size-hermes-server.png`: the server shell at the minimum window size, 760 × 500.
- `5-remembered-this-computer-after-relaunch.png`: with This computer picked last, the app was quit and started again. After signing in, the rail's Terminal opened on **This computer** (`"terminalKind":"local"` in `hermes-ui-prefs`), and no `ssh -t` was run until Hermes server was picked.
- `6-no-ssh-target.png`: a second connection, signed in by URL (`http://127.0.0.1:47870`), with Hermes server picked last. The Terminal says there is no SSH target, why, and offers to set one (the field has the keys) or to use this computer instead.
- `7-min-size-no-ssh-target.png`: the same at 760 × 500.
- `8-target-set-and-connected.png`: `hermes` typed into that field and **Set and connect** pressed: connected, and kept for this URL connection.
