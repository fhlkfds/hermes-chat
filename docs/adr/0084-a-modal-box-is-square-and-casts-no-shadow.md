# A modal box is square and casts no shadow

Every modal dialog (`.leave-dialog`: Clone a profile, export, import, branch, MCP, confirm and the rest) and the search palette (`.palette`) sit on a dimmed backdrop over the chat. While a reply streams, the chat behind repaints on every frame, and WebKitGTK repaints the box above it each time. A box with rounded corners and a 70 px blurred shadow took most of each frame. With Clone a profile open over a streaming reply, frames went from 17 ms to 40–70 ms, and each key typed in the dialog waited about half a second before it showed (#258). A modal box is now square and has no shadow.

## Decisions

- **No shadow on a modal box.** On the dark backdrop the shadow changed the pixels around the dialog by 3 to 7 levels out of 255, so it was barely visible there, and it was the largest single cost. Without it, a key still waited 70 to 420 ms.
- **No rounded corners on a modal box.** A 4 px, 8 px or 14 px radius cost about the same: keys at 60 to 210 ms, against about 20 ms square. The 1 px border stays. So does the backdrop, which cost almost nothing.
- **The rule sits on the two shared boxes, `.leave-dialog` and `.palette`**, so every modal gets it. A dialog that brings back `border-radius` or `box-shadow` on its box brings the lag back whenever a reply streams behind it.
- **Menus, popovers, toasts and the find bar keep their shadows and corners.** They aren't modal and they are smaller. They weren't measured here.

## Considered options

- **Keep rounded corners, drop the border, and scroll the backdrop instead of the box.** Measured at a median of 38 ms per key, against 21 ms square. It needs the scroll moved off the box in the seven dialogs that scroll their own box. Not done, because square is a change to two properties on two rules. The owner can ask for this look instead.
- **Give the box its own compositing layer (`will-change: transform`).** It changed nothing in the measurement. In this app's WebKitGTK setup (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, which the launcher also sets), the web process showed no compositor thread, so the box is painted with the page.
- **Update the chat less often while a modal is open.** Streamed deltas already reach the screen at most once per frame (`notifySoon` in `transport.ts`). Fewer updates would only make the stall rarer, and would tie the transport to what the UI shows.

Measured on the build box under Xvfb with software GL. On a machine where WebKit rasterizes on the GPU, the shadow and the corners may cost less. The bench (`bench/clone-profile/compare.sh` with `STREAM=1`) reruns the check.
