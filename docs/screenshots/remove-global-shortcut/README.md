# Removed global shortcut screenshots

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1280 × 820 with openbox. Nothing was composited or retouched. The app was signed in by URL to the repo's `FakeHermes` stub on loopback (`docs/screenshots/usage-analytics/bridge.ts`), so every chat is synthetic. It ran on a private session bus with its own `XDG_*` folders, so the keyring warning during setup is expected.

- `1-settings-screenshots-and-toggle-note.png`: Settings → General. The "Show Hermes Chat from anywhere" section is gone. The Screenshots section's desktop-binding notes now end with how to bind `hermes-chat --toggle`.
- `2-settings-voice-then-screenshots.png`: Voice is now followed directly by Screenshots, where the global shortcut section used to be.

On the same run:

- A `global-shortcut.json` placed in the app's config folder before launch was gone once the app had started.
- With the window focused, `hermes-chat --toggle` hid it; `hermes-chat --show` brought it back; a second `--toggle` hid it; a plain `hermes-chat` brought it back. Each command exited at once, and only one Hermes Chat process ran throughout.
