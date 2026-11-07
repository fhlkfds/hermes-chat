# Agent office

The rail's Office button opens the agent office in place of the chat panes. Building, the default, draws the profile shown as a 3D floor with four rooms by state: the Workroom (running, queued at its door), the Waiting room (waiting for the owner, with a "!"), the Trouble room (failed, with a red marker) and the Lounge (the rest). Each chat's agents wear one team color. Hovering a character shows its name tag. Clicking one opens its card, whose Open chat goes where List's row goes. List shows the same agents as rows. Escape, or picking a chat, goes back. The building draws a frame only when something changes, and none while nothing moves.

## Sub-features

- `building`: the floor, its rooms and a character per agent, in team colors.
- `tag`: a character's name tag on hover or keyboard focus; a "!" on every agent waiting for the owner.
- `card`: a character's card, kept current, and Open chat.
- `camera`: drag to turn, scroll to zoom, double-click a room, Reset the view.
- `list`: the List view, the "+N more" sign and the "N in other profiles" sign.
- `stale`: everyone greyed and "as last seen" while disconnected.
- `budget`: 0 frames while nothing moves, at most 30 a second while someone types; the frame counter (press F).

## How to get to it (user POV)

- The Office button on the rail (`.office-btn`).
- Settings (Ctrl+,) → Chats → Office: Building, List or Off.

## Driving it with wd.mjs

Preconditions:

- Fresh `hv up`, signed in per [sign-in.md](sign-in.md).
- `docs/screenshots/office-hq/setup/shots.sh` runs every step below and prints the frame counts and CPU; `cpu.sh` beside it measures the app's CPU on the run's display.

- **Three agents typing.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'` and `$S/wd.mjs keys 'Please delegate the repo audit\n'`. Then `$S/wd.mjs click .office-btn` and `$S/wd.mjs wait '.bld-agent[data-placed]' "" 20000`. Three `.bld-agent.state-running.team-0` buttons: the chat's reply, "Read the auth code" (`sa-1`) and "Read the tests" (`sa-2`).
- **Tag and card.** Hover a character with `$S/hv x mousemove X Y` at its `.bld-agent` button's centre plus the window's position (`$S/hv x search --onlyvisible --class hermes getwindowgeometry`). Its `.bld-tag` shows. `$S/wd.mjs click button "Read the tests, Running"` opens the card; `$S/wd.mjs text .bld-card` lists Chat, Profile, State, Goal, Doing now, Model and Has run. Escape closes the card, then the office.
- **Camera.** Double-click a room with `$S/hv x mousemove X Y sleep 0.2 click --repeat 2 --delay 80 1`; the view zooms into it. `$S/wd.mjs click button "Reset the view"` goes back.
- **Every room.** Start a chat with `'This needs approval to run\n'` (Waiting room, with "!"). Fail `sa-1` with `curl -X POST "$DASHBOARD_URL/__subagent?id=sa-1&status=failed"` (Trouble room). In the delegating chat, open Subagents, pick "Read the tests", `click button "Stop it…"`, then `click '.btn.danger:not([disabled])' "Stop it"` (Lounge, Stopped).
- **Nothing moves.** In the delegating chat, `$S/wd.mjs click button.stop`. Open the office: `$S/wd.mjs eval` reading `.bld`'s `data-frames` twice 10 s apart gives the same number. Press `f` for the frame counter: "N frames · 0 in the last second".
- **Disconnect.** `kill $BRIDGE_PID` (from `$HV_RUN/state.env`). The office says "Not connected to Hermes: every agent is as last seen." and every `.bld-agent` is `.is-stale`.
- **List.** `$S/wd.mjs click button List` shows the same agents, a group per chat.

## Gotchas

- wd.mjs has no double-click, drag, scroll or hover: use `hv x` (xdotool) at screen coordinates, which are the page's plus the window's position.
- `wd.mjs wait <css> <text> <ms>`: pass `""` as the text to give a timeout alone.
- Team colors are held only while the office is open, so a chat's color can change between openings.
- The keyring toast after sign-in covers the composer for a few seconds: `wd.mjs gone '*' "Couldn't save the password"` first.
- The stand-in ends a reply's turn on Stop, as Hermes does; before that it kept a delegating reply running for ever.
