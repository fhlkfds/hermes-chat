# Split chat screenshots

Captured on 2026-11-02 from the running Tauri debug application (WebKitGTK) on an Xvfb display, using a synthetic
Hermes fixture on loopback. Chats, replies, usage and cost figures are fixture data; no real model or user data is
shown. These are framebuffer captures, not browser mockups. The narrow image is cropped to the app's 760 × 820 window;
the others show its 1280 × 820 window. No visual elements were composited or retouched.

- `1-independent-chats.png`: different chats with independent unsent drafts; the right pane is active.
- `2-simultaneous-streams.png`: both chats receiving synthetic deltas, with a Stop control in each pane.
- `3-narrow-window.png`: the pane switcher at a 760-pixel window width, showing the right chat.
- `4-pane-controls.png`: a resized divider and the chat menu's left/right destination controls.
