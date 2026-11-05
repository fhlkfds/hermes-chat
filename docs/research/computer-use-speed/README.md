# Where a computer-use step spends its time (issue #172)

Measured on 2026-11-04 to find out why computer use (Hermes driving its Bot Desktop, watched in the Screen tab) feels slow, and what this app can do about it.

**Short answer.** In this setup (a real Xvnc and the real app, with a stand-in for Hermes's bridge and emulated remote links), the Screen tab keeps up. At low load, a page change on the Bot Desktop reached the glass in about 50 ms over loopback, about 115 ms over an emulated 50 ms-RTT, 20 Mbit/s link, and 286 ms over an emulated 5 Mbit/s link. A busy screen showed all 10 of its frames a second on every link except the 5 Mbit/s one. The app's own share of a page change (the Rust relay, the Tauri channel, noVNC and painting) had a median of 25 to 34 ms on loopback and 18 to 31 ms over the emulated links (glass minus last tx, per frame). The one app-side change tried, batching the relayed bytes, made the stream slower, so it is not shipped (ADR 0056).

What this could not measure is Hermes's loop: model latency, and `cua-driver`'s capture time. The code shows one or two model round trips per action, each carrying a full-resolution screenshot (Step 1). A step is very likely slow because of those round trips, not the stream, but that is an inference from the code, not a measurement. What Hermes would need is under Step 3.

**Added on 2026-11-05: Step 4 times a real Hermes**, with its own bridge, Bot Desktop, `cua-driver` and model, through the app's SSH tunnel. It confirms the inference. A model round trip took 2.4 s (median), and a five-action task needed eight of them. A capture took 0.6 s. A key press reached this computer's screen in about 40 ms over the LAN, plus about 16 ms in the app. It also found one cost in the app: every capture's screenshot came into the chat as text, which is now left out (ADR 0061).

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

The raw runs behind every table are in `runs.tar.xz`: each run's JSON (`v3-*` and `v3b-*` for the low-load tables, `v2-*` for the busy-machine rows, `ab-*` for the batching A/B, `s2-*` and `i-*` for its stage split), and the app's `BENCH` log lines for the instrumented runs. `analyze.py <run>.json` and `stages.py <run>.json <tag>.log <label>` recompute them.

To reproduce: start `Xvnc` with the launcher's arguments, run `npx rolldown docs/research/computer-use-speed/bridge.ts --platform node -o bridge.mjs && node bridge.mjs 9119 <rfb.sock> <stats.jsonl>`, sign the app in to `http://127.0.0.1:9119`, open the Screen tab, then run `x11bench.py locate` once and `BENCH_SPOTS=… run.sh <app display> <Xvnc display> <label> <out dir>`.

## Step 1: Hermes's loop (read from the code, not timed)

From hermes-agent `ed1afb082e` (`tools/computer_use/`, `agent/image_eviction_policy.py`):

- **Round trips.** Every `computer_use` call is one model round trip: the model answers with the call, Hermes runs it, and the result goes back in the next request. The tool's own description sets the workflow as capture, then act, then capture again "after state-changing actions (or pass capture_after=true)". So a typical action costs **two** model round trips: one to act, one to see the result. `capture_after=true` folds the second into the first, but it is off by default, and the model has to choose it.
- **An extra model call per screenshot on some models.** When the main model can't take images inside tool results (`_native_tool_result_images`), each capture is sent first to the auxiliary vision model (`_route_capture_through_aux_vision`). The main model only gets its text description, so each capture costs one more model call, in series.
- **Screenshot size.** The default capture mode, `som`, is `cua-driver get_window_state`: an accessibility walk (up to 100 elements surfaced to the model) plus a screenshot of the target window. `vision` mode asks for JPEG quality 85. Computer-use screenshots are embedded at up to 1456 px on the long side, so a full 1440x900 Bot Desktop goes to the model at full size. As a size guide, the 12 real-UI pages used here compress as PNG (stdlib zlib, level 6, Sub filter) to a median of 102 KiB (67–170 KiB), or 136 KiB once base64-encoded into the request.
- **Context.** Screenshots stay in the conversation and are re-sent with every later request (prompt caching makes that cheaper, not free) until the eviction policy's limits (20 images if any exceeds 2000 px, else 100, or 24 MB).
- **Waiting.** There is no fixed settle delay after an action. The `wait` action sleeps for as long as the model asks (up to 30 s).

### What could not be measured

(Step 4 has since measured the first three on a real Hermes, over a LAN rather than a WAN.)

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

For the page scenario, each duration is worked out per frame and then the median is taken (`stages.py`). "Last tx": ms from Xvnc having the frame until Rust hands the last of its bytes to the Tauri channel (Xvnc's encoding, the bridge and the link). "Channel": from there until the webview's handler has them. "noVNC+paint": from there to the glass. "App" is the app's whole share, from the last tx to the glass, also worked out per frame. Medians of parts don't add up to the median of the whole.

| Link | Load | Channel messages a page | Last tx | Channel | noVNC+paint | App (glass − last tx) | Glass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Direct, loopback | 3.9 | 182 | 21 | 18 | 15 | 34 | 54 |
| SSH tunnel, loopback | 2.9 | 154 | 22 | 14 | 10 | 25 | 48 |
| Emulated 25 ms / 20 Mbit/s | 4.2 | 184 | 90 | 0 | 23 | 25 | 118 |
| Same, through the SSH tunnel | 4.3 | 170 | 94 | 0 | 18 | 18 | 114 |
| Emulated 40 ms / 5 Mbit/s | 3.8 | 126 | 264 | 5 | 22 | 31 | 286 |
| Direct, loopback, busy machine | 22 | 46 | 179 | 11 | 10 | 20 | 217 |
| Emulated 25 ms / 20 Mbit/s, busy machine | 29 | 61 | 182 | 31 | 45 | 80 | 265 |

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

In this setup the app's share of the stream was tens of milliseconds, and the model loop, which couldn't be timed here, costs one or two model round trips per action. So the app very likely can't make a computer-use step much faster, and these would, on the server (an inference from the code, to be confirmed with the timing in item 6). Step 4 has since timed it: see its own list for what the numbers changed.

1. **One round trip per action, not two.** Take a capture after every state-changing action by default (or make `capture_after` default to true for click, type, key, scroll and drag), so the model sees the result in the same tool result. This removes about half the model calls in a typical run.
2. **Several actions per call.** Accept a short list of actions in one `computer_use` call (for example, click a field, type, press Enter), with one capture at the end.
3. **No second model call per screenshot.** When the main model can't take images in tool results, every capture goes through the auxiliary vision model first. Say so in `hermes doctor` and the model picker, and recommend a vision-capable main model for computer use.
4. **A faster model for actions.** Let computer use run its steps on a configurable fast vision model, and hand back to the main model when a step fails or the task needs reasoning.
5. **Smaller screenshots for the model.** Downscale captures to about 1024 px on the long side (telling the model the scale, as the aux-vision path already does) and send JPEG rather than PNG for `som` captures. That is fewer image tokens per request, so less time before the model answers. A smaller Bot Desktop (`bot_desktop.geometry`, for example `1280x800`) helps both the model and the stream, and owners can set it today.
6. **Timing in the logs.** Log, per `computer_use` call, the capture time, the accessibility-walk time, the image size sent and the model's time to first token, so a slow step can be traced on a real server. None of these could be measured here.

Nothing is needed in the display stream: TigerVNC with Hermes's arguments, and the bridge's one-message-per-read splice, delivered a page change here in tens of milliseconds plus the link's own delay and transfer time.

## Step 4: a real Hermes, timed (2026-11-05)

Steps 1 to 3 had no Hermes to time. This step uses a real one:
- **Hermes:** Hermes Agent 2026.9.24 (v0.22.6) on the owner's Linux server (10 cores, LAN, ping 0.8 ms), with its own `/api/display/ws` bridge.
- **Bot Desktop:** TigerVNC Xvnc and Xfce at 1440x900, started by Hermes's `display.start`.
- **Driver and model:** `cua-driver` 0.21.0 and the server's configured model, `z-ai/glm-5.3-flash` on OpenRouter.
- **Isolation:** everything ran under a throwaway `HERMES_HOME`, with its own dashboard on the server's loopback and a bench password. This computer reached it through `ssh -N -L`, as the app does. The owner's profiles and screens weren't touched.
- **What drew on the screen:** Chromium on the Bot Desktop showed `real-hermes/page.html`, an article with images, a full-screen flip and an animated canvas, each driven by a key.

The scripts and raw results are in `real-hermes/` and `real-hermes/runs/`.

### One step, end to end

`turn.mjs` ran the same task three times through Hermes's real loop: capture, press a key, capture, press a key, capture, then answer. It recorded the `/api/ws` events the app gets, and `loop.py` splits them into model round trips and tool times. A model round trip here is the model's answer plus Hermes's own work between two tool calls.

| Stage | Median | Max | Per run |
| --- | --- | --- | --- |
| Model round trip | 2.44 s | 6.91 s | 8: 5 actions, 1 to find the tool, 1 retry, 1 answer |
| `computer_use` capture (`vision`) | 0.59 s | 1.22 s | 3 |
| `computer_use` key | 0.05 s | 0.08 s | 3 (2 asked for, plus the retry) |
| Whole turn | 27.1 s | 33.1 s | 14.5, 27.1 and 33.1 s |

The model was 85 to 93 % of each turn, and most of the rest was the captures. The stream and the tunnel are tens of milliseconds (below). What the runs show about the loop:

- **One round trip goes to finding the tool.** `computer_use` is deferred by default (`tools.tool_search.defer`). Each run's first call was `tool_describe`, and every action went through the `tool_call` bridge.
- **The first key press is always sent twice.** With the default background delivery, `key` came back `ok: false` with `verdict.decision: "escalate"`. In every run, the model then sent it again with `delivery_mode: "foreground"` and kept that. With approvals on, foreground delivery needs its own approval.
- **The model's time hardly depends on the screenshots** (`model_turn.py`: same model, the real tool schema, the real capture):
  - With 1 to 20 screenshots in the request, a turn took 1.2 to 2.3 s. At 20 screenshots the prompt was 36k tokens, about 1,700 per 1440x900 image.
  - One screenshot at 1024 px JPEG took 1.4 to 1.6 s, against 2.0 to 2.3 s at 1440 px.
  - Reasoning effort high, medium or low took 0.7 to 2.7 s, in no clear order.
  - Fewer or smaller images save tokens, but little time on this model.
- **The model in real use** (5,223 calls in the server's logs, `runs/model-latency-from-logs.txt`):
  - Answers of 300 tokens or fewer, which is what a step mostly is, took 1.9 s median and 5.3 s p90, with about 60k prompt tokens.
  - Time follows output tokens: 1.4 s under 50 tokens, 5.3 s at 300 to 1,000, and 14 s at 1,000 to 3,000.
  - The other models in the logs were slower on short answers: 3.3 to 6.6 s median.
- **`cua-driver` takes half a second per capture, whatever the mode** (`tool_times.py`, `runs/tool-times.txt`):
  - `som`, `vision` and `ax` each took 500 to 505 ms median, `ax` included, which has no image. The first call took 1.1 s, since it starts the driver.
  - A profile of one capture put 493 ms in the wait for the driver's MCP reply.
  - Clicks took 49 ms and keys 19 ms.
  - A `vision` capture came back as a 446 KB PNG, although Hermes asks for JPEG at quality 85.
- **Approvals.** For computer use, `approvals.mode: smart` skips the guardian model. Every input action that isn't granted for the chat asks the owner, on its own Approval card: one per kind of action (click, type, key, scroll and so on), and another for foreground delivery. That is a person's time, which isn't measured here.

### The stream, through the real bridge

`measure.mjs` speaks RFB to `/api/display/ws` as noVNC 1.7 does with TigerVNC: Tight, quality 7, compression 2, fences and continuous updates. It holds the screen, presses keys on the page and times the updates that follow. Medians of 12; the busy canvas ran for 5 s. Raw results are in `runs/stream-*.json`.

| Read from | Fence round trip | Key → first update in: full-screen flip | Article scroll | Busy canvas |
| --- | --- | --- | --- | --- |
| Xvnc's socket, on the server | 0.1 ms | 28.9 ms | 27.3 ms | 30.2 frames/s |
| Hermes's bridge, on the server | 0.5 ms | 32.7 ms | 34.2 ms | 30.2 frames/s |
| The bridge through the SSH tunnel, on this computer | 2.1 ms | 39.1 ms | 44.3 ms | 30.0 frames/s |

- **The first update is the picture.** TigerVNC sends a JPEG picture first: 223 to 226 kB for these changes, finished 27 to 44 ms after the key. About 100 ms later, once the link is idle, it sends a lossless refresh of the same area, about 530 kB more, finished 134 to 178 ms after the key. What the owner sees change is the first update.
- **The split:** Hermes's bridge added about 5 ms, and the tunnel and LAN about 6 to 10 ms. The busy canvas kept Xvnc's 30 frames a second everywhere.

**In the app.** This used `app-trace.patch` and `app_trace.py`, trace in `runs/app-stream.log.xz`: a debug build on Xvfb with software GL, as in Step 2, at a load average of 16 to 19.
- **First frame of a change:** drawn 16 ms (median) after its first chunk reached Rust, 20 ms at p90.
- **Each chunk, Rust to the webview:** 1.7 ms median, 38 ms at p99.
- **A busy screen:** drawn every 32 ms (median), 38 ms at p90, so it kept the 30 frames a second.

A key press's picture reached the glass on this computer in about 55 to 60 ms.

### The one app-side cost: screenshots in the chat

Hermes sends a tool's whole result with `tool.complete`. A `computer_use` capture's result carries its screenshot as a base64 data URL, so each capture is a 0.9 to 1 MB frame on `/api/ws`. The chat kept that result, pretty-printed, as the tool call's text.

The instrumented build ran the same kind of computer-use turn through the real transport and Saved-copy code (`runs/app-chat-*.log`):

| | Before | After (ADR 0061) |
| --- | --- | --- |
| Frame per capture on `/api/ws` | 0.9–1.0 MB | 0.9–1.0 MB (unchanged; Hermes sends it) |
| Handling one frame in the webview | about 1 ms | about 1 to 2 ms |
| The chat's Saved copy at the reply's end | 4.7 MB of JSON for 5 captures, over the 2 MB limit, so not kept | 46 kB for 7 captures, kept |
| Saving it | 13 to 15 ms | 1 ms |

This isn't what makes a step slow: the frame costs the webview about a millisecond. But each step made the chat about 1 MB bigger, cost it its Saved copy, and could push other chats' copies out. The chat now keeps a short note in place of each image (ADR 0061).

### What Hermes would need, with the numbers

In order of measured effect on a step:

1. **Fewer round trips per action** (Step 3, items 1 and 2). Each one cost 2.4 s here. A five-action task took eight, so taking a capture after each action by default, and allowing several actions per call, would roughly halve a task.
2. **Don't defer `computer_use` while the Bot Desktop is running**, or keep it described once it has been. That saves one round trip per turn.
3. **Deliver input in the foreground on the Bot Desktop by default.** No one else's focus is there to steal. That saves the retry every run had, and its separate approval.
4. **Find out why each capture takes 0.5 s in `cua-driver` on Linux**, even `ax` with no image. On a five-capture task that's 2.5 s.
5. **Leave image data out of `tool.complete`.** The model needs it, but clients don't: the event should carry the text and the saved path. This app now drops it on arrival (ADR 0061). Other clients pay for it too.
6. **One approval for all of computer use in a chat**, rather than one per kind of action and another for foreground.
7. **Smaller screenshots** (Step 3, item 5) matter less than thought: on this model they changed a turn's time by a few hundred milliseconds at most. Sending the JPEG Hermes already asks for, instead of a PNG, would still cut each request.
8. **Timing in the logs** (Step 3, item 6) is partly there. `agent.log` already has each tool's time ("tool computer_use completed (1.37s)") and each model call's latency and token counts. Still missing are the driver's own time and the accessibility walk.

**Nothing in the stream needs to change.** A change on the Bot Desktop reached the glass on this computer in under 60 ms, less than two frames at Xvnc's 30 frames a second.
