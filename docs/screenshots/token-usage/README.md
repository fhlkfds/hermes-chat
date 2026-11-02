# Token and cost tracking screenshots

Captured on 2026-11-02 at 1280 × 800 through T3 Code's collaborative browser, from the running React app after merging failed-send recovery (implementation commit `a6fa08a`).

The app used its real UI and transport with `FakeHermes` in place of Tauri's native bridge. No live provider prompt was sent. Titles, messages, tool results and the streamed turn are demonstration fixtures; the starting chat usage values were copied from read-only observations of the deployed Hermes `bf0203a` database. The streamed turn and its updated aggregate are synthetic. This verifies browser rendering and interaction, not a native WebKit or authenticated live-server session.

- `1-reply-and-chat-usage.png`: compact reply tokens and chat totals/cost.
- `2-reply-breakdown.png`: input, combined cache, output, reasoning, calls and model; no per-reply cost supplied by Hermes.
- `3-chat-breakdown.png`: stored totals, separate cache reads/writes, estimated cost and its source/coverage explanation.
- `4-imported-chat-partial-cost.png`: imported Telegram chat with an unpriced latest call and a lower-bound estimate.
- `5-included-cost.png`: subscription route, with the scope of “Included” explained.
