# A reply's Run view draws its turn from the events this app heard, or from its stored rows

When a bot does something odd or slow, the owner has to scroll a long chat to see what it did, and the chat doesn't show how long each step took or which one failed (#602). Hermes keeps no trace of a run: no event carries a server time, a stored row has one time and no length, and cost is kept per chat (research doc `docs/research/fleet-features-server-support.md`, "Flight recorder"). The owner's servers run Hermes `bf0203a` and `f0d9488`. This first part works on both and adds no Hermes route.

## Decisions

- **A Run view, opened from a reply.** A **Run** button under each turn's last reply opens a dialog. It draws the turn as a waterfall of model calls, tool calls, Questions, compactions, status lines and errors. Each step shows how long it took and whether it looks failed. Clicking a step shows its arguments and result. The button isn't offered on a turn that is still running.
- **A watched run comes from the events this app heard.** From `message.start` to `message.complete` or `error`, the transport keeps each chat's events with their arrival times (`src/hermes/runs.ts` `record`): text and reasoning deltas, `tool.start` / `tool.complete`, `session.usage`, `status.update`, `error`, `request.cancel` and `approval.cancelled`. It also keeps each Question Hermes asked and how the owner answered it from here. A password, secret or Clarify answer is never kept. Consecutive chunks of streamed text are joined into one event, so a long reply keeps a handful of events.
- **A turn's events pair by order.** At `bf0203a`, `message.start` carries no `turn_id` (`tui_gateway/prompt_turn.py:427`, empty `MessageStartPayload` in `tui_gateway/contracts/events.py`). At `f0d9488`, `_emit` stamps one from `stream_segments.py`. `message.complete` has none at either. So a run is everything heard between a turn's start and its end, at all three commits. The run is kept with the reply the turn ended with, and with that reply's stored row from `persisted_turn.final_assistant_row_id`. The row id finds the run again once the chat reloads on the same connection.
- **Only a tool's length is measured.** `tool.complete` `duration_s` is timed by Hermes (`tui_gateway/tool_progress.py:346`) and is marked measured. Everything else is marked inferred. Times are arrival times. A model call has no event, so it is the time between tool calls. Its tokens are how far the `session.usage` counters moved meanwhile, and those arrive at most once a second. A tool failure is judged from the result's words, because no event or row has a failure flag, and the view says so.
- **Cost is per turn, never per step.** A watched run's cost is how far the chat's stored `estimated_cost_usd` moved. That is the read the chat already had when the turn started against the first `GET /api/sessions/{id}` read after it ended. Both are reads the app already makes. A stored run has no cost.
- **An unwatched run comes from the stored rows.** For a reply this app didn't watch, the view reads `GET /api/sessions/{id}/messages`, pages back from the newest 500 rows until it has the reply's row and the message that began its turn, and draws each row as a step. Each length is the gap since the row before, because a row is stamped when its step ended. Tool rows pair with the assistant's `tool_calls` by `tool_call_id`. For tools run together, the view says the gap isn't the tool's own length.
- **Tool steps that Hermes doesn't send are named.** The view reads `display.tool_progress` from `GET /api/config?profile=` as `_load_tool_progress_mode` does: a boolean is `all` or `off`, and a missing or unknown value is `all`. With `off`, it says that only file edits, delegations, questions and a few card tools send tool events (`_TOOL_LIFECYCLE_UI_TOOLS`).
- **Diagnostics shows both.** Settings → Diagnostics → Server has a **Tool steps** row, read with the other facts, and a **Turn ids** row, learnt from the first `message.start` heard. A **Run view** capability settles from the stored-messages reads the app already makes when a reply it sent ends.
- **Nothing is written, here or on the server.** Runs are kept in memory, at most 30 per chat, and go when the app closes. No `spawn_tree.*` method is called, because any of them creates the server's `spawn-trees` folder.

## Considered options

- **Saving the app's own spawn tree with `spawn_tree.save`.** It would be a write on the owner's server, and it creates a folder. A later part can add it behind preview, refuse if changed, write, read back (ADR 0110, ADR 0171).
- **Keeping the run on the reply item.** Items go into the Saved copy on disk, and this part writes nothing to disk.
- **A fresh `GET /api/sessions/{id}` at every `message.start` for the cost before.** That adds a request to every turn. The chat's last read is the read before the turn in all but a race with another client, and the cost is marked inferred.

## Consequences

- A run this app watched is gone after the app restarts. The same reply then opens its stored run, with every length inferred.
- A reconnect in the middle of a turn loses the events before it, and replayed frames carry no time.
- Retries that recovered and model fallbacks leave no trace on the wire, so the view can't show them.
- FakeHermes runs a two-tool turn for a prompt holding `run steps`. Its `latest` page of stored messages now comes oldest first, as Hermes returns it.
