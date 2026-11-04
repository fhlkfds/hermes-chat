# Dragging tab screenshots (#166, ADR 0051)

Captured on 2026-11-04 from the running Tauri debug application (WebKitGTK) on an Xvfb display with openbox, signed in
to the `FakeHermes` stand-in dashboard in `bridge.ts` on loopback. Chats and replies are fixture data; no real model or
user data is shown. Every drag is a real mouse drag made with xdotool (press, move in steps, release), not a
synthesized DOM event. These are framebuffer captures of the 1280 × 842 window, cropped to the window and not
retouched. The light box near the pointer in the drag images is WebKitGTK's own drag image of the tab.

Before the change (unmodified `main`, 6017fa6):

- `before-1-right-edge-copies.png`: the NAS disk usage tab dropped on the right edge split the chat area, but the tab
  is still in the left pane too.
- `before-2-left-edge-squashed-hint.png`: over the left edge, the hint said "Open in a new tab" (no left split) and was
  squeezed into a 220-pixel column, because its class `tab` picked up the tab rule.
- `before-3-other-pane-copies.png`: a tab dropped on the other pane's strip, copied there and left in its pane.

After:

- `01-reorder-drag.png`, `02-reorder-after.png`: a tab dragged along its strip; a bar marks where it will land, and it
  moves there.
- `03-right-drag.png` … `10-top-after.png`: a tab over each of the four edges of the only pane, with the hint on that
  half, then the split with the tab moved into the new pane (right, left, bottom, top).
- `11-merge-drag.png`, `12-merge-after.png`: a pane's only tab over the other pane's middle; dropped, its pane closes
  and the tab joins the other pane.
- `13-two-panes-below-drag.png`, `14-two-panes-below-after.png`: with two panes, a tab over the right pane's bottom
  edge says "Move below this pane"; dropped, the panes stack with it below.
- `15-tab-menu.png`: the tab menu (right-click, Menu key or Shift+F10) on a pane's only tab: Merge into the bottom
  pane, Move this pane right, down or left, Close tab. Move this pane up isn't offered: it is up already.
- `16-merged-from-menu.png`: Enter on Merge into the bottom pane.
- `17-ctrl-shift-pageup.png`: Ctrl+Shift+PageUp twice moved the shown tab from last to first.
- `18-menu-two-panes.png`: the menu of a tab in a pane with two tabs, beside a second pane: move along the strip, to
  the right pane, beside its own pane on each side, and its whole pane beside the right pane. "Move this pane left of
  the right pane" isn't offered: it is there already. Taken after the Codex round 1 fixes; shots 01–17 were taken just
  before them, and those fixes change nothing they show.
