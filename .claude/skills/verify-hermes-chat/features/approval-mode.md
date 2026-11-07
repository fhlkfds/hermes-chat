# Approval mode

A pill in a started chat's composer, after the reasoning pill, shows the chat's approval mode as Hermes reports it: "Smart", "Manual", "YOLO · this chat", "YOLO · all chats", or "Approvals" (disabled) until Hermes reports. Its menu offers Smart and Manual, which change the profile's mode for every chat on it, and YOLO, which changes this chat only after a warning shown every time. A pick waits for Hermes's answer; a refusal shows Hermes's message in the menu. The New chat pane has no pill. In a composer narrower than 600px only the icon and chevron show.

## Sub-features

- `unknown`: "Approvals", disabled with the reason, until the chat's first `session.info` with approvals.
- `profile-mode`: Smart or Manual sets the profile's `approvals.mode`; other open chats on the profile follow.
- `yolo`: the warning (Cancel sends nothing), then YOLO for this chat only.
- `yolo-off`: Smart or Manual in a YOLO chat turns its YOLO off, then sets the mode.
- `all-chats`: the profile's mode `off` shows "YOLO · all chats"; YOLO there does nothing; Smart puts it back.
- `refused`: Hermes's refusal shows in the menu and the face stays.
- `narrow`: at an 820px window the model name stays whole and the pill is icon-only.

## How to get to it (user POV)

- Open any chat; the pill is in the composer bar, after the model picker and the reasoning pill.

## Driving it with wd.mjs

Preconditions:

- The stand-in reports no approvals, so there the pill only ever reads "Approvals", disabled. Drive this feature against the throwaway real Hermes in `~/.cache/hermes-live-277` (its `README.md` has the start and stop commands, the fake model's `danger <tag>` prompt, and how to reset the mode). Run `~/.cache/hermes-live-277/run.sh`, then `$S/hv up --dashboard http://127.0.0.27:47277`, `$S/wd.mjs open`, and sign in per [sign-in.md](sign-in.md) with user `owner` and the password in `~/.cache/hermes-live-277/password`.
- The profile's mode is `smart` (`grep -A1 '^approvals:' ~/.cache/hermes-live-277/hermes/config.yaml`).

- **Unknown, then Smart.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'` and `$S/wd.mjs keys 'hello\n'`. Until Hermes has built the chat's agent, `$S/wd.mjs text button "Approval mode: unknown"` reads `Approvals` and the button is disabled. Then `$S/wd.mjs wait button "Approval mode: Smart" 20000`.
- **Manual.** Run `$S/wd.mjs click button "Approval mode: Smart"` and `$S/wd.mjs click '[role=menuitemradio]' Manual`. `$S/wd.mjs wait button "Approval mode: Manual"`, and the menu is gone. `config.yaml` now has `mode: manual`. Send `danger m1`: an Approval card shows, and `work/junk-m1` stays after Deny.
- **YOLO, with the warning.** Click the pill, then `$S/wd.mjs click '[role=menuitemradio]' YOLO`. `$S/wd.mjs wait '[role=dialog]' "Turn on YOLO for this chat?"` shows both bullets. `$S/wd.mjs click button Cancel` closes it with nothing sent (no new `config.set` in `dashboard.log`). Do it again and `$S/wd.mjs click button "Turn on YOLO"`. `$S/wd.mjs wait button "Approval mode: YOLO, this chat"`. Send `danger y1`: no card, and `work/junk-y1` is gone.
- **Back to Smart.** Click the pill and `$S/wd.mjs click '[role=menuitemradio]' Smart`. `$S/wd.mjs wait button "Approval mode: Smart"`, and it stays Smart (this is the stale `session.info` race, ADR 0089). Picking YOLO again shows the warning again.
- **All chats.** Run `sed -i 's/^  mode: .*/  mode: off/' ~/.cache/hermes-live-277/hermes/config.yaml`, then change the chat's reasoning effort from the reasoning pill so Hermes re-sends `session.info`. The pill reads "YOLO · all chats". Picking YOLO closes the menu with no warning and no new `config.set`. Pick Smart: it reads "Smart", and `config.yaml` has `mode: smart`.
- **Narrow.** Resize the window to 820px wide with `$S/hv x` (`search --name "Hermes Chat" windowsize 820 600`). `$S/wd.mjs shot narrow`: the model name is whole and the pill shows only its icon and chevron. Its aria-label still names the mode.

## Gotchas

- The create answer carries no approvals; the first `session.info` with them comes a second or two after the chat starts, so wait with a long timeout.
- `approvals.mode` is the profile's: reset it to `smart` after a run (`README.md`), or the next run starts elsewhere.
- A Hermes launched with `--yolo` reports YOLO in every chat. Right after a Smart or Manual pick the pill shows the mode, until Hermes's next `session.info` (ADR 0089).
- The refusal (4030) needs a Hermes with administrator-managed keys, which `f0d94882` doesn't have; `src/ui/approvalsPill.test.tsx` covers it.
- To compare the pill with what Hermes holds, read `approvals.mode` in `hermes/config.yaml` and the chat's `model_config.yolo_mode` in `hermes/state.db` (read-only): `session.info.yolo` is that flag or the mode `off`. Don't resume the chat from a second client to read its `session.info`: Hermes hands that client the app's own live session, and closing it there ends the app's session ("session not found" on the next pick).
