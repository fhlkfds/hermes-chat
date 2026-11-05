# Outputs checks where its files are each time it opens

Issue #223: on the Outputs page, Edit on `hermes-verify-install.sh` failed with "can't be edited here: That file isn't on the server, or is gone now". The issue named four possible causes. Checked against the real Hermes (v0.22.6, default profile) and its stored rows:
- **Wrong machine:** no. The profile's terminal is `local`, so the tools and the dashboard share one disk. Preview and Edit read a tool's file through `/api/fs/*` with the profile, and a `host` file through the managed files routes, as the availability check does (ADR 0016, ADR 0029).
- **Wrong profile:** no. The chat is in the default profile, and every Outputs request names the profile of the index.
- **Path form:** no. `write_file`'s `args.path`, `resolved_path` and `files_modified` were all `/home/liam/.hermes/cache/scratch/hermes-verify-install.sh`.
- **The file is really gone:** yes. Right after its last `write_file`, the chat's own `terminal` call ran `bash …/hermes-verify-install.sh; rc=$?; rm -f …/hermes-verify-install.sh`. `GET /api/fs/read-data-url` then answered `404 {"detail":"File not found"}`, which was correct.

The bug was the app's. ADR 0016 checked where files are only when the owner pressed Refresh or added a file. Until then a row said "Not checked", and Edit and Preview stayed on for a file that was gone.

**Decision:** opening Outputs, or changing its scope, now runs what Refresh runs: it reads the chats that changed, then checks every file shown, within ADR 0016's limit of 40 folders. A file that is gone shows Missing before anything is clicked. Its Edit and Preview are off, and say why: "Refresh checks again, or show its folder in Server files to look for it". The row's folder button opens that folder in Server files. Two rules make it safe to run without asking (`OutputsIndex.refresh`). A refresh that a newer one, or a profile switch, replaced while it read doesn't check, so it can't cancel the newer one's check. And a read that failed isn't followed by a check, so its error stays on screen.

**Considered:** checking only when Edit or Preview is clicked. Rejected: the row would still claim nothing until the click, and the issue asks for Missing before it.

**Consequences:** each opening lists up to 40 folders, one request per folder. A file deleted while Outputs is open still shows its last state until Refresh, or until Outputs opens again.
