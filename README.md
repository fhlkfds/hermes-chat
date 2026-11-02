<img src="assets/icon.svg" width="64" height="64" alt="">

# hermes-client

Created in [T3 Code](https://t3.codes).

A Tauri 2 + React desktop chat client for one remote Hermes Agent server. It signs in over SSH (see `docs/adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md`) or straight to a dashboard URL (`docs/adr/0004-direct-url-sign-in-and-what-counts-as-unsecure.md`).

## Run

You need the Tauri 2 prerequisites on Arch:

```sh
sudo pacman -S --needed rust webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg
```

Then, from the repo root:

```sh
npm install
npm run app
```

`npm run app` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, which fixes the blank WebKitGTK window on some Wayland setups.

To sign in, enter an SSH target whose key works without a prompt (for example `liam@hermes`, or an alias from `~/.ssh/config`), plus the Hermes dashboard username and password. Or switch to URL and enter the dashboard's address, for example `http://hermes:9119`.

## Install

`packaging/aur/PKGBUILD` builds `hermes-chat-git` from `main` on GitHub. It installs the `hermes-chat` binary, its icons, and a launcher that sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`. To build and install it:

```sh
cd packaging/aur
makepkg -si
```

To run it from a terminal, set the variable yourself: `WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat`.

## Screenshots

Ctrl+Shift+S (or the camera button in the composer) takes a screenshot of a region or window and attaches it to the message you're writing, for you to review before sending. Change or turn off the shortcut in Settings → General → Screenshots.

- **Hyprland, Sway and other wlroots compositors:** install `slurp` and `grim` (`sudo pacman -S --needed slurp grim`). You drag a region, or click a window. Without them the app says what to install and captures nothing, because the screenshot portals there can't let you pick.
- **GNOME and KDE Plasma:** the desktop's screenshot portal shows its own region and window picker. It needs `xdg-desktop-portal` and `xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`.

That shortcut works only while Hermes Chat is focused. Wayland apps can't see keys pressed in other windows, so for a shortcut that works anywhere, bind a key in your desktop's settings to `hermes-chat --screenshot`. For example, on Hyprland: `bind = SUPER SHIFT, S, exec, hermes-chat --screenshot`. If Hermes Chat is open, the screenshot goes to the chat on screen. If it isn't open, or is on the sign-in screen, the screenshot is taken once you're signed in, if that's within two minutes. When it might need to start, use `env WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat --screenshot`.

Captures wait in `$XDG_RUNTIME_DIR/hermes-chat/captures/`, readable only by you. Each one is deleted once Hermes takes its message, when you remove it, when you leave the chat without sending it, and when the app quits. If Hermes doesn't confirm the message, the screenshot goes back in the composer instead. If the app is killed, its captures are deleted the next time it starts, or when you log out. Nothing is uploaded until you send the message.

## Test

```sh
npm test                                  # frontend transport against a fake Hermes
cd src-tauri && cargo test --test transport   # Rust transport against a stub server
cd src-tauri && cargo test --test screenshot  # screenshot capture planning and the private captures folder
```

`node bench/run.mjs` renders the chat pane with synthetic long chats (50, 200 and 800 turns) in headless Chromium and
times opening, streaming, find-in-chat and scrolling, with memory after each open. It uses Playwright's cached headless
Chromium, or the browser in `$CHROME`; `THROTTLE=4` slows the CPU four times.
