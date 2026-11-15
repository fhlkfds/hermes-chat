# A goal is set only after its check is shown, and starts only once Hermes reads it back

> **Accepted.** Issue #603, its first PR. Set a goal and the goal bar are `src/ui/GoalBar.tsx`. The calls are `src/hermes/goals.ts`, and the capability is `standingMissions` in `src/hermes/capabilities.ts`.

The owner wants to give a chat a goal that Hermes keeps working on until a check proves it done, and to watch and pause it. Hermes already has this. A goal is set with `/goal`, a check is a "gate" added with `/goal gate add <command>`, and `session.control.read`, `session.control` and `session.control.update` read and change it. All of them answer on the dashboard's legacy `/api/ws`, and the files behind them are the same at `b200f5bc`, `bf0203a` and `f0d9488` (`tui_gateway/methods_session_control.py`, `hermes_cli/goal_command.py`, `hermes_cli/goals.py`). So the feature works on the owner's server with no change to Hermes.

A check is a shell command. Hermes runs it after every turn of the goal, in the dashboard process, as its OS user, with no approval (`_cmd_goal` passes `authorize_gate=lambda: None`), for up to 300 seconds, and outside any container terminal. After a failure it tries again up to 3 times, and the fourth failure in a row pauses the goal. Neither limit can be changed from `/goal`. Showing the command before it is saved is the only check there is.

## Decisions

- **Set a goal previews, refuses if changed, writes, then reads back** (as ADR 0110 and ADR 0171 do for other writes). The dialog reads the chat's goal first. The owner fills in the outcome, what must not change and an optional check, then sees exactly what Hermes gets: the goal text and `$ <check>`, with what the check may do, said plainly. Saving reads again and refuses if the goal's `revision` changed since the dialog read it. It then sends `/goal`, then `/goal gate add <check>`, and reads the goal back. The title, the contract and each check's `command` must match what was sent.
- **Nothing runs until the read back matches.** `/goal` answers `{type: "send", message}` and starts no turn. The app sends `message` as the chat's next turn only after the read back matched. A read back that differs, or a refused check, says what Hermes has and starts nothing. The bar shows that goal, so the owner can clear it.
- **`/goal` is sent as `-- <outcome>`, then `must not: <text>`.** The `--` keeps an outcome that starts with a control word such as "pause" from pausing the goal. Each field goes as one line, because Hermes splits the text by line, and a line that starts with a contract word (`scope:`, `verify:`, …) would become a contract field. The dialog refuses an outcome that starts that way.
- **The turn budget is read-only.** Hermes copies the profile's `goals.max_turns` into each goal, and nothing takes one per goal, so the dialog shows that number from `GET /api/config`.
- **The goal bar shows what Hermes last said.** It sits above the queue and the message box while the chat has a goal. It shows the title, Running, Paused or Done, the turns used of the budget, each check's last exit code and failures in a row, the subgoals, the contract, the judge's last verdict and reason, why Hermes paused it, and a wait barrier. It follows `session.control.update`, and reads `session.control.read` again whenever the chat's live session changes, so after a reconnect too.
- **Pause, Resume and Clear go through `session.control`, then a read back.** Each must show the goal paused, running or gone. A resume answers with a message to send as the next turn, and the app sends it, as for `/goal`. Resume and Set a goal wait while a reply runs.
- **`/goal` joins the command registry (ADR 0015) as a replaceable command, like `/steer`.** A quick, plugin or skill command named `goal` runs before Hermes's own, and `session.control`'s goal actions go through `command.dispatch` too. Typing `/goal <outcome>` opens Set a goal with the outcome filled in, so the check is still shown before it is saved.
- **The capability is checked by one read and the command catalog.** `session.control.read` for the chat id `__hermes_chat_probe__` fails "session not found" (4001) when Hermes has the method, and "method not found" (-32601) when it doesn't. Then `commands.catalog` must list `/goal` as `/goal`, with no quick or plugin command of that name. A replaced `/goal` makes the capability not supported, which hides Set a goal and the bar and refuses `session.control`. When Hermes can't list its quick and plugin commands, it is unknown, and Set a goal stays hidden. Each profile has its own quick commands, so the capability starts unknown on every connection, a profile switch included, and is checked again before Set a goal shows or a goal write goes.
- **The app says plainly that a goal moves only while its chat is live.** The dialog and the bar's details say that an idle chat with only a goal closes 20 seconds after the app does, and that nothing picks the goal up after a server restart until the chat is opened.

## Considered options

- **Send the owner's text to Hermes as typed when `/goal` is typed.** Rejected: `/goal gate add <command>` would add a check that runs as Hermes's user with no approval, and nothing would show it first.
- **Put the check in the contract's `verify:` line only.** Rejected: the contract is text for the judge model. Only a gate is run.
- **Trust `session.control`'s own snapshot instead of reading back.** Its answer is the same snapshot, but the issue asks for every write to be read back, and a separate read costs one call.
- **A turn budget field.** Rejected until Hermes takes one per goal. A field that changed nothing would mislead.

## Consequences

- Setting a goal with a check is four calls and a message: a read, `/goal`, `/goal gate add`, a read, then the kickoff turn. The read and `/goal` aren't atomic, because Hermes has no revision check on `/goal`. Another client could change the goal between them.
- A goal set but not read back as sent stays set in Hermes. The bar shows it, and nothing starts it until the owner sends a message or clears it.
- Subgoal edits, loop and heartbeat cards, the Standing work page and Stop all are later PRs of issue #603.
- `FakeHermes` runs goals in the stand-in (`src/hermes/fakeGoals.ts`). Its checks run no command: `false` or `exit <n>` fail, and anything else passes. Its judge says done.
