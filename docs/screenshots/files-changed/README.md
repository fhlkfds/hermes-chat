# Files a reply changed (#601)

Real desktop app (`verify-hermes-chat`) against a throwaway Hermes `bf0203a` dashboard with a stub model that makes scripted file edits. No real server was used.

- `01-chip.png`: a reply that patched `a.txt` and `b.txt` shows "2 files changed".
- `02-preview.png`: the Preview shows the `rollback.diff` of each file. A line typed into `a.txt` by hand, outside the bot's change, marks it "Edited by hand".
- `03-undo-turn-preview.png`: **Undo this turn** lists every path, with the hand-edited `a.txt` unchecked.
- `04-refused.png`: a file added to the folder after the preview makes the restore refuse; nothing was restored.
- `05-undone-b.png`: **Undo this file** on `b.txt`. On disk `b.txt` is back to `beta original`, `a.txt` keeps the bot's change and the hand edit, and the stored chat keeps all its rows.
- `06-diagnostics.png`: the Diagnostics row says the methods are there and checkpoints are on.
- `07-checkpoints-off.png`: with `checkpoints.enabled: false`, the chip says so and the Preview says how to turn them on (after an app relaunch, from the stored chat).

## Setup

- Hermes `bf0203a` in a Python 3.14 venv (`uv sync --frozen --extra web`), run by `setup/dash.sh` on `127.0.0.2:26011` with a fresh `HOME` and `HERMES_HOME` under `/tmp/hermes601`. `CHECKPOINTS=false setup/dash.sh` turns checkpoints off.
- `setup/stub_model.py` is the OpenAI-compatible model. A prompt with "edit two files" patches `a.txt` and `b.txt`.
- `setup/probe.mjs` (with `setup/rpc.mjs`) calls `rollback.list`, `rollback.diff` and `rollback.restore` directly, and settled the facts ADR 0180 cites. One of them is that a one-file restore of a file the bot created fails with "pathspec … did not match".
