# Context inspector screenshots

Captured on 2026-11-03 with `node docs/screenshots/context-inspector/harness/shoot.mjs`. That script builds a
production page of the app's real `ChatPane`, `StatusBar`, `ContextInspector` and `transport.ts`, and screenshots it in
headless Chromium (Playwright's cached build, over the DevTools protocol) at 1280 × 820, or 760 × 820 for image 7.
Behind the page is the tests' fake Hermes (`src/hermes/fakeHermes.ts`), speaking the wire shapes of the deployed
Hermes. Every chat, message, path and figure is synthetic.

These aren't captures of the Tauri window (WebKitGTK). This machine has no X server or `xdotool`, and its disk was at
93%, too full for a fresh `tauri build`. The webview and the Rust relay aren't part of this change.

1. `1-window.png`: the Window tab. It shows Hermes's total with its provenance label (Partly estimated), Hermes's
   estimate by category, Tool output as Unavailable, and the categories Hermes left out.
2. `2-unavailable.png`: a chat reopened on Hermes and not yet sent to. This matches the live server's answer (below):
   no usage frame yet, so the meter reads "Context not measured", and Hermes's breakdown is all zeros. The total and
   the split say Unavailable. The prompt cache comes from the chat's stored usage, labelled as billing, and kept apart
   from the window.
3. `3-compactions.png`: the Compactions tab. Two stored compactions, newest first, each with its time, how many
   messages it took out, and the summary Hermes kept, shown as plain text.
4. `4-compact-confirm.png`: Compact now's confirmation, which says what changes. Cancel has focus.
5. `5-compacted.png`: Hermes's answer after confirming. Its token figures are labelled as Hermes's estimate.
6. `6-no-compactions.png`: a chat with no stored compactions.
7. `7-narrow.png`: the inspector in a 760-pixel-wide window.

## Live check (real data, counts only)

The app's real `transport.ts` was connected through a small Node pipe. The pipe signs in the way the Rust relay does:
`auth/password-login`, `api/auth/ws-ticket`, then `/api/ws`. It connected to a **throwaway Hermes dashboard** started
on the Hermes server from its own checkout, with a throwaway `HERMES_HOME` under `/tmp`, a synthetic login, and a
read-only snapshot of the live default profile's session store (SQLite backup API, source opened `mode=ro`). The live
store and the running dashboards weren't used. The throwaway dashboard and the snapshot were deleted afterwards.
Nothing below shows chat content.

- **Compaction history** (`GET /api/sessions/{id}/messages?include_compacted=true`) for the 9 chats with compacted
  rows: 20 compactions. They include an August chat with 11, where every summary but the newest was itself compacted
  later. Those August summaries carry no `_compressed_summary` flag and were found by Hermes's marker. For every chat,
  the messages counted as taken out match a direct SQL count of distinct messages that are compacted with no active
  copy: 76, 1, 84, 20, 134, 26, 39, 155 and 933. Each message is counted once.
- **Before a chat is open on this connection**, `inspectContext` refuses ("This chat isn't open on Hermes.") and
  asks Hermes nothing.
- **Right after `session.resume`**, `session.context_breakdown` answered with no total and no categories, because the
  agent isn't built until the next prompt. Hermes's no-agent answer defaults `context_source` to `provider_usage`. The
  inspector still shows "Not measured yet" and Unavailable, never "Exact". The chat's live usage held no context
  measure, so the meter reads "Context not measured" and still opens the inspector.
- **The billing cache** came from the chat's stored usage. For example, one chat recorded 1,478,289 uncached input
  tokens and 9,625,984 cache reads over 52 calls. That is far more than any window, which is why the inspector shows
  them apart from the total.

Not exercised live: a built agent's categories and instruction files, and Compact now. Both need a model call
(provider keys and spend), so they weren't run against the owner's chats. They are covered by the tests against the
fake Hermes.

The server's Hermes was updated during this check (`hermes update`, v0.22.5 `bf0203a` → v0.22.6 `f0d94882`, at
21:14 UTC). The live results above are from `f0d94882`. Between the two versions, the `session.context_breakdown`
answer, the compaction markers and the `session.compress` result didn't change.
