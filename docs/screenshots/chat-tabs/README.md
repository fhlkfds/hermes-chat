# Chat tab screenshots

Captured on 2026-11-04 from the running Tauri debug application (WebKitGTK) on an Xvfb display, signed in to a
throwaway Hermes 0.22.6 dashboard on loopback with seeded chats. Chats and replies are fixture data; no real model or
user data is shown. The drags are real mouse drags made with xdotool, not synthesized DOM events. These are framebuffer
captures of the 1280 × 820 window; nothing was composited or retouched. The light box near the pointer in the drag
images is WebKitGTK's own drag image of the chat row.

- `1-drag-onto-tab-strip.png`: a chat dragged from the list over the tab strip, which highlights.
- `2-new-tab.png`: dropped, the chat opens in a new tab.
- `3-three-tabs.png`: a Settled chat dropped on the strip makes a third tab.
- `4-drag-split-down.png`: a chat over the pane's bottom quarter; the hint says Split down.
- `5-split-down.png`: dropped, the panes stack, each with its own tabs.
- `6-drag-split-right.png`: a chat over the top pane's right quarter; the hint says Split right.
- `7-split-right.png`: dropped, the panes turn side by side and the chat gets a tab in the second pane.
- `8-menu-open-in-new-tab.png`: the chat menu's Open in a new tab, the keyboard way to the same thing.
- `9-new-tab-scrolled-into-view.png`: in a narrow pane the strip scrolls, and the tab shown is kept in sight.
