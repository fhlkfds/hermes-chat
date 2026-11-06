# Clone a profile (#258): what was slow, and before → after

Verdict: both complaints are fixed in the real app. Typing and ticking were slow only while a reply streamed in the chat behind the dialog. There, a key now reaches the screen in about 20 ms instead of about 0.3 to 0.4 s. The open waits on one round trip instead of three.

| | main (3a7a1cfc) | head (02f7e5ce) |
|---|---|---|
| key to screen while a reply streams, median of per-run medians, n=8 per side (`bench/stream-main-vs-02f7e5ce`) | **325.2 ms** (174–594) | **22.4 ms** (18–35) |
| part checkbox to screen while a reply streams | 205.3 ms (132–240) | 24.5 ms (15–46) |
| frame with the dialog open while a reply streams | 51 ms (38–60) | 17 ms (16–17) |
| dialog open at 150 ms per request, n=12 per side (`bench/open150-main-vs-02f7e5ce`) | **501.0 ms** (495–516) | **185.5 ms** (181–193) |

An earlier run of the streaming bench (`bench/stream-main-vs-leave-dialog-build`, n=16 per side, a build with only the `.leave-dialog` change) gave the same result: 408.7 ms (133–795) → 20.0 ms (17–26) per key, 156.8 → 25.8 ms per checkbox, and 41 → 17 ms per frame.

## Typing while a reply streams

### What a key waited for

While a reply streams, the chat behind the dialog repaints on every frame (deltas reach the screen once per frame, `notifySoon` in `transport.ts`). WebKitGTK repaints the dialog above it each time. The dialog box had 14 px rounded corners and a `0 24px 70px` blurred shadow, and with them each repaint took most of a frame. The web process's main thread went from about 60% busy with the dialog closed to 100% with it open (per-thread CPU from `/proc`, 264 to 274 of 250 possible jiffies over 2.5 s). A key typed in the dialog then waited behind those slow frames. With keys 60 ms apart, they queued up: 20 keys sent over 1.14 s took 1.9 s to all show on main.

### How it was found

`streaming/diagnosis/diag.sh` keeps one app session open with a long reply streaming. It puts one CSS variant at a time in a `<style>` element (diagnosis only, no React-owned node touched) and alternates the variants round by round, so the reply's growth falls on all of them. Each variant gets 2.5 s of frame intervals, 20 real X key presses 60 ms apart (`xtype.py`) timed to the frame that drew them, and 4 checkbox clicks. Median key-to-frame per round, at head 66cdf32e, load 0.6 to 2:

| variant | key to frame, per round (ms) | frame median (ms) |
|---|---|---|
| as shipped | 279, 275, 794, 402, 862, 658, 390, 522, 544, 342, 741 | 28–86 |
| no backdrop (frames only) | | 37–69 |
| `will-change: transform` on the backdrop or the box (frames only) | | 39–53 |
| no shadow | 69, 173, 424, 73, 212, 181 | 17–44 |
| an 8 px shadow (frames only) | | 26–39 |
| no shadow, radius 8 px | 120, 119, 208, 165 | 17–25 |
| no shadow, radius 4 px | 60, 155, 131, 190 | 17–20 |
| no shadow, rounded, no border, scroll on the backdrop | 29, 20, 40, 46, 38 | 16 |
| no shadow, rounded, border kept, scroll on the backdrop | 45, 174, 49, 95, 239 | 16–19 |
| **no shadow, square (the fix)** | 20, 27, 29, 21, 21, 20, 42, 76, 28, 24, 26, 18, 20, 26, 19, 24, 49, 27, 23, 22, 27, 27, 24 | 16–19 |
| dialog hidden but mounted (React still renders it per delta, frames only) | | 16–17 |
| dialog closed (frames only) | | 16–17 |

What this rules out:

- **The dialog re-rendering per streamed token.** With the dialog hidden (`visibility: hidden`) but still mounted, frames were the same as with it closed. React's work for it is not the cost.
- **The backdrop.** Without it, frames stayed as slow.
- **A missing compositing layer.** `will-change: transform` changed nothing. The web process has no compositor thread in this setup (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, which the app's launcher also sets), so the dialog is painted with the page.
- **Layout of the chat behind.** The chat's frames were 16–17 ms with the dialog closed or hidden.

Square without a border but with rounded corners (38 ms median) was the closest alternative. It needs the scroll moved off the box in seven dialogs, so the fix went with square.

The search palette (`.palette`) is the same kind of box on a backdrop. Empty, it is small, so its cost was smaller: with it open, frame p90 was 21–30 ms against 17–18 ms flat, and main-thread CPU 78–88% against 57–66% (`streaming/diagnosis/p1.jsonl`). It gets the same change, so every modal box follows one rule (ADR 0084).

In `d1` and `d3`, rounds 2 and 3 of "closed" are wrong. Escape didn't reach the dialog after the `hidden` variant, so those "closed" frames were measured with it open. `diag.sh` closes it properly from `d4` on.

### Why not faster

After the fix, a key takes about one frame (16.7 ms at 60 Hz) plus event delivery, and frames with the dialog open match frames with it closed. The display's refresh is the limit, so there is nothing left to gain here.

### What each run checks

`stream.sh` checks that the name field holds exactly the 20 typed keys and that the reply grew during the run. All 48 runs passed both checks. Each JSON line keeps the reply length before and after, the send times and the load.

### Screenshots

`streaming/shots/` holds the dialog and the palette on main (`before-*`) and at the head (`after-*`), with a reply streaming: ready, 20 characters typed as real key presses, parts toggled, cloned and read back, the palette, and the dialog in light mode.

## Opening

The open number at the head is in the table at the top, measured at load about 1. The earlier runs below were at load 10–28, which is why their medians are higher. Both show the same saving: two round trips.

### Open time, earlier runs

This is the time from the click on **Clone a profile…** to the frame after the table shows with nothing still reading. The stand-in held each `/api/` answer for 150 ms (`HV_DELAY_MS=150`), which stands in for a distant server's round trip.

| | before (main 3a7a1cfc) | after (974f0e9d frontend) |
|---|---|---|
| open, median of 12 runs (`bench/rerun-delay-150`, log fix applied) | **581.0 ms** (532–1957) | **267.5 ms** (220–466) |
| open, median of 12 runs (first run, `bench/delay-150`) | 572.5 ms (554–753) | 280.5 ms (244–349) |
| dialog reads at open | profiles → soul + skills → config (3 round trips) | profiles + soul + skills (1 round trip) |

Why not faster: the after side is one 150 ms round trip plus about 120 ms of app work. That work is the dialog's render and the menu closing, on a box at load 10–28. The 290–310 ms saved matches the two round trips removed (2 × 150 ms). The 1957 ms before-side outlier happened during a load spike, and the median doesn't depend on it.

The rerun (`bench/rerun-delay-150`) used the stand-in after Codex round 1's fix, which logs each request on arrival instead of after the delay. The open time is timed in the page and doesn't depend on that log. The first run's per-step request counts could shift by up to 150 ms, but the per-session totals below don't depend on timing.

At 0 ms latency (first run only) the open is 253.5 ms (130–586) before and 202.0 ms (94–296) after. The ranges overlap, so there's no measurable difference at that latency, and I don't claim one.

### Typing and toggling with nothing streaming (unchanged, both fast)

All runs are medians of per-run medians, n=12 per side.

| | before | after |
|---|---|---|
| key to frame, 150 ms latency | 11.0 ms (10.0–14.5) | 11.8 ms (9.5–15.0) |
| part checkbox to frame, 150 ms latency | 10.0 ms (7.5–20.0) | 10.0 ms (8.5–17.5) |
| key to frame, 0 ms latency | 12.3 ms (10.0–27.0) | 11.8 ms (10.5–20.5) |
| dialog requests (profiles, soul, skills) while typing or toggling | 0 in 24 runs | 0 in 24 runs |

The "requests during typing" counts above 0 in `summary.txt` are the app's post-sign-in capability check (`/api/health`, `status`, `tools/toolsets`, `files`, `cron/jobs`, `webhooks`, `fs/list`). It lands during a session's first run on both builds. See `bench/delay-150/bridge-after-3.log` lines 23–29.

Per-session totals in each `bridge-*.log` (3 opens per session) agree. `GET /api/profiles` is 7 = 1 at startup + 3 × (switcher menu + dialog), skills is 4 = 1 + 3, and `GET /api/config` is 5 before (2 at startup + 1 per open) and 2 after (startup only).

### How the open's cause was found (suspects from the issue)

1. **`GET /api/profiles` per keystroke.** Ruled out. The stand-in's `bridge.log` shows 0 dialog requests while 20 keys are typed, in every run on both builds.
2. **Source re-fetched per render.** Ruled out, same evidence. `api` is a stable field (`transport.ts:967`), so the effect deps never changed per render.
3. **Effects re-running on new deps.** Ruled out, same as 2.
4. **Whole dialog re-rendering per keystroke.** True but cheap. A diagnostic build (React profiling build, a devtools hook recording each commit) shows only `CloneProfileDialog` rendering per key, at 0–1 ms (max 6 ms). See `diagnosis-timeline-600ms-load45.txt`.
5. **What was real.** Opening waited on three round trips in a row: the list, then the source's SOUL.md and skills, then the source's `api/config`. The dialog never uses the config read, which only feeds Settings → Skills' per-platform switches. At 600 ms per request this took about 2.2 s.

Long frames of 0.2–3.8 s appeared in exploratory runs on both builds. They had no React commit in them. They lined up with `wd.mjs`'s own element search before each click (over a 13,000-node page with a long chat open) and with box load of 26–68. They are not the app's work, so key latency here is timed per event and the open is timed from the click.

## Setup and load

- The streaming and head runs (`bench/stream-*`, `bench/open150-main-vs-02f7e5ce`, `streaming/diagnosis`) ran at 1-minute load 0.6–2.5, with other sessions' jobs on the box. Sessions alternate main and head.

- Real Tauri binary under the verify skill (WebKitGTK through tauri-driver), stand-in dashboard with `default` seeded with a SOUL.md and six own skills.
- `compare.sh` alternates before and after sessions (4 per side per latency, 3 runs each), with a fresh `hv up` and sign-in per session. The box is shared and loaded, and I couldn't stop the other sessions' rustc and vitest jobs. Alternating puts the same noise on both sides. 1-minute load during the runs was 10–28 (`compare.log`), and every JSON line records it.
- Each line in `before.jsonl`/`after.jsonl` checks that the name field ended up holding all 20 typed characters.

## Rerun

```sh
# build each side with hv build into its own HV_TARGET, then:
bench/clone-profile/compare.sh <before target> <after target> <out dir> 3 4 150             # open time
STREAM=1 bench/clone-profile/compare.sh <before target> <after target> <out dir> 2 4         # while a reply streams
node bench/clone-profile/summary.mjs <out dir>/before.jsonl <out dir>/after.jsonl
```
