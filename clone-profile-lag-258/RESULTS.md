# Clone a profile (#258): what was slow, and before → after

Verdict: opening is faster at real network latency. Typing and toggling were already fast and stay fast. No dialog request ever went out per keystroke or per toggle, before or after.

## Primary number

Time from the click on **Clone a profile…** to the frame after the table shows with nothing still reading. The stand-in held each `/api/` answer for 150 ms (`HV_DELAY_MS=150`), which stands in for a distant server's round trip.

| | before (main 3a7a1cfc) | after (974f0e9d) |
|---|---|---|
| open, median of 12 runs | **572.5 ms** (554–753) | **280.5 ms** (244–349) |
| dialog reads at open | profiles → soul + skills → config (3 round trips) | profiles + soul + skills (1 round trip) |

Why not faster: the after side is one 150 ms round trip plus about 130 ms of app work. That work is the dialog's render and the menu closing, on a box at load 10–28. The 292 ms saved matches the two round trips removed (2 × 150 ms).

At 0 ms latency the open is 253.5 ms (130–586) before and 202.0 ms (94–296) after. The ranges overlap, so there's no measurable difference at that latency, and I don't claim one.

## Typing and toggling (unchanged, both fast)

All runs are medians of per-run medians, n=12 per side.

| | before | after |
|---|---|---|
| key to frame, 150 ms latency | 11.0 ms (10.0–14.5) | 11.8 ms (9.5–15.0) |
| part checkbox to frame, 150 ms latency | 10.0 ms (7.5–20.0) | 10.0 ms (8.5–17.5) |
| key to frame, 0 ms latency | 12.3 ms (10.0–27.0) | 11.8 ms (10.5–20.5) |
| dialog requests (profiles, soul, skills) while typing or toggling | 0 in 24 runs | 0 in 24 runs |

The "requests during typing" counts above 0 in `summary.txt` are the app's post-sign-in capability check (`/api/health`, `status`, `tools/toolsets`, `files`, `cron/jobs`, `webhooks`, `fs/list`). It lands during a session's first run on both builds. See `bench/delay-150/bridge-after-3.log` lines 23–29.

Per-session totals in each `bridge-*.log` (3 opens per session) agree. `GET /api/profiles` is 7 = 1 at startup + 3 × (switcher menu + dialog), skills is 4 = 1 + 3, and `GET /api/config` is 5 before (2 at startup + 1 per open) and 2 after (startup only).

## How the cause was found (suspects from the issue)

1. **`GET /api/profiles` per keystroke.** Ruled out. The stand-in's `bridge.log` shows 0 dialog requests while 20 keys are typed, in every run on both builds.
2. **Source re-fetched per render.** Ruled out, same evidence. `api` is a stable field (`transport.ts:967`), so the effect deps never changed per render.
3. **Effects re-running on new deps.** Ruled out, same as 2.
4. **Whole dialog re-rendering per keystroke.** True but cheap. A diagnostic build (React profiling build, a devtools hook recording each commit) shows only `CloneProfileDialog` rendering per key, at 0–1 ms (max 6 ms). See `diagnosis-timeline-600ms-load45.txt`.
5. **What was real.** Opening waited on three round trips in a row: the list, then the source's SOUL.md and skills, then the source's `api/config`. The dialog never uses the config read, which only feeds Settings → Skills' per-platform switches. At 600 ms per request this took about 2.2 s.

Long frames of 0.2–3.8 s appeared in exploratory runs on both builds. They had no React commit in them. They lined up with `wd.mjs`'s own element search before each click (over a 13,000-node page with a long chat open) and with box load of 26–68. They are not the app's work, so key latency here is timed per event and the open is timed from the click.

## Setup and load

- Real Tauri binary under the verify skill (WebKitGTK through tauri-driver), stand-in dashboard with `default` seeded with a SOUL.md and six own skills.
- `compare.sh` alternates before and after sessions (4 per side per latency, 3 runs each), with a fresh `hv up` and sign-in per session. The box is shared and loaded, and I couldn't stop the other sessions' rustc and vitest jobs. Alternating puts the same noise on both sides. 1-minute load during the runs was 10–28 (`compare.log`), and every JSON line records it.
- Each line in `before.jsonl`/`after.jsonl` checks that the name field ended up holding all 20 typed characters.

## Rerun

```sh
# build each side with hv build into its own HV_TARGET, then:
bench/clone-profile/compare.sh <before target> <after target> <out dir> 4 3 150
node bench/clone-profile/summary.mjs <out dir>/before.jsonl <out dir>/after.jsonl
```
