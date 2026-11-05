# Where a computer-use step spends its time (issue #172)

Measured on 2026-11-04 to find out why computer use (Hermes driving its Bot Desktop, watched in the Screen tab) feels slow, and what this app can do about it.

**Short answer.** In this setup (a real Xvnc and the real app, with a stand-in for Hermes's bridge and emulated remote links), the Screen tab keeps up. At low load, a page change on the Bot Desktop reached the glass in about 50 ms over loopback, about 115 ms over an emulated 50 ms-RTT, 20 Mbit/s link, and 286 ms over an emulated 5 Mbit/s link. A busy screen showed all 10 of its frames a second on every link except the 5 Mbit/s one. The app's own share of a page change (the Rust relay, the Tauri channel, noVNC and painting) was 24 to 33 ms on loopback and 18 to 27 ms over the emulated links. The one app-side change tried, batching the relayed bytes, made the stream slower, so it is not shipped (ADR 0052).

What this could not measure is Hermes's loop: model latency, and `cua-driver`'s capture time. The code shows one or two model round trips per action, each carrying a full-resolution screenshot (Step 1). A step is very likely slow because of those round trips, not the stream, but that is an inference from the code, not a measurement. What Hermes would need is under Step 3.

## What was measured, and how

No real Hermes server with a Bot Desktop, `cua-driver` and a model was reachable from the build machine. Everything below is a real part where possible, and says what stands in for the rest.

| Part | What ran |
| --- | --- |
| Bot Desktop | Real TigerVNC 1.15.0 `Xvnc` (Debian `tigervnc-standalone-server`), started with Hermes's own arguments from `tools/bot_desktop/launcher.sh` at hermes-agent `ed1afb082e`: 1440x900x24, `-FrameRate 30`, RFB on a Unix socket. No Xfce: the root window is drawn on directly. |
| What Hermes does | `x11bench.py` draws on that Xvnc over raw X11: real UI screenshots from `docs/screenshots/` as full-screen page changes, plus coloured marker blocks whose colour encodes a frame number. |
| Hermes's RFB bridge | `bridge.ts`: the tests' `FakeHermes` for sign-in and `display.*`, with `/api/display/ws` spliced to Xvnc's socket as `hermes_cli/web_routers/display.py` `_bridge` does: each read of up to 64 KiB goes out as one binary WebSocket message, and a full send buffer pauses the reads. |
| The link | Direct loopback; the app's own tunnel command (`tunnel.rs`: `ssh -N -L …`) through a private `sshd` on loopback; and `netem.mjs`, a userspace link emulator (fixed one-way delay, bandwidth cap, ordered queue), since `tc netem` needs root. |
| The app | Release build of `main` at `6017fa6` (`cargo build --release --features tauri/custom-protocol`), WebKitGTK on Xvfb 1600x1000 with software GL, window 1280x820, Screen tab in the side panel (the 1440x900 screen scaled to about a third). |
| The glass | `x11bench.py`'s poller reads the marker pixels from the app's X server about every millisecond. Each sighting is timed when its pixel read returns, so a slow read can't make a frame look faster. A frame counts as shown once both markers (top-left and bottom-right of the Bot Desktop) show its colour. Colours repeat every 64 frames, so `analyze.py` gives each sighting to the oldest later frame with that colour, since a viewer shows frames in order, and flags any it can't tell apart. Drawing and polling share one clock (`CLOCK_MONOTONIC`). |

Scenarios (`x11bench.py run`):

- **page**: a full-screen page change every 1.5 s, 30 times, like a click that opens a new page.
- **small**: a 400x40 strip of new content every 0.5 s, 40 times, like typing.
- **busy**: a full-screen page change every 100 ms for 15 s, like scrolling. Shows whether the stream keeps up and whether lag builds.

Latency is from "Xvnc has the frame" (the X server answered a sync after the drawing) to "both markers on the glass". For the stage split, `instrument.patch` (not shipped) makes the app log when Rust hands bytes to the channel and when the webview's handler gets them, and `stages.py` lines those up with each frame.

The build machine is shared with other sessions, and its load average swung between 2 and 42 during these runs. WebKitGTK's software rendering, Xvnc and the bench all slow down with load, so the tables give the load, and the main ones were run only once it was under 6. A Codex review of the first version found that the poller timed sightings before reading the pixels, that colour reuse could hide a very late frame, and that the stage split subtracted medians. All three are fixed, and every table here except the batching A/B was re-measured with the fixed tools.

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

### By link (main at `6017fa6`, instrumented build, low load)

Median ms from Xvnc having the frame to the glass (p90 in brackets). Busy gives frames shown a second, out of 10 drawn, and their lag. Each link was run through all three scenarios once, only after the 1-minute load average had dropped under 6. The load shown is at the start of each scenario. No frame was ambiguous (see `analyze.py`).

| Link | Load | Page change | Small change | Busy: frames/s | Busy: lag |
| --- | --- | --- | --- | --- | --- |
| Direct, loopback | 2.5–3.9 | 54 (75) | 32 (36) | 10.0 | 80 (115) |
| SSH tunnel, loopback | 2.0–2.9 | 48 (69) | 32 (36) | 10.0 | 69 (101) |
| Emulated 25 ms each way, 20 Mbit/s | 4.2–5.3 | 118 (136) | 58 (62) | 10.0 | 129 (147) |
| Same link, through the SSH tunnel | 2.4–4.3 | 114 (132) | 57 (61) | 10.0 | 129 (145) |
| Emulated 40 ms each way, 5 Mbit/s | 3.8–10.7 | 286 (374) | 81 (87) | 4.4 | 372 (512) |

An earlier run of the same five links, mostly at load 20 to 33 (6 to 12 for the slow link), gave page changes of 126 to 342 ms (the direct one's p90 was 2.1 s) and busy screens of 4.5 to 10 frames a second. That is this shared machine's CPU contention (Xvnc, the bridge, WebKitGTK's software rendering and the bench all compete), not the link or the app. A first low-load emulated-link run that caught a load spike (6 to 19) mid-run gave 204 ms, and was re-run.

### Where a page change's time goes

For the page scenario, each duration is worked out per frame and then the median is taken (`stages.py`). "Last tx": ms from Xvnc having the frame until Rust hands the last of its bytes to the Tauri channel (Xvnc's encoding, the bridge and the link). "Channel": from there until the webview's handler has them. "noVNC+paint": from there to the glass. Medians of parts don't add up to the median of the whole.

| Link | Load | Channel messages a page | Last tx | Channel | noVNC+paint | Glass |
| --- | --- | --- | --- | --- | --- | --- |
| Direct, loopback | 3.9 | 182 | 21 | 18 | 15 | 54 |
| SSH tunnel, loopback | 2.9 | 154 | 22 | 14 | 10 | 48 |
| Emulated 25 ms / 20 Mbit/s | 4.2 | 184 | 90 | 0 | 23 | 118 |
| Same, through the SSH tunnel | 4.3 | 170 | 94 | 0 | 18 | 114 |
| Emulated 40 ms / 5 Mbit/s | 3.8 | 126 | 264 | 5 | 22 | 286 |
| Direct, loopback, busy machine | 22 | 46 | 179 | 11 | 10 | 217 |
| Emulated 25 ms / 20 Mbit/s, busy machine | 29 | 61 | 182 | 31 | 45 | 265 |

For a small change, the channel took 0 to 4 ms and noVNC+paint 13 to 19 ms on every link at low load.

What this shows, for this setup:

- **One page change is 50 to 190 WebSocket messages.** Xvnc writes each Tight rectangle as it encodes it (a page here is about 224 rectangles), and the bridge forwards every read. 60 to 80% of the messages are under 1 KiB (the bridge's per-second counts). Each becomes its own Tauri channel delivery: a script run on the webview's main thread, plus an IPC fetch for messages of 1 KiB or more (Tauri 2.12 `ipc/channel.rs`).
- **That per-message cost shows on loopback.** There, a page's messages all arrive within a few milliseconds and queue on the main thread: 14 to 18 ms at low load. Over the emulated links they arrive spread out over the transfer, and the channel keeps up (0 to 5 ms). On a busy machine it took up to 31 ms even over the emulated link, but Xvnc and the bridge slowed far more.
- **Over the emulated links, the transfer is the cost.** A page change is about 126 KiB at noVNC's quality 7, so 20 Mbit/s takes about 52 ms for it and 5 Mbit/s about 206 ms, on top of the delay.
- **Lag doesn't build.** On the slow link, a busy screen drops frames (4.4 a second shown) but its lag stays around 370 ms instead of growing. TigerVNC's congestion control paces it. Nothing in the app needs to.
- **The SSH tunnel costs nothing measurable here**: 48 vs 54 ms on loopback and 114 vs 118 ms over the emulated link, both within run-to-run noise. The tunnel is a plain `ssh -N -L` and sets no compression, which suits the stream: RFB is already compressed. A real network's jitter and loss weren't modelled.

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

`batching-tried.patch` made the Rust relay send bytes that came within 8 ms of the last batch to the webview together, so a page became 2 to 3 channel messages instead of 50 to 180. With the stage logging on (two paired loopback runs, load about 15 to 42, re-split with the fixed `stages.py`), it cut a page change's channel time from 16 and 22 ms to 6 and 7 ms, and its glass time from 108 and 127 ms to 67 and 74 ms, while a small change went from 37 to 42 ms. But in a back-to-back A/B of the shipped builds (3 rounds, each running every scenario on both builds), it was worse in most runs:

| Scenario | main, per-round medians (ms) | batched, per-round medians (ms) |
| --- | --- | --- |
| Page change | 82, 74, 94 | 58, 147, 137 |
| Small change | 51, 36, 38 | 59, 74, 73 |
| Busy, frames shown a second | 10.1, 9.9, 10.1 | 7.4, 6.1, 7.9 |

Load during the A/B was 9 to 29. These runs were made before the review fixes to the poller: it took each sighting's time before reading the pixels rather than after, so these latencies are low by up to one poll (a pixel read took a median of 0.1 to 1.7 ms, p99 up to 20 ms, at load 20 to 33), the same for both builds. They are re-analysed with the fixed `analyze.py`, and no frame was ambiguous. The likely cause (inferred from TigerVNC's design and these numbers, not traced in TigerVNC itself): TigerVNC paces a client by timing fence round trips, and noVNC answers a fence only when its bytes arrive. Holding bytes back for up to 8 ms makes those round trips jitter by up to 8 ms. TigerVNC reads that as a filling queue and slows down. Any batching that waits would do the same. Batching only what has already arrived would not wait, but it would also never batch: the relay is never behind the network, only the webview is.

## Step 3: what Hermes would need

The app can't make a computer-use step much faster. These would, on the server:

1. **One round trip per action, not two.** Take a capture after every state-changing action by default (or make `capture_after` default to true for click, type, key, scroll and drag), so the model sees the result in the same tool result. This removes about half the model calls in a typical run.
2. **Several actions per call.** Accept a short list of actions in one `computer_use` call (for example, click a field, type, press Enter), with one capture at the end.
3. **No second model call per screenshot.** When the main model can't take images in tool results, every capture goes through the auxiliary vision model first. Say so in `hermes doctor` and the model picker, and recommend a vision-capable main model for computer use.
4. **A faster model for actions.** Let computer use run its steps on a configurable fast vision model, and hand back to the main model when a step fails or the task needs reasoning.
5. **Smaller screenshots for the model.** Downscale captures to about 1024 px on the long side (telling the model the scale, as the aux-vision path already does) and send JPEG rather than PNG for `som` captures. That is fewer image tokens per request, so less time before the model answers. A smaller Bot Desktop (`bot_desktop.geometry`, for example `1280x800`) helps both the model and the stream, and owners can set it today.
6. **Timing in the logs.** Log, per `computer_use` call, the capture time, the accessibility-walk time, the image size sent and the model's time to first token, so a slow step can be traced on a real server. None of these could be measured here.

Nothing is needed in the display stream: TigerVNC with Hermes's arguments, and the bridge's one-message-per-read splice, delivered a page change here in tens of milliseconds plus the link's own delay and transfer time.
