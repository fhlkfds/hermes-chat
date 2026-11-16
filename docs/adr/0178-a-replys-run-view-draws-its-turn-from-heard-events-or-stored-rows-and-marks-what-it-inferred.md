# A reply's Run view draws its turn from heard events or stored rows, and marks what it inferred

When a bot does something odd or slow, the owner wants to see every step of the reply, how long each took and which failed, without scrolling a long chat (#602). Hermes keeps no trace of a run. On the legacy `/api/ws` it sends events with no server time, and it stores rows with one time each, when the step ended (docs/research/fleet-features-server-support.md, "Flight recorder"). This is the first part of #602: a Run view opened from a reply, which works on the owner's `bf0203a` and `f0d9488` and needs no new Hermes route.

## Decisions

- **Run, under a reply, opens the Run view.** It shows the reply's whole turn, from the message that began it to the turn's end, as a waterfall: model steps, tool calls, Approvals and Questions, and Hermes's status lines. A click on a step shows its arguments and result. It reads once when it opens. A finished turn that failed with no reply offers Run under its error instead, drawn from what the app heard, since an error has no stored row to read it back from.
- **A watched turn is drawn from what the app heard.** The transport keeps each chat's turns in memory (`FlightRecorder`, `src/hermes/flightRecorder.ts`), up to 30 per chat: `message.start`, text and reasoning deltas merged into runs, `tool.start` and `tool.complete`, `session.usage`, `status.update`, each Approval or Question as it was asked and how it ended, `error` and `message.complete`, each with when it arrived. Nothing is written to disk.
- **Events pair with a turn by order.** `bf0203a` sends no `turn_id` on `message.start`, and `message.complete` carries none anywhere, so a turn is everything on the session from `message.start` to `message.complete` or `error`. Diagnostics shows whether this Hermes names turns, seen on the first reply.
- **A compaction is one step.** Hermes repeats a compaction's progress line (`compacting`, `compressing`), and a turn-isolated one ends with `compacted` (`tui_gateway/compute_host_bridge.py`). Lines in a row, with only usage ticks or other status lines between them, are one Compaction step from the first to the last. Other model or tool activity between them starts a new one.
- **Only a tool's length is measured.** `tool.complete` `duration_s` is Hermes's own timing. A model call has no event, so a model step runs from `message.start`, or the end of the last tool running, to the next `tool.start` or the turn's end. Its tokens and call count are the change in the `session.usage` counters from the last reading before it to the last before the next model step. All of that is marked inferred.
- **Cost is per turn and inferred.** The turn's cost is the change in the chat's `estimated_cost_usd` between the session read before it and the one the app makes after it. A step's cost isn't shown, because Hermes keeps none.
- **A failed tool is judged from its result**, by Hermes's own rule for a failure the owner must see (`_tool_result_needs_user`): a JSON object whose `success` or `ok` is false, whose `error` is text, or whose `exit_code` isn't 0. The view says the failure was judged.
- **An unwatched reply is drawn from its stored rows.** The app reads `GET /api/sessions/{id}/messages` newest first, up to five pages of 100, until it finds the reply's row and the user row that began its turn. Each step's length is the gap since the row before it, inferred. Tool rows pair with the assistant's `tool_calls` by `tool_call_id`. Tools called together are marked, since Hermes stores them as each finishes and their gaps aren't their own lengths. A reply with no stored row yet can't open its run, and the view says so.
- **Tool progress off is said.** With `display.tool_progress` `off` for the profile (`GET /api/config`), Hermes sends tool events only for file edits, `delegate_task`, `clarify`, a few card tools and failed calls. A watched run says so, and so does Diagnostics.
- **Inferred figures carry ≈.** Every time, token count and cost the app worked out is shown with ≈ and "inferred" for screen readers, and its bar is hatched. A measured tool length is plain.

## Considered options

- **Recording every delta.** A long reply sends thousands. Merging consecutive deltas keeps when text started and stopped and how much came, which is all the waterfall uses.
- **A capability for the Run view.** It uses only routes and events the app already reads, so there is nothing new to check. Diagnostics shows its two facts instead.
- **`spawn_tree.*` for subagents.** Hermes never saves a spawn tree itself, and any call creates the server's `spawn-trees` folder. A later part reads subagent lanes from `subagent.*` events and the stored `delegate_task` row.

## Consequences

- A run the app watched is lost when the app closes or the chat's 30 turns roll past it; the view then reads the stored rows, with less detail.
- A reconnect in the middle of a turn keeps the turn open, so its steps continue when Hermes's events resume; a replayed event is timed when it arrives.
- Later parts of #602 add subagent lanes, cron runs, Work cards, filters, comparing runs and Branch from here.
