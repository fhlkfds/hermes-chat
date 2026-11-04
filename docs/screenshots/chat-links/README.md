# Chat link screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK, frontend embedded with
`--features tauri/custom-protocol`) on an Xvfb display at 1280 × 820. These are framebuffer captures (`xwd`, converted to
PNG). Nothing was composited or retouched. The app was driven by hand with `xdotool`.

The app was signed in by URL to `bridge.ts` in this folder: the repo's `FakeHermes` behind real HTTP and WebSocket on
loopback (`http://127.0.0.1:47810`), with synthetic chats in two profiles. It is not a real Hermes dashboard, and every
chat, profile and id is made up. The app ran on its own D-Bus session bus, with its own `XDG_DATA_HOME`, so the bus name
`net.l0cky12.HermesChat` and its `OpenLink` method were the real ones. That bus has no Secret Service, so the password
wasn't saved: the second launch asked for it, which is how image 3 shows a link waiting for sign-in.

Each link was opened by running the binary with the link as its argument, as the launcher's `%u` does, except image 10.
While the app ran, each of those processes handed the link over the bus and exited 0 (one was timed: 59 ms).

- `1-copy-chat-link.png`: Copy chat link in the chat header. The real X clipboard then held
  `hermes-chat://chat?v=1&connection=35tcm7yvmomxd6jp37k2&profile=default&id=20261103_081500_a1b2c3`: ids only, no
  address, username or password.
- `2-opened-in-running-app.png`: a link to `work`'s "Deploy plan for v2.4", given to a second process while the app
  showed `default`. The running window switched profile and opened it.
- `3-cold-start-waiting-for-sign-in.png`: the app started with a link to `work`'s 8-week-old "Q3 incident retro" and no
  saved password. The sign-in screen says the link is waiting and that nothing is sent.
- `4-cold-start-opened.png`: after Connect, the app switched to `work` and opened that chat, which is older than the
  month the list holds.
- `5-missing-chat-draft-kept.png`: a link to a chat id `work` doesn't have (the dashboard answered 404). The notice
  says so. The chat on screen and the draft typed in its composer are as they were.
- `6-unknown-connection.png`: a link whose connection reference this computer never made. Nothing was asked of the
  server; the notice offers Open it here.
- `7-malformed-link.png`: a link with an extra `send=` part. It is refused before anything else, and it replaced the
  notice of the link before it.
- `8-pending-while-offline.png`: the bridge stopped, then a link to `default`'s "Rotate nginx logs" was opened. The link
  waits and says nothing is sent. The draft stays in the composer.
- `9-opened-after-reconnect.png`: the bridge started again and the owner reconnected from the rail's status dot. The
  waiting link then switched to `default` and opened the chat. The restarted bridge stores no messages for that chat,
  so its transcript is empty.
- `10-opened-by-xdg-open.png`: the packaged `hermes-chat.desktop`, with `Exec` pointed at this build, installed in the
  private `XDG_DATA_HOME/applications` and indexed with `update-desktop-database`. `xdg-mime query default
  x-scheme-handler/hermes-chat` answered `hermes-chat.desktop`, and `xdg-open` with the link copied in image 1 opened
  that chat in the running window. With the launcher removed and the index updated, the query answered nothing and
  `xdg-open` fell back to looking for a browser.

Images 1 and 2 come from the build before two fixes found while taking these: the notice moved down below the chat
header, and a link that can't open now replaces an older link's notice instead of showing on top of it. Neither
changes those two screens, which show no notice. The others are from the final build.
