# Chat deletion screenshots (#165)

Captured on 2026-11-04 from the running Tauri debug build of this branch (WebKitGTK) on an Xvfb display, 1280 × 820.
These are framebuffer captures. Nothing was composited or retouched. The window has no window manager, so it has no
title bar. The app was signed in by URL to `docs/screenshots/tags/bridge.ts`: the repo's `FakeHermes` behind real HTTP
and WebSocket on loopback, with synthetic chats. It is not a real Hermes dashboard, and every chat is made up. The app
was driven with `xdotool`. Images 1, 3 and 4 come from this branch's build after the Codex review fix; image 2 from the build after merging main.

- `1-chat-menu-delete.png`: a chat's right-click menu, with Delete chat… last, after a separator.
- `2-header-menu-delete.png`: the open chat's header More (⋯) menu from #173, with Delete chat… last, after a
  separator. Retaken after merging main, from the merged build: before #173 this PR had its own header button.
  Delete chat… here opens the same question, undimmed, and Escape gave focus back to the More button.
- `3-delete-confirm.png`: the question every way of deleting asks first, here from the chat menu. Cancel has focus,
  and Escape, Cancel or a click outside keeps the chat. Escape was pressed after this capture, and the chat stayed.
- `4-delete-key.png`: after that Escape, focus was back on the "NAS disk usage" row, and Delete was pressed. The same
  question opens, with a focus ring on Cancel because it came from the keyboard. Escape kept the chat again.

Also checked live on an earlier build of this branch, but not kept: Delete chat… from the header menu, then Delete
chat, removed "Nightly backup check" from the list, showed the "Deleted: Nightly backup check" toast, and put a new
chat in the pane. That is why the list here starts at "Rotate nginx logs".
