# Where a computer-use step spends its time (issue #172)

Measured on 2026-11-04 to find out why computer use (Hermes driving its Bot Desktop, watched in the Screen tab) feels slow, and what this app can do about it.

**Short answer.** The Screen tab is not what makes computer use slow. A page change on the Bot Desktop reaches the glass in 43 to 127 ms over loopback, 115 to 120 ms over an emulated 50 ms-RTT link, and 276 ms over a poor 5 Mbit/s link. A busy screen shows all 10 of its frames a second on every link except the poor one. Within that, the app's own share is small: on any link slower than loopback, the Rust relay and Tauri channel add 0 to 3 ms, and noVNC plus painting adds 9 to 33 ms. The one app-side change tried, batching the relayed bytes, made the stream slower, so it is not shipped (ADR 0052). The time in a computer-use step goes to Hermes's loop: one or two model round trips per action, each carrying a full-resolution screenshot. That loop could not be timed here (see "What could not be measured"). Its write-up is under "What Hermes would need".

## What was measured, and how

No real Hermes server with a Bot Desktop, `cua-driver` and a model was reachable from the build machine. Everything below is a real part where possible, and says what stands in for the rest.

| Part | What ran |
| --- | --- |
| Bot Desktop | Real TigerVNC 1.15.0 `Xvnc` (Debian `tigervnc-standalone-server`), started with Hermes's own arguments from `tools/bot_desktop/launcher.sh` at hermes-agent `ed1afb082e`: 1440x900x24, `-FrameRate 30`, RFB on a Unix socket. No Xfce: the root window is drawn on directly. |
| What Hermes does | `x11bench.py` draws on that Xvnc over raw X11: real UI screenshots from `docs/screenshots/` as full-screen page changes, plus coloured marker blocks whose colour encodes a frame number. |
| Hermes's RFB bridge | `bridge.ts`: the tests' `FakeHermes` for sign-in and `display.*`, with `/api/display/ws` spliced to Xvnc's socket as `hermes_cli/web_routers/display.py` `_bridge` does: each read of up to 64 KiB goes out as one binary WebSocket message, and a full send buffer pauses the reads. |
| The link | Direct loopback; the app's own tunnel command (`tunnel.rs`: `ssh -N -L …`) through a private `sshd` on loopback; and `netem.mjs`, a userspace link emulator (fixed one-way delay, bandwidth cap, ordered queue), since `tc netem` needs root. |
| The app | Release build of `main` at `6017fa6` (`cargo build --release --features tauri/custom-protocol`), WebKitGTK on Xvfb 1600x1000 with software GL, window 1280x820, Screen tab in the side panel (the 1440x900 screen scaled to about a third). |
| The glass | `x11bench.py`'s poller reads the marker pixels from the app's X server about every millisecond. A frame counts as shown once both markers (top-left and bottom-right of the Bot Desktop) show its colour. Drawing and polling share one clock (`CLOCK_MONOTONIC`). |

Scenarios (`x11bench.py run`):

- **page**: a full-screen page change every 1.5 s, 30 times, like a click that opens a new page.
- **small**: a 400x40 strip of new content every 0.5 s, 40 times, like typing.
- **busy**: a full-screen page change every 100 ms for 15 s, like scrolling. Shows whether the stream keeps up and whether lag builds.

Latency is from "Xvnc has the frame" (the X server answered a sync after the drawing) to "both markers on the glass". For the stage split, `instrument.patch` (not shipped) makes the app log when Rust hands bytes to the channel and when the webview's handler gets them, and `stages.py` lines those up with each frame.

The build machine is shared with other sessions, and its load average swung between 2 and 42 during these runs. WebKitGTK's software rendering slows down with load, so each comparison below was made back to back, and the load is given.

To reproduce: start `Xvnc` with the launcher's arguments, run `npx rolldown docs/research/computer-use-speed/bridge.ts --platform node -o bridge.mjs && node bridge.mjs 9119 <rfb.sock> <stats.jsonl>`, sign the app in to `http://127.0.0.1:9119`, open the Screen tab, then run `x11bench.py locate` once and `BENCH_SPOTS=… run.sh <app display> <Xvnc display> <label> <out dir>`.

## Step 1: Hermes's loop (read from the code, not timed)

From hermes-agent `ed1afb082e` (`tools/computer_use/`, `agent/image_eviction_policy.py`):

- **Round trips.** Every `computer_use` call is one model round trip: the model answers with the call, Hermes runs it, and the result goes back in the next request. The tool's own description sets the workflow as capture, then act, then capture again "after state-changing actions (or pass capture_after=true)". So a typical action costs **two** model round trips: one to act, one to see the result. `capture_after=true` folds the second into the first, but it is off by default, and the model has to choose it.
- **An extra model call per screenshot on some models.** When the main model can't take images inside tool results (`_native_tool_result_images`), each capture is sent first to the auxiliary vision model (`_route_capture_through_aux_vision`). The main model only gets its text description, so each capture costs one more model call, in series.
- **Screenshot size.** The default capture mode, `som`, is `cua-driver get_window_state`: an accessibility walk (up to 100 elements surfaced to the model) plus a screenshot of the target window. `vision` mode asks for JPEG quality 85. Computer-use screenshots are embedded at up to 1456 px on the long side, so a full 1440x900 Bot Desktop goes to the model at full size. As a size guide, the 12 real-UI pages used here compress as PNG (stdlib zlib, level 6, Sub filter) to a median of 102 KiB (67–170 KiB), or 136 KiB once base64-encoded into the request.
- **Context.** Screenshots stay in the conversation and are re-sent with every later request (prompt caching makes that cheaper, not free) until the eviction policy's limits (20 images if any exceeds 2000 px, else 100, or 24 MB).
- **Waiting.** There is no fixed settle delay after an action. The `wait` action sleeps for as long as the model asks (up to 30 s).

### What could not be measured

- **Model latency per step.** This needs a real provider and key. Not available here, so no number is given.
- **`cua-driver` capture and accessibility-walk time.** `cua-driver` isn't installed on this machine, and its Linux build needs the full Bot Desktop (Xfce, AT-SPI).
- **A real Hermes bridge and a real WAN.** The bridge is a faithful stand-in (same read size and backpressure, not the same Python). The remote links are emulated: real-world jitter, loss and Wi-Fi are not modelled.
- **A GPU-composited desktop.** The app ran on Xvfb with software GL, so "noVNC+paint" here is likely an upper bound for a normal desktop.

## Step 2: the Screen stream (measured)

### By link (main at `6017fa6`, instrumented build)

Median ms from Xvnc having the frame to the glass (p90 in brackets). Busy shows frames shown a second, out of 10 drawn.

| Link | Load | Page change | Small change | Busy: frames/s | Busy: lag |
| --- | --- | --- | --- | --- | --- |
| Direct, loopback | 1.8–2.0 | 43 (65) | 29 (33) | 10.0 | 64 (91) |
| SSH tunnel, loopback | 4.2–5.3 | 66 (86) | 31 (34) | 10.0 | 80 (103) |
| Emulated 25 ms each way, 20 Mbit/s | 0.3–2.7 | 118 (139) | 59 (62) | 10.0 | 128 (157) |
| Same link, through the SSH tunnel | 3.1–3.8 | 115 (131) | 60 (63) | 10.0 | 133 (157) |
| Emulated 40 ms each way, 5 Mbit/s | 2.3–3.5 | 277 (357) | 73 (79) | 4.9 | 326 (474) |

The direct and SSH rows above were not run back to back (load 2 vs 5). Two paired rounds on loopback (SSH, then direct, then again) ran while the machine's load swung between 8 and 34, and the load swamped the tunnel:

| Paired loopback round | Load | SSH: page / small / busy frames/s | Direct: page / small / busy frames/s |
| --- | --- | --- | --- |
| 1 | 19–30 (SSH), 18–29 (direct) | 230 / 72 / 8.7 | 102 / 35 / 10.0 |
| 2 | 8–13 (SSH), 24–34 (direct) | 56 / 68 / 5.9 | 198 / 99 / 1.1 |

Each build was worse in the round where the machine was busier. The emulated-link pair, run back to back at load 0.3 to 3.8, is the clean comparison: 118 ms direct vs 115 ms through the tunnel for a page change, 59 vs 60 ms for a small one.

### Where a page change's time goes

Medians for the page scenario, ms after Xvnc has the frame. "Last tx": Rust hands the last of the frame's bytes to the Tauri channel (this includes Xvnc's encoding, the bridge and the link). "Channel": until the webview's handler has them. "noVNC+paint": until the glass.

| Link | Load | Channel messages a page | Last tx | Channel | noVNC+paint | Glass |
| --- | --- | --- | --- | --- | --- | --- |
| Direct, loopback | 42 | 56 | 84 | 25 | 18 | 127 |
| Direct, loopback | ~15 | 50 | 36 | 40 | 32 | 108 |
| Direct, loopback | 1.8 | 166 | 21 | 13 | 9 | 43 |
| SSH tunnel, loopback | 5.3 | 124 | 22 | 19 | 24 | 66 |
| Emulated 25 ms / 20 Mbit/s | 0.3 | 178 | 92 | 2 | 24 | 118 |
| Emulated 40 ms / 5 Mbit/s | 2.3 | 165 | 259 | 3 | 14 | 276 |

What this shows:

- **One page change is 50 to 180 WebSocket messages.** Xvnc writes each Tight rectangle as it encodes it (a page here is about 224 rectangles), and the bridge forwards every read. 60 to 80% of the messages are under 1 KiB. Each becomes its own Tauri channel delivery: a script run on the webview's main thread, plus an IPC fetch for messages of 1 KiB or more (Tauri 2.12 `ipc/channel.rs`).
- **That per-message cost matters only on loopback.** There, all of a page's messages arrive within a few milliseconds and queue on the main thread: 13 to 40 ms depending on load. On any real link they arrive spread out over the transfer, and the channel keeps up (0 to 3 ms).
- **On a real link, the transfer is the cost.** A page change is about 126 KiB at noVNC's quality 7, so 20 Mbit/s takes about 52 ms for it and 5 Mbit/s about 206 ms, on top of the delay.
- **Lag doesn't build.** On the slow link, a busy screen drops frames (4.9 a second shown) but its lag stays around 330 ms instead of growing. TigerVNC's congestion control paces it. Nothing in the app needs to.
- **The SSH tunnel costs nothing measurable** once the link has any delay (115 vs 118 ms through the emulated link). On loopback, its cost is below this machine's noise. The tunnel is a plain `ssh -N -L` with no compression, which suits the stream: RFB is already compressed.

### Bytes per page change, by noVNC setting (`rfbsize.py`)

8 real-UI page changes on the same Xvnc, read as the bridge reads them:

| quality / compression | KiB per page, mean (range) | Socket reads (WebSocket messages) |
| --- | --- | --- |
| 9 / 2 | 255 (160–365) | 7–297 |
| **7 / 2 (the app's setting, and the official desktop's)** | **126 (82–185)** | **66–425** |
| 6 / 2 | 113 (72–166) | 79–244 |
| 5 / 2 | 106 (61–158) | 30–477 |
| 3 / 2 | 83 (47–123) | 56–331 |
| 7 / 0 | 203 (130–268) | 82–253 |
| 7 / 9 | 125 (81–184) | 115–448 |

Going from quality 7 to 5 would save about 16% of the bytes (about 33 ms a page at 5 Mbit/s) at a visible cost in image quality. Compression level 2 is already as small as 9. Neither was changed.

### Tried and rejected: batching the relayed bytes

`batching-tried.patch` made the Rust relay send bytes that came within 8 ms of the last batch to the webview together, so a page became 2 to 3 channel messages instead of 50 to 180. With the stage logging on, it cut the loopback channel time from 40 to 8 ms. But in a back-to-back A/B of the shipped builds (3 rounds, each running every scenario on both builds), it was worse in most runs:

| Scenario | main, per-round medians (ms) | batched, per-round medians (ms) |
| --- | --- | --- |
| Page change | 82, 74, 94 | 58, 147, 137 |
| Small change | 51, 36, 38 | 59, 74, 73 |
| Busy, frames shown a second | 10.1, 9.9, 10.1 | 7.4, 6.2, 7.9 |

Load during the A/B was 9 to 29. The likely cause (inferred from TigerVNC's design and these numbers, not traced in TigerVNC itself): TigerVNC paces a client by timing fence round trips, and noVNC answers a fence only when its bytes arrive. Holding bytes back for up to 8 ms makes those round trips jitter by up to 8 ms. TigerVNC reads that as a filling queue and slows down. Any batching that waits would do the same. Batching only what has already arrived would not wait, but it would also never batch: the relay is never behind the network, only the webview is.

## Step 3: what Hermes would need

The app can't make a computer-use step much faster. These would, on the server:

1. **One round trip per action, not two.** Take a capture after every state-changing action by default (or make `capture_after` default to true for click, type, key, scroll and drag), so the model sees the result in the same tool result. This removes about half the model calls in a typical run.
2. **Several actions per call.** Accept a short list of actions in one `computer_use` call (for example, click a field, type, press Enter), with one capture at the end.
3. **No second model call per screenshot.** When the main model can't take images in tool results, every capture goes through the auxiliary vision model first. Say so in `hermes doctor` and the model picker, and recommend a vision-capable main model for computer use.
4. **A faster model for actions.** Let computer use run its steps on a configurable fast vision model, and hand back to the main model when a step fails or the task needs reasoning.
5. **Smaller screenshots for the model.** Downscale captures to about 1024 px on the long side (telling the model the scale, as the aux-vision path already does) and send JPEG rather than PNG for `som` captures. That is fewer image tokens per request, so less time before the model answers. A smaller Bot Desktop (`bot_desktop.geometry`, for example `1280x800`) helps both the model and the stream, and owners can set it today.
6. **Timing in the logs.** Log, per `computer_use` call, the capture time, the accessibility-walk time, the image size sent and the model's time to first token, so a slow step can be traced on a real server. None of these could be measured here.

Nothing is needed in the display stream: TigerVNC with Hermes's arguments, and the bridge's one-message-per-read splice, already deliver a page change in tens of milliseconds plus the link's own delay and transfer time.
