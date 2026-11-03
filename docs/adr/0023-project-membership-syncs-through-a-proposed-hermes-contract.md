# Which chats are in a project syncs through Hermes once Hermes keeps it; until then it stays on this computer

Supersedes the membership part of ADR 0007. Projects and their folders are still Hermes's own (`projects.*`, ADR 0007).

A chat could be in different projects on different computers, because which chats are in a project (its **membership**) was kept on each computer (`hermes-chat.projects`). Issue #84 asks for it to be kept by Hermes, per connection and profile, so every computer signed in to a profile shows the same.

## What Hermes has

Checked on the deployed checkout `bf0203a` over SSH on 2026-11-03:

- `projects.db` has `projects`, `project_folders`, `project_meta` and `discovered_repos`. Nothing links a project to a session. The official desktop groups sessions by working folder (`project_for_path`), and `tools/project_tools.py` reads a session's project from its `cwd` the same way.
- The `sessions` table (`hermes_state_common.py`) has no free-form metadata, tag or label column; the sidebar `PATCH` writes only `pinned`, `archived` and read marks (`hermes_state_mutations.py`).
- `POST /api/fs/write-text` can write any file, but has no revision or compare-and-swap ("Stale-on-disk detection is the client's job"), so two computers writing one file would silently drop each other's changes. It is also refused by this app's relay (ADR 0012).

So Hermes has no supported store for membership. The app doesn't invent one and doesn't put membership in a project's `description`, a session's title, a hidden transcript row, `config.yaml`, memory or a file on the server.

## Decision

The app speaks a membership contract, laid out below, and uses it only when Hermes says it has it: `projects.list` answers with `chat_membership: {version: 1, revision}`. A server that doesn't say so is never sent a membership call, and membership stays on this computer exactly as before (ADR 0007), with the project screen and the **Between computers** screen saying why. Nothing is stored on the server for it.

When Hermes does keep membership:

1. **Copy, with a preview.** The first time, this computer's membership is planned against Hermes's records (`migrationPlan`) and shown before anything is written: how many chats will be added to each project, how many Hermes already has (not added twice), which were taken out on another computer (left out), and which are in projects Hermes no longer has (not copied). Nothing is written until the owner chooses **Copy to Hermes**; **Not now** keeps membership on this computer until the app starts again. A computer with no membership of its own uses Hermes's straight away. The plan is read afresh when the owner copies, so a change made elsewhere meanwhile is respected.
2. **Recovery copy.** The membership this computer had is kept beside it (`recovery`), never cleared, and **Put them back…** re-adds the chats Hermes no longer has in their projects, after asking.
3. **Operations, not snapshots.** Every change is an operation: put chat C in project P, or take it out, with a random `op_id` and the pair's revision as this computer last read it (`expected_rev`). Hermes applies it only if the pair is still at that revision. Copying is the same: one add per pair.
4. **Pending state.** An operation is kept in this computer's document (`synced.pending`) until Hermes answers it, so it survives a restart, a dropped connection and an older server. The list shows Hermes's records with the waiting operations on top. A chat's menu marks a project change **Waiting**, the switcher says how many changes are waiting, and the Between computers screen lists them.
5. **Conflict policy.** Deterministic and per pair:
   - Hermes already has the pair as the operation wants (another computer made the same change): done, no conflict.
   - Hermes's record of the pair changed since this computer read it, and differs: **conflict**. The operation isn't applied and waits for the owner; meanwhile the list shows what Hermes has, and nothing more is sent for it. The owner keeps Hermes's side (the operation is dropped) or this computer's (sent again with a new `op_id` over the revision Hermes reported). A later read in which Hermes has come round to the operation settles it.
   - Otherwise it is applied.
   Each operation is an absolute set (in or out), not a toggle, so a repeat can't flip it back. Hermes answers a repeated `op_id` with its first answer and applies nothing.
6. **Sync.** After the projects are read (on connecting, reconnecting and opening the switcher), when the window comes back to the front, after each change, and on **Sync now**: read Hermes's records, drop operations Hermes agrees with, send the rest in calls of at most 200, then read the records back. The list then shows Hermes's records, other computers' changes included; pairs nobody changed stay as they were.
7. **Deleting a project** removes its membership records in Hermes (the contract cascades) and drops this computer's waiting operations for it. Its chats and folders stay. A deleted chat is taken out of its projects with remove operations.
8. **A server that stops keeping membership** (downgraded, or the profile moved): the last copy keeps showing, changes wait, nothing is sent.

Membership is scoped like everything else in the projects document: by connection (mode, target, username) and profile, and Hermes keeps it per profile in that profile's `projects.db`. Records name stable ids only (project id and session id), never titles, and nothing about membership goes in a share link.

## The backend contract (version 1)

Proposed for Hermes, in `tui_gateway/methods_projects.py` beside the other `projects.*` methods, all profile-scoped with `profile`. A reference implementation against `bf0203a` is in `docs/backend/project-chat-membership.patch`.

Storage, in the profile's `projects.db`:

```sql
CREATE TABLE project_chats (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  member     INTEGER NOT NULL,   -- 0: taken out; the row stays, so its rev fences later changes
  rev        INTEGER NOT NULL,   -- the profile-wide revision of the row's last change
  changed_at REAL NOT NULL,
  PRIMARY KEY (project_id, session_id));
CREATE TABLE project_chat_ops (op_id TEXT PRIMARY KEY, result TEXT NOT NULL, applied_at REAL NOT NULL);
CREATE TABLE project_chat_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
```

Methods:

- `projects.list` and `projects.delete` add `chat_membership: {version: 1, revision}` to their answer. This is the capability advertisement: a client sends nothing else without it.
- `projects.chats.list {profile, project_id?, include_removed?}` → `{revision, links: [{project_id, session_id, member, rev}]}`. Taken-out rows only with `include_removed`.
- `projects.chats.apply {profile, ops: [{op_id, kind: "add" | "remove", project_id, session_id, expected_rev?}]}` → `{revision, results: [{op_id, status, member, rev}]}`. At most 500 operations, applied in order in one write transaction. `status` is `applied`, `unchanged` (already so), `conflict` (not applied: `expected_rev` isn't the row's `rev`; `member` and `rev` are Hermes's) or `no_such_project`. An `op_id` seen before answers its stored result and applies nothing. A malformed operation fails the whole call with 5063 and applies nothing; other failures are 5061.
- `projects.delete` cascades the project's rows and bumps the revision.

Not in version 1, and suggested for Hermes: removing a deleted session's rows when the session is deleted (state and projects are separate databases, so this needs a hook in session deletion; the app sends removes for chats it deletes itself), pruning `project_chat_ops` after some weeks, and an event so connected clients needn't poll.

## Considered options

- **Keep membership local (ADR 0007 as it was).** Rejected for a server that can keep it: the issue is that computers disagree.
- **A JSON file on the server through `POST /api/fs/write-text`.** Rejected: no compare-and-swap, so concurrent writers lose changes; visible and editable in the file browser; refused by the relay; and not a relationship other Hermes clients could use.
- **Project `description`, session titles, hidden transcript rows, `config.yaml` or memory.** Rejected: each is shown to the owner or the model, edited by other clients, or both.
- **Whole-snapshot sync with last write wins.** Rejected: a computer that was offline would undo every change made elsewhere meanwhile. Operations change only the pairs the owner touched.
- **Automatic resolution (this computer always wins, or Hermes always wins).** Rejected: either silently drops a deliberate change. Conflicts are rare (the same chat, the same project, on two computers, between two reads), so asking is cheap.
- **Calling `projects.chats.*` and treating "method not found" as unsupported.** Rejected: a server that doesn't advertise the contract is never sent a method it didn't say it has, and a future method of the same name with other semantics can't be misread.

## Consequences

- Against today's Hermes, behaviour is unchanged: membership stays on this computer, the project screen says so, and the Between computers screen says what Hermes needs.
- Once Hermes keeps membership, every client signed in to the profile shows the same chats in each project; other Hermes clients can read the same records.
- The projects document (`hermes-chat.projects`, still version 1) gains, per scope, `synced: {at, links, pending}` and `recovery: {at, chats}`. Once `synced` is there, `chats` is derived from it. An older Hermes Chat keeps both fields when it writes, but its own membership edits on that scope wouldn't be sent.
- A scope that was never synced stays local even after Hermes gains the contract, until the owner copies (or has nothing to copy).
- Verified against the fake server (`src/hermes/membership.test.ts`, `src/ui/membershipSync.test.tsx`) and against the reference patch running on a throwaway `HERMES_HOME`; see the PR for what was exercised live.
