# Settings → General as cards of rows (#174, ADR 0059)

Captured on 2026-11-04 with `tools/shots/shoot.mjs`: the real signed-in app (`tools/shots/main.tsx`, the whole `Main` with the real Settings screen) in headless Chromium, against the repo's `FakeHermes` stand-in. The data is synthetic: two saved connections, a tray that shows its icon, and a screenshot portal, as the desktop app would wire them. Chromium renders the page, not the app's WebKitGTK, so fonts and anti-aliasing differ a little from the desktop build. Nothing was composited or retouched.

```
CHROME=/path/to/chrome-headless-shell node tools/shots/shoot.mjs general-connection general-launch general-chats general-screenshots general-storage general-search general-more general-light general-min general-min-launch
```

`before-*` is `main` at 0e8c7bf, except `before-chats` and `before-screenshots`, which are `main` at 21ea358 (Voice had moved to its own tab and Chats had been added by then); `after-*` is this branch, merged with 21ea358. Each pair is the same scene:

- `connection`: General → Connection, 1920 × 1080.
- `launch`: Launch, tray & updates. `after-more.png` also has Close to tray's (i) open.
- `chats`: Chats, the follow-up behavior. Its explanation now sits behind the (i).
- `screenshots`: Screenshots. Before, the desktop-shortcut instructions took most of the screen.
- `storage`: Storage & data.
- `light`: Storage & data in the light theme.
- `search`: "cache" in the search box. In the after shot, the matching section's folded help is open.
- `min`, `min-launch`: the window at its 760 × 500 minimum. Before, the tabs took three lines and General's groups two more. After, the strip and the sub-nav take a line each, and only the shown tab's and group's labels are drawn.
