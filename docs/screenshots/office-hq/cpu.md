# Office HQ stage 1: CPU

The app's CPU, as a percentage of one core, summed over its processes (the app, and WebKit's web and network processes), with `.claude/skills/verify-hermes-chat/scripts/cpu.sh`. Each sample is 20 s. The frame counter is `.office-building[data-frames]`, which counts every frame the building draws.

"Three agents typing" is a chat whose reply delegated to two subagents on the stand-in dashboard: the reply and both subagents run for as long as the test lasts.

## The owner's desktop (Arch, Hyprland, graphics card)

The debug build the verify skill makes, with the frontend built for production, started by WebDriver in a window on the owner's session with a private HOME and D-Bus, and `WEBKIT_DISABLE_DMABUF_RENDERER=1`, as `npm run app` sets. Window 1260 × 1004, device pixel ratio 1. Three 20 s samples per state, one after another; the window had focus throughout.

| State | Samples | Frames drawn |
| --- | --- | --- |
| Office closed, nothing running | 0.1, 0.1, 0.2 % | — |
| Office open, nothing running | 0.1, 0.2, 0.1 % | 0 in 62 s (1 → 1) |
| Office closed, three agents running | 12.6, 12.4, 12.3 % | — |
| Office open, three agents typing | 14.8, 15.0, 15.1 % | 372 in 62 s (6.0 a second) |

With three agents typing, the building costs about 2.6 % of a core: 6 frames a second at about 4.3 ms of CPU each, most of it in WebKit's web process (+2.2 %) and the rest in the app's own process (+0.6 %). With nothing moving it draws nothing and costs nothing measurable.

## Headless (the verify skill: Xvfb, no graphics card)

WebGL here runs on Mesa's llvmpipe, in software, so a frame costs much more CPU than on a desktop. Compare each state with the same state with the office closed.

| State | Samples | Frames drawn |
| --- | --- | --- |
| A. Office closed, nothing running | 0.1, 0.1, 0.1 % | — |
| B. Office open, nothing running | 0.1, 0.2, 0.2 % | 0 in 62 s |
| C0. Office closed, three agents running | 11.8, 12.0, 11.6 % | — |
| C. Office open, three agents typing | 34.0, 34.1, 34.1 % | 373 in 62 s (6.0 a second) |
| D. As C, with another window focused | 7.3, 7.2, 7.1 % | 0 in 62 s, `document.hasFocus()` false |
| E0. Office closed: an Approval, a failure, two Unread chats | 7.0, 6.6, 6.2 % | — |
| E. Office open, the same four agents, none moving | 6.2, 6.3, 6.4 % | 0 in 62 s |

Closed and open, alternating, with three agents typing, five rounds of 20 s: closed 11.8, 12.3, 12.2, 12.6, 12.2 % (median 12.2); open 27.9, 33.6, 33.6, 34.0, 33.7 % (median 33.6), 125 frames each round.

The cost follows the frames drawn. Before typing was slowed to 6 frames a second it was drawn at 30, and C measured 307 % here; at 6 frames a second with antialiasing it was 68 %, and without antialiasing 34 %, all in WebKit's web process, which draws the frames.

E and E0 both cost about 6.5 %, and so do C0 and the desktop's closed state with agents running (about 12 %): that is the app's own cost of a running or waiting chat, the same with the office closed, and not this change's.

## What was not measured

- The desktop states were each sampled three times in a row, not alternated as the headless ones were.
- The desktop run used the debug build of the app's Rust side. Most of the office's cost is in WebKit's web process, which a release build doesn't change.
