# The context inspector shows Hermes's own accounting, labelled, and compacts only on Hermes's call

The status bar's context meter opens a **context inspector** (issue #97). It has two tabs.

**Window** shows what Hermes's `session.context_breakdown` returns for the chat's runtime session (`agent/context_breakdown.py`, `tui_gateway/methods_session.py` at the deployed `bf0203a`):

- Hermes's total, labelled by its own `context_source`. The total is **Exact** when it is the provider's count for the latest call (`provider_usage`). It is **Partly estimated** when Hermes adds its own estimate of the messages since that call (`provider_usage_plus_estimate`). It is **Estimated** when the provider hasn't counted it yet (`local_estimate`).
- Hermes's estimate for each category (system prompt, tool definitions, instruction files, skills, MCP, subagents, memory, conversation). The categories are always labelled **Estimated**, because Hermes counts them at about four characters a token, and they needn't add up to the total.
- Hermes's per-file list of instruction files (`context_files`): each file's status, and a link that opens it in the preview pane as a Server file.
- Tool output has its own row marked **Unavailable**. Hermes counts it inside the conversation and doesn't measure it separately.
- When Hermes answered, since Hermes puts no time on its measure, and the model it measured for. If the chat's model has changed since, the inspector says so.
- The provider's prompt cache comes from the chat's stored usage (ADR 0008). It is labelled as billing, over every call, and kept apart from the total.

**Compactions** reads the chat's stored rows, compacted ones included (`GET /api/sessions/{id}/messages?include_compacted=true&inline_images=false`), and lists each compaction Hermes stored:

- When Hermes stored its summary row.
- The summary itself, between Hermes's own markers, shown as plain text.
- How many earlier messages it took out of what the model reads.

A message counts as taken out when its row is marked `compacted` and no active row holds the same `message_uid`. Hermes keeps copies of the messages at the head and tail of a compaction, so a compacted row with an active copy is still read. Each taken-out message is counted against the first summary stored after it. A summary row is one Hermes flagged (`_compressed_summary`), or, as Hermes itself tells them apart, one that starts with its compaction marker. The live server's chats from August 2026 have no flag on their summary rows, and are found by the marker. Compacted rows with no summary row after them are reported as a compaction whose summary can't be shown. Their text isn't repeated here; they stay in the transcript. Hermes's live `usage.compressions` count (since the agent was built on the server) is shown too. A change in it, from a compaction here or from Hermes's own automatic one during a reply, makes both tabs read again.

**Compact now** calls `session.compress` with the chat's runtime session. It is offered only when all of these hold:

- the app is connected,
- the chat is open on Hermes,
- no reply is running,
- Hermes reports a compactor for the session (`usage.compressions` is present).

It runs only after a confirmation that says what changes. Cancel has the focus. The result reports Hermes's own counts and its token estimate, labelled as an estimate. A `-32601` answer stops it being offered on that connection. Hermes has no call to rebuild a chat's context, so the inspector says so and offers none.

## Considered options

- **Work the categories out from the meter's percentage, or count tokens in the app.** Rejected: the issue forbids it. A tokenizer in the app would disagree with the provider and with Hermes, and couldn't see the system prompt or the tool schemas.
- **Present the categories as the total, or add the cache reads in.** Rejected: Hermes's categories are estimates and its total isn't their sum. Cache reads are counted again on every call, so they can far exceed the window.
- **Show the compacted messages' text in the inspector.** Rejected: the transcript already shows them, and the inspector must not suggest the model still reads them, or make up what a summary stood in for.
- **A separate screen.** Rejected: it would lose the place in the chat, and the meter is where the question comes up.
- **Use the `commands.catalog` listing of `/compress` as the sign that Hermes can compact.** Rejected: that lists a slash command, not the `session.compress` method. The live `compressions` count says that the session has a compactor, and a `-32601` answer says that the method is missing.

## Consequences

- Checked against the live server's database on 2026-11-03 (read-only): its 7 compacted chats hold 17 compactions, 11 of them in one August chat, where every summary but the newest was itself compacted later. The counts of messages taken out match a direct count of compacted rows without an active copy.
- Nothing is kept on this computer. Every opening, a refresh, or a compaction asks Hermes again.
- The inspector is keyed to the chat's runtime session, so it is dropped with the connection or when the session changes. An answer that comes back for another connection, profile or session is refused and never shown.
- A long chat's compaction history reads up to 10,000 stored rows, 500 a page. Past that, the inspector says so, and later compactions may be missing.
- "Show where it happened" goes to the first message in the loaded transcript that was stored at or after the summary row. Messages Hermes copied past the boundary keep their earlier times, so they show above that point.
- A compaction that rotated the chat into a new session (Hermes's older path, `end_reason='compression'`) is read through the dashboard's ancestor merge (`include_ancestors=True`). It is counted only if its summary row is flagged or carries Hermes's markers.
- Hermes's per-category figures, file statuses and labels are its own. A Hermes that changes them changes what the inspector shows. A Hermes without `session.context_breakdown` gets an explanation instead of a breakdown.
