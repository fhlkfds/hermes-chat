# Server pages in the Preview (#171)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1280 × 860 with openbox. Nothing was composited or retouched.

The "Hermes server" was a real OpenSSH 10.0 `sshd` reached through `ProxyCommand` into a private network namespace (`unshare -n`), so its loopback is a different one from this computer's. Inside it ran the repo's `FakeHermes` stub as the dashboard on `127.0.0.1:9119` (`bridge.ts` here, so every chat is synthetic) and a static page on `[::1]:5188` only, as Vite binds `localhost`. On this computer a different page ran on `127.0.0.1:5188`. The app signed in through SSH (`hermes-ns`), and the system `ssh` it ran was a wrapper adding `-F` for that server's config.

- `1-server-page.png`: the reply's `http://localhost:5188/` link opened in the Preview. The header says `Server · hermes-ns`, the bar says where the page comes from, and the switch is on **Hermes server**. The page shows it was loaded through the tunnel's end, `http://127.0.0.1:33755/`.
- `2-this-computer.png`: after **This computer**: the same address, now this computer's own page. The tunnel's ssh had ended (checked with `ps`).
- `3-port-closed.png`: `localhost:5999`, where nothing listens on the server. ssh's own words come through.
- `4-refused.png`: `ftp://localhost/logs` typed in the address box is refused, naming the scheme.
- `5-typed.png`: `localhost:5188` typed without a scheme opens `http://localhost:5188/` on the server.

Also checked in the running app, without a picture: closing the side panel ended the tunnel's ssh and removed its socket folder; ending the app with SIGTERM while a tunnel was open ended its ssh too (`PR_SET_PDEATHSIG`), and left the socket's empty folder, which the next launch's first tunnel now sweeps.
