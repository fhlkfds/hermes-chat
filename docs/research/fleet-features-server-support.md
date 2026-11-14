# Fleet features: what the Hermes server gives each one

- Date: 2026-11-14
- Upstream: https://github.com/NousResearch/hermes-agent, read from source at three commits. No Hermes server was contacted for this survey.
- Scope: the ten fleet features tracked from issue #50. Each section lists every route, method, event and setting the feature needs, where Hermes defines it, and whether the owner's server has it.

## The three commits

| Commit | Release | Date | What it is here |
|---|---|---|---|
| `b200f5bc` | `v0.22.7` | 2026-11-03 | The source the feature research read |
| `f0d9488` | `v0.22.6` | 2026-11-02 | The owner's deployed checkout |
| `bf0203a` | `v0.22.5` | 2026-10-23 | The owner's deployed server |

Each commit is the exact commit its release tag points at, and each older one is an ancestor of the next. The feature research called `b200f5bc` "Hermes 0.23". It is `v0.22.7`. `v0.23.0` is the first later release, and it contains `b200f5bc`.

## What the survey found

The owner's server has far more than the research assumed. Of 529 items, 11 that exist at `b200f5bc` are missing at `bf0203a`, and one is missing at `f0d9488`. Three more are in no commit. They are reads the features would need that Hermes doesn't have.

| Feature | Items | Missing at `bf0203a` | Missing at `f0d9488` | On the owner's server |
|---|---|---|---|---|
| 1. Time machine (#601) | 20 | 0 | 0 | Works. Checkpoints are off by default, so the chip must say how to turn them on. |
| 2. Flight recorder (#602) | 61 | 1 | 0 | Works. `bf0203a` has no `turn_id` on three message events and no `subagent.roster`. The recorder needs neither. |
| 3. Standing missions (#603) | 41 | 0 | 0 | Works for chats live on the dashboard. No commit has a read for goals in chats that aren't live. |
| 4. Mission control (#604) | 55 | 0 | 0 | Every kanban route is there. Decompose can't be previewed, on any commit. |
| 5. Guardrails and budgets (#605) | 56 | 1 | 0 | Works, except stopping a cron run that is already going on `bf0203a`. No commit has a manual-dispatch switch. |
| 6. Bot test lab (#606) | 54 | 0 | 0 | Works. |
| 7. Fleet console and releases (#607) | 65 | 0 | 0 | Works. No route is limited to loopback. |
| 8. Fleet memory (#608) | 31 | 0 | 0 | Works. Source links for memory writes are inferred on every commit. |
| 9. Rooms (#609) | 60 | 6 | 1 | Works for rooms of the owner's own bots. The research said the server would refuse. |
| 10. Talk to the gateway directly (#610) | 86 | 3 | 0 | Hidden on `bf0203a`, which has no address that speaks the canonical protocol. Possible on `f0d9488`. |

The counts for features 3 and 10 leave out the three items that are in no commit.

## Where the survey changes a plan

Each of these differs from the feature brief. The feature's own section has the source for it.

- **Rooms can ship on the owner's server.** `bf0203a` serves 18 `groups.*` methods and all four `bot_relay.*` methods on the dashboard's `/api/ws`, with no setting to turn on. The first `groups.capabilities` call can write a secret file on the server, so the app must not use it as its check.
- **Decompose writes its cards at once.** No route returns a plan without creating the cards, and the dispatcher starts the first of them within one tick. "Edit the plan before anything runs" needs either a Hermes change or an app-side hold that is still unproven.
- **A goal needs a live chat.** On the dashboard a goal stops when its chat closes, and nothing restarts it after a server restart. A check that exits 0 isn't enough, because the judge model must also agree. Hermes has no turn budget per goal.
- **Whole-folder undo also rewinds the chat.** `rollback.restore` without a file removes the chat's newest message. **Undo this turn** must restore files one at a time, and a one-file restore keeps no hand edits, so the app has to detect them itself.
- **No call switches the board to manual dispatch,** and `delegation.pause` covers every bot the dashboard serves, not one.
- **`llm.oneshot` takes no model.** The test lab's judge can't run on a model the owner picks without a workaround.
- **A backup holds every profile's secrets,** and a drain doesn't lead into a restart.
- **A search hit doesn't name its message,** so a link from a search result opens the chat, not the exact message. An Ask answer can still link exact messages, because it reads the matching messages itself, and those rows carry ids.
- **A stored run has one time per row and a cost per chat.** Step times and step costs for runs the app didn't watch are inferred.

## How the tables were checked

Each feature has a table in [`fleet-features-server-support/`](fleet-features-server-support/), one row per item, with the file and line at each commit. Two scripts check them.

- `check-survey.mjs` opens every cited file at every cited line, in a checkout of each commit, and fails a row when the item's name isn't within two lines. For a row that says an item is absent, it searches the whole tree and fails when a route, method or event with that name is defined.
- `added.mjs` finds the first release whose source has the item's name in the cited file, and writes `added.tsv`. It fails when that release disagrees with what the row says about `v0.22.5` or `v0.22.6`.

At this commit, `check-survey.mjs` reports 529 rows and 0 failures, and `added.mjs` reports 0 contradictions across 45 releases from `v2026.3.12` to `v0.22.7`.

To run them again, for example against a newer Hermes:

```
git clone https://github.com/NousResearch/hermes-agent.git hermes-agent
mkdir trees
for c in b200f5bc bf0203a f0d9488; do git -C hermes-agent worktree add ../trees/$c $c; done
HERMES_TREES=$PWD/trees node docs/research/fleet-features-server-support/check-survey.mjs
HERMES_GIT=$PWD/hermes-agent/.git node docs/research/fleet-features-server-support/added.mjs
```

### What the columns mean

- **At `b200f5bc`** is the file and line of the definition.
- **`bf0203a`** and **`f0d9488`** say whether that commit has the item. "Differs" means the contract a client sees changed, not that lines moved.
- **Gate** is what must be true on the server for the item to answer.
- **Added in** is the first release whose source has the item's name in the cited file. "In another file until" means the cited file didn't exist before that release, and an older file had the name. A name can exist before it works the way the row describes, so read the date as the earliest possible one.

### Limits

Everything here was read in source. Nothing was run against a Hermes. Each section ends with the questions source couldn't settle and the check on a throwaway Hermes that would settle each one. The feature's first PR runs those checks.

The scripts prove that each item is where the table says, and that it is present or absent at each commit. They don't prove the prose about how an item behaves. An outside review sampled that prose over five rounds. It found ten errors in the doc and one bug in `check-survey.mjs`. All ten were about how an existing route or field behaves, and none was about whether the owner's server has an item. Each was confirmed in source and fixed. Every round found at least one error in a part no earlier round had sampled, so expect a few that nobody has found yet. Before a feature builds on a claim here, read the cited lines again.

"Hermes changes" in each section are changes the app can't make. Each is filed as an issue when its feature ships.

## Time machine for files a bot changed

The feature needs four things from Hermes. It must list the checkpoints Hermes took before a bot changed files, show the diff for one, and restore one file or the whole folder. It must also say which files each reply changed. Every route and method below is the same at `b200f5bc`, `bf0203a` and `f0d9488`, so the owner's server has everything the research version has.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `rollback.list` | `tui_gateway/methods_tools.py:1123` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `rollback.diff` | `tui_gateway/methods_tools.py:1168` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `rollback.restore` | `tui_gateway/methods_tools.py:1135` | Yes, same | Yes, same | A live chat. A whole-folder restore also needs the chat idle | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `rollback.session_diff` | `gateway/session_tui_ops.py:32` | Yes, same | Yes, same | Canonical gateway protocol only | `v0.22.3` (2026-10-21) |
| `GET /api/ops/checkpoints` | `hermes_cli/web_routers/ops.py:808` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/ops/checkpoints/prune` | `hermes_cli/web_routers/ops.py:838` | Yes, same | Yes, same | Needs `?profile=` on a host that serves several profiles. Aborts when a checkpointed folder is gone | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `hermes checkpoints prune` | `hermes_cli/checkpoints.py:203` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `checkpoints.enabled` | `hermes_cli/config_defaults.py:486` | Yes, same (line 513) | Yes, same | None. Default `False` | `v2026.3.12` (2026-03-12) or earlier, in another file until `v2026.7.30` |
| `checkpoints.max_snapshots` | `hermes_cli/config_defaults.py:489` | Yes, same | Yes, same | None. Default 20 | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `HERMES_TUI_CHECKPOINTS` | `tui_gateway/checkpoints.py:40` | Yes, same | Yes, same | None | `v2026.5.7` (2026-05-07), in another file until `v0.21.6` |
| `GET /api/config` | `hermes_cli/web_routers/config_env.py:81` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `tool.start` | `tui_gateway/contracts/events.py:413` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `tool.complete` | `tui_gateway/contracts/events.py:432` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `GET /api/sessions/{session_id}/messages` | `hermes_cli/web_routers/sessions.py:743` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| Stored tool row `display_metadata` | `agent/tool_executor.py:1159` | Yes, same | Yes, same | None | `v2026.9.24` (2026-09-24) |
| Checkpoint before `write_file` and `patch` | `agent/tool_executor.py:1035` | Yes, same | Yes, same | `checkpoints.enabled`, host backend | `v2026.9.7` (2026-09-07) |
| Checkpoint before a destructive terminal command | `agent/tool_executor.py:1044` | Yes, same | Yes, same | `checkpoints.enabled`, host backend | `v2026.3.17` (2026-03-17), in another file until `v2026.5.28` |
| Agent-write ledger | `agent/turn_explainers.py:147` | Yes, same | Yes, same | `checkpoints.enabled` | `v2026.8.16.2` (2026-08-17), in another file until `v2026.9.7` |
| `session.branch` | `tui_gateway/methods_session.py:2184` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.resume` | `tui_gateway/methods_session.py:1044` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |

### The methods, as the app would call them

All three `rollback.*` methods answer on the dashboard's legacy `/api/ws`. A dashboard with no session authority sends every request to `server.dispatch` (`tui_gateway/ws.py:387`), and `@_rpc` registers each method there with `method(name)` (`tui_gateway/methods_tools.py:84`). The canonical gateway answers the same names through its own handler (`gateway/session_tui_ops.py:29`).

`rollback.list` takes `session_id` and an optional `profile`. It answers `{enabled, checkpoints}`. Each checkpoint has `hash`, `timestamp` and `message` (`tui_gateway/methods_tools.py:1129`). With checkpoints off it answers `enabled: false` and an empty list (`methods_tools.py:1126`). Errors are 4001 for a chat that isn't live and 5020 for anything else.

`rollback.diff` takes `session_id` and `hash`. The hash may be a real hash or a 1-based number from the list (`tui_gateway/checkpoints.py:46`). It answers `{stat, diff, rendered}`. `rendered` is an ANSI rendering for a terminal. Errors are 4001, 4014 (`hash required`) and 5022, which covers a chat whose terminal runs in a container.

`rollback.restore` takes `session_id`, `hash`, and optionally `file_path` and `all`. It answers the manager's result plus `history_removed` (`tui_gateway/contracts/tools_commands.py:397`). The fields are `success`, `restored_to`, `reason`, `directory`, `file`, `restored_files`, `skipped_user_edits`, `skipped_oversize`, `failed_deletes` and `error`. Errors are 4001, 4014, 4001 `invalid_params` when `all` isn't a boolean, 4009 when a whole-folder restore arrives while a reply runs (`methods_tools.py:1145`), and 5021. Many failures come back as `success: false` with an `error` string and no error code. Examples are a checkpoint that doesn't exist and a folder that holds a nested git repository.

### Answers to the open questions

**Live chat.** Each method needs the chat live in the dashboard process. `_sess_nowait` answers 4001 `session not found` for any other id (`tui_gateway/session_registry.py:320`). The app must call `session.resume` first, as it already does elsewhere (`src/hermes/transport.ts:4462`).

**One file or the whole folder.** Restore takes one file through `file_path`. A one-file restore checks the file out of the checkpoint (`tools/checkpoint_manager.py:1343`). It doesn't check for hand edits, and it doesn't touch the chat. A whole-folder restore runs in safe mode unless `all` is true (`methods_tools.py:1153`). Safe mode restores a changed file only when its contents still match what `write_file` or `patch` last wrote, according to the agent-write ledger (`checkpoint_manager.py:855`). It skips every other changed file and lists it in `skipped_user_edits` (`checkpoint_manager.py:907`, `:917`). A file a terminal command changed has no ledger entry, so safe mode keeps it and calls it a hand edit. When the ledger is empty, safe mode falls back to a full restore and overwrites hand edits (`checkpoint_manager.py:1259`). Before any restore, Hermes takes a "pre-rollback snapshot" of the folder, so a restore can be undone (`checkpoint_manager.py:1278`).

**Restore also rewinds the chat.** A successful whole-folder restore drops the chat's newest user turn and everything after it. It does that whatever checkpoint was restored (`methods_tools.py:1154` to `:1163`, `_rewind_active_session_history(session, len(user_indices) - 1)`). Restoring a checkpoint from three replies ago removes one reply, not three. A one-file restore leaves the chat alone. **Undo this turn** for the newest reply can use a whole-folder restore. Any other undo, and every undo in a branch, must restore files one at a time with `file_path`, or it removes the wrong message.

**What ties a checkpoint to a reply.** Only the time. A checkpoint is a commit in a shadow git store. Its message is the reason, such as `before write_file`, `before patch` or `before terminal: <first 60 characters of the command>` (`agent/tool_executor.py:114`, `:1044`). It carries no chat id, turn id or message id. The manager also works out `short_hash`, `files_changed`, `insertions` and `deletions` (`checkpoint_manager.py:976`), but `rollback.list` drops them (`methods_tools.py:1129`). No checkpoint has a size of its own. Checkpoints belong to a folder, not a chat (`checkpoint_manager.py:217`), so a chat's list also shows checkpoints that other chats in the same folder took. A reply can make several, because Hermes resets the one-per-folder rule on every agent step, not once per reply (`agent/turn_iteration_prep.py:380`). Hermes sends no event when it takes a checkpoint.

**"This reply changed 3 files".** The app can count this itself. `tool.start` and `tool.complete` carry the tool's `args`, so `write_file` and `patch` name their `path` (`tui_gateway/tool_progress.py:305`). `tool.complete` adds `inline_diff` for a file edit (`tool_progress.py:324`). Hermes also stores that diff on the tool row as `display_metadata` (`agent/tool_executor.py:1159`). The messages route copies rows whole (`hermes_cli/web_routers/sessions.py:704`), so a chat that isn't open can be counted too. A terminal command that changed files names none of them anywhere.

**What a diff shows.** `rollback.diff` compares a checkpoint with the files as they are now, not with the next checkpoint (`checkpoint_manager.py:1066`). To show what one reply changed, the app must diff the checkpoint before the reply against the one after it. No method does that. The server cuts the diff at 4000 characters (`methods_tools.py:1178`), so a larger change arrives incomplete. When the manager fails, the method still answers `{stat: "", diff: ""}` with no error (`methods_tools.py:1177`). The app can't tell "no changes" from "the diff failed".

**Turning checkpoints on.** `checkpoints.enabled` is `False` by default at all three commits (`hermes_cli/config_defaults.py:487`). It lives in each profile's `config.yaml`. The dashboard reads it when it builds a chat's agent (`tui_gateway/agent_factory.py:680`), so turning it on affects chats built after the change. `HERMES_TUI_CHECKPOINTS` overrides it when set (`tui_gateway/checkpoints.py:40`). Two reads change nothing. `GET /api/config?profile=` shows the setting without a live chat. `rollback.list` shows what the chat's agent actually uses, as `enabled`.

**The store routes.** `GET /api/ops/checkpoints` takes `?profile=` and answers `{sessions: [{session, files, bytes}], total_bytes}` (`ops.py:808`). Each entry is a folder under `<profile home>/checkpoints`. Since the single shared store (`checkpoint_manager.py:86`), that means one `store` entry plus any old `legacy-*` archives. It gives no size per chat or per checkpoint. `POST /api/ops/checkpoints/prune` starts `hermes -p <profile> checkpoints prune` and answers `{ok, pid, name}` at once (`hermes_cli/web_routers/_common.py:138`). It refuses with 400 when `profile` is missing on a host that serves several profiles (`_common.py:62`). Neither route is loopback-only. Prune deletes checkpoints for folders not touched in 7 days and for folders that are gone, then shrinks the store to 500 MB. Over this route it can do nothing at all. When any checkpointed folder is gone, `hermes checkpoints prune` asks for confirmation before it deletes anything (`hermes_cli/checkpoints.py:76`, `:121`). The route passes no `--force` and gives the command no input (`ops.py:841`, `hermes_cli/web_server_gateway.py:526`). The question gets no answer, so the command prints `Aborted.`, exits 1 and prunes nothing. All three commits do this. The app must read the exit code from `GET /api/actions/checkpoints-prune/status` and must not call a prune done from the `{ok, pid, name}` answer.

**What checkpoints cover.** They cover `write_file` and `patch` (`agent/tool_executor.py:1035`). They cover terminal commands that match a short pattern list: `rm`, `rmdir`, `cp`, `install`, `mv`, `sed -i`, `truncate`, `dd`, `shred`, `git reset`, `git clean`, `git checkout`, and `>` redirects (`agent/tool_dispatch_helpers.py:53`). They skip a chat whose terminal runs in a container (`checkpoint_manager.py:809`), the root and home folders (`:932`), folders with more than 50,000 files (`:164`), files over 10 MB, and the default excludes such as `node_modules/`, `.git/` and `.env` (`:97`). They don't cover any other shell command, scripts, MCP or plugin tools, databases, pushed commits, sent messages, or anything outside the folder.

**Rewind here.** Branch from here uses legacy `session.branch {session_id, count, idempotency_key}` (`src/hermes/transport.ts:2467`, `tui_gateway/methods_session.py:2184`). The branch keeps the parent's folder (`tui_gateway/methods_session_branch.py:115`), so it sees the same checkpoints. Rewind here can be built from `session.branch` and then one `rollback.restore` with `file_path` per file. It can't use a whole-folder restore, because that drops the newest user turn of whichever chat it names.

### Where the research was wrong or incomplete

- Grok said only REST routes exist and the feature needs a Hermes change. Source shows the three WebSocket methods at all three commits (`tui_gateway/methods_tools.py:1123`, `:1135`, `:1168`).
- Fable said the owner's `bf0203a` server "may predate these methods". It doesn't. The handlers and contracts match `b200f5bc` line for line.
- Fable and the brief name the contract file, `tui_gateway/contracts/tools_commands.py`. The handlers are in `tui_gateway/methods_tools.py`.
- Fable said `GET /api/ops/checkpoints` gives "count and size per session". The route's own comment says that too, but it sizes folders, and since the shared store that is one `store` entry (`checkpoint_manager.py:86`).
- Grok and the combined idea say **Rewind here** should stay a separate button so undoing files never rewinds the chat. Fable said restore leaves the chat alone. Source shows a whole-folder restore always drops the newest user turn (`methods_tools.py:1154`). The app must use one-file restores to keep the two apart.
- Fable said a checkpoint is taken "at most one per folder per turn". It is one per folder per agent step (`agent/turn_iteration_prep.py:380`), so one reply can make several.
- Fable said the restore keeps hand edits. That is true only for a whole-folder restore with a non-empty ledger. A one-file restore keeps none, and a terminal command's changes count as hand edits.
- None of the research says that `rollback.diff` compares against the files now, cuts at 4000 characters, and hides failures.
- None says that `rollback.list` drops the manager's per-checkpoint file counts, or that the list covers every chat in the folder.
- Fable suggested tying checkpoints to turns by timestamp. That is the only link Hermes gives. The research missed `tool.complete` `args` and `inline_diff`, and stored `display_metadata`, which name the files a reply edited.
- The research missed `HERMES_TUI_CHECKPOINTS`, which can make `GET /api/config` disagree with what a chat uses.
- Grok's `GET /api/config` lead holds. The route returns the profile's config with defaults (`config_env.py:81`).

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as it does on `b200f5bc`. The feature has nothing to hide for lack of a method. It must hide or explain these cases:

- Checkpoints are off, the default. `rollback.list` answers `enabled: false`. The chip says checkpoints are off for this bot and how to turn them on.
- The chat's terminal runs in a container. Hermes takes no checkpoints there, and diff and restore refuse.
- The app is signed in to a gateway's canonical address. The app refuses that protocol today (ADR 0174).

The capability probe is one call that changes nothing. Send `rollback.list` with `__hermes_chat_probe__` as `session_id`. "Session not found" (4001) means Hermes has the method. "Method not found" means it doesn't. Pair it with `GET /api/config?profile=` for `checkpoints.enabled`. That is how the app already probes `approval.respond` alongside `dashboard.turn_isolation`.

### What Hermes would need

The first PR needs no Hermes change. These changes would make the feature exact rather than inferred. File them as issues.

- `rollback.list` returning the fields the manager already has: `short_hash`, `files_changed`, `insertions`, `deletions`. Also the session id and turn or message id the checkpoint was taken for.
- `rollback.diff {session_id, hash, to_hash?, file_path?}` comparing two checkpoints, or one file, with no 4000-character cut and a real error when the diff fails. Result `{stat, diff, files: [{path, status, insertions, deletions}], truncated}`.
- `rollback.restore {session_id, hash, file_paths: [str], keep_user_edits: bool, rewind_history: bool}`. It would restore a chosen list of files in safe mode, and rewind the chat only when asked. Result as today, plus `restored_files` for every kind of restore.
- A `checkpoint.taken {session_id, hash, reason, turn_id}` event.
- A per-chat checkpoint read that doesn't need the chat live, keyed by stored session id.
- `POST /api/ops/checkpoints/prune` taking `keep_orphans` or `force`, so a prune over the route can finish when a checkpointed folder is gone.

### Open questions

- With `dashboard.turn_isolation` on, a turn runs in a child process. Source doesn't settle whether `rollback.restore` in the parent rewinds the stored chat correctly, or whether the parent's agent sees the child's ledger. Check on a throwaway Hermes with turn isolation: edit two files in a turn, then call `rollback.list`, `rollback.diff` and a whole-folder `rollback.restore`, and read the messages back.
- A one-file restore of a file the bot created after the checkpoint runs `git checkout <hash> -- <file>` on a path the checkpoint doesn't have. From git's behavior the survey infers it fails with "Restore failed" and leaves the file. Check on a throwaway Hermes.
- `restore` and `diff` don't check `enabled` (`checkpoint_manager.py:1118`). Source suggests they still work on an old store after checkpoints are turned off. Check on a throwaway Hermes.

## Flight recorder

The feature draws one run as a list of steps, each with how long it took, what it cost and whether it failed. For a run the app watched, it needs the events Hermes already sends on `/api/ws`. For a run it didn't watch, it needs what Hermes stores about each step, the subagents, and a way from a cron run or a Work card to the run's chat.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit. Every item is in all three trees except `subagent.roster`, which `bf0203a` lacks. Three `message.*` events lose their turn id at `bf0203a`.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `tool.start` | `tui_gateway/contracts/events.py:413` | Yes, same | Yes, same | `display.tool_progress` not `off`, or a UI tool | `v2026.9.14` (2026-09-14) |
| `tool.complete` | `tui_gateway/contracts/events.py:432` | Yes, same | Yes, same | As `tool.start` | `v2026.9.14` (2026-09-14) |
| `tool.generating` | `tui_gateway/contracts/events.py:441` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `tool.progress` | `tui_gateway/contracts/events.py:469` | Yes, same | Yes, same | `display.tool_progress` not `off` | `v0.22.3` (2026-10-21) |
| `tool.output_risk` | `tui_gateway/contracts/events.py:454` | Yes, same | Yes, same | `display.tool_progress` not `off` | `v2026.9.14` (2026-09-14) |
| `message.start` | `tui_gateway/contracts/events.py:150` | Yes, no `turn_id` | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `message.delta` | `tui_gateway/contracts/events.py:178` | Yes, no `turn_id`, `segment`, `offset` | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `message.interim` | `tui_gateway/contracts/events.py:194` | Yes, no `turn_id`, `segment` | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `message.complete` | `tui_gateway/contracts/events.py:305` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `reasoning.delta` | `tui_gateway/contracts/events.py:179` | Yes, same | Yes, same | `display.show_reasoning` | `v2026.9.14` (2026-09-14) |
| `reasoning.available` | `tui_gateway/contracts/events.py:180` | Yes, same | Yes, same | `display.show_reasoning` | `v2026.9.14` (2026-09-14) |
| `thinking.delta` | `tui_gateway/contracts/events.py:181` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `session.usage` event | `tui_gateway/contracts/events.py:354` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `session.usage` method | `tui_gateway/methods_session.py:1443` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `session.info` | `tui_gateway/contracts/events.py:525` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `status.update` | `tui_gateway/contracts/events.py:315` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `error` | `tui_gateway/contracts/events.py:120` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `approval` server request | `tui_gateway/contracts/server_requests.py:195` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `clarify` server request | `tui_gateway/contracts/server_requests.py:59` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `request.cancel` | `tui_gateway/contracts/server_requests.py:378` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `approval.cancelled` | `tui_gateway/contracts/events.py:574` | Yes, same | Yes, same | None | `v0.21.6` (2026-10-08) |
| `subagent.spawn_requested` | `tui_gateway/contracts/events.py:665` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `subagent.start` | `tui_gateway/contracts/events.py:666` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.9.14` |
| `subagent.progress` | `tui_gateway/contracts/events.py:667` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.9.14` |
| `subagent.thinking` | `tui_gateway/contracts/events.py:668` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.9.14` |
| `subagent.tool` | `tui_gateway/contracts/events.py:669` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.9.14` |
| `subagent.complete` | `tui_gateway/contracts/events.py:670` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.9.14` |
| `subagent.*` wire fields | `tui_gateway/tool_progress.py:460` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `todo.updated` | `tui_gateway/contracts/events.py:479` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `review.summary` | `tui_gateway/contracts/events.py:382` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `moa.reference` and its siblings | `tui_gateway/contracts/events.py:704` | Yes, same | Yes, same | `display.show_reasoning` | `v2026.9.14` (2026-09-14) |
| `session.events.since` | `tui_gateway/methods_session.py:2309` | Yes, same | Yes, same | None | `v2026.8.27` (2026-08-27) |
| Event frame envelope | `tui_gateway/server.py:589` | Yes, same | Yes, same | None | `v2026.7.30` (2026-07-30) |
| `spawn_tree.list` | `tui_gateway/methods_session.py:2265` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `spawn_tree.load` | `tui_gateway/methods_session.py:2285` | Yes, same | Yes, same | Path under the spawn-trees folder | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `spawn_tree.save` | `tui_gateway/methods_session.py:2228` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `subagent.list` | `tui_gateway/methods_subagents.py:53` | Yes, same | Yes, same | A live chat | `v2026.9.11` (2026-09-11) |
| `subagent.tail` | `tui_gateway/methods_subagents.py:180` | Yes, same | Yes, same | A live chat | `v2026.9.11` (2026-09-11) |
| `subagent.roster` | `tui_gateway/methods_subagents.py:114` | No | Yes, same | None | `v0.22.6` (2026-11-02) |
| `session.branch` | `tui_gateway/methods_session.py:2184` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `verification.status` | `tui_gateway/methods_session.py:592` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}/messages` | `hermes_cli/web_routers/sessions.py:743` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:560` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}/export` | `hermes_cli/web_routers/sessions.py:945` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| Stored `messages` table | `hermes_state_common.py:531` | Yes, same | Yes, same | None | `v2026.3.12` (2026-03-12) or earlier, in another file until `v2026.7.30` |
| Assistant row time and `finish_reason` | `agent/chat_completion_helpers.py:1648` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Tool row time | `agent/tool_dispatch_helpers.py:464` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16) |
| `delegate_task` per-child result | `tools/delegate_tool_child_run.py:680` | Yes, same | Yes, same | None | `v2026.8.13` (2026-08-13), in another file until `v2026.9.7` |
| `GET /api/cron/jobs/{job_id}/runs` | `hermes_cli/web_routers/cron.py:744` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| `GET /api/plugins/kanban/tasks/{task_id}` | `plugins/kanban/dashboard/plugin_api.py:379` | Yes, same | Yes, same | Kanban plugin | `v2026.5.7` (2026-05-07) |
| `GET /api/plugins/kanban/runs/{run_id}` | `plugins/kanban/dashboard/plugin_api.py:936` | Yes, same | Yes, same | Kanban plugin | `v2026.5.28` (2026-05-28) |
| `GET /api/plugins/kanban/tasks/{task_id}/log` | `plugins/kanban/dashboard/plugin_api.py:1255` | Yes, same | Yes, same | Kanban plugin | `v2026.5.7` (2026-05-07) |
| `owner_admitted` task event | `gateway/session_kanban.py:127` | Yes, same | Yes, same | Read through `GET tasks/{task_id}` | `v0.22.3` (2026-10-21) |
| `display.tool_progress` | `tui_gateway/agent_factory.py:317` | Yes, same | Yes, same | None. Default `all` | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `post_api_request` hook | `agent/turn_response_intake.py:77` | Yes, same | Yes, same | A plugin on the hook | `v2026.4.8` (2026-04-08), in another file until `v2026.9.7` |
| `post_tool_call` hook | `model_tools.py:705` | Yes, same | Yes, same | A plugin on the hook | `v2026.9.7` (2026-09-07) |
| `subagent_stop` hook | `tools/delegate_tool_results.py:382` | Yes, same | Yes, same | A plugin on the hook | `v2026.9.7` (2026-09-07) |
| Plugin dashboard routes | `hermes_cli/web_server_dashboard.py:1136` | Yes, same | Yes, same | Plugin trust gates | `v0.21.6` (2026-10-08) |
| `monitoring.export.otlp` | `hermes_cli/config_defaults.py:2083` | Yes, same | Yes, same | None. Default off | `v2026.9.7` (2026-09-07) |
| `save_trajectories` | `run_agent.py:1505` | Yes, same | Yes, same | `run_agent.py` flag only | `v2026.3.12` (2026-03-12) or earlier |
| Retry and fallback status buffer | `agent/status_output.py:216` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |

### What a watched run gets on the wire

Every item below is on the dashboard's legacy `/api/ws`. The event contracts in `tui_gateway/contracts/events.py` match at `b200f5bc` and `f0d9488` line for line. At `bf0203a` they differ only in the turn id fields.

| Event | Start pairs with end by | Length | Tokens | Cost | Failure | App handles it |
|---|---|---|---|---|---|---|
| `tool.start`, `tool.complete` | `tool_id` | `duration_s` on complete, measured by Hermes | None | None | None | Yes. It keeps `durationS` (`src/hermes/transport.ts:5847`) |
| `tool.generating` | Nothing. It has only `name` | None | None | None | None | No |
| `tool.progress`, `tool.output_risk` | `tool_id` | None | None | None | Risk findings | No |
| `message.start`, `message.complete` | Order only | None | `usage`, cumulative for the chat | None | `status`, `error`, `failure_reason`, `error_surface` | Yes |
| `message.delta`, `message.interim` | `turn_id` and `segment`, not at `bf0203a` | None | None | None | None | Delta yes, interim no |
| `reasoning.delta`, `reasoning.available` | Nothing | None | None | None | None | Yes |
| `session.usage` | Not a step | `avg_latency_s` over the last 10 calls | Cumulative counters, `calls` among them | None | None | Yes, for the live strip |
| `status.update` | Nothing | None | None | None | Kind `warn` | Only kind `process` |
| `error` | Nothing | None | None | None | `message` | Yes |
| `approval`, `clarify`, `sudo`, `secret` requests | Frame id, then the answer or `request.cancel` `id` | None | None | None | Cancel `reason` | Yes |
| `approval.cancelled` | `request_ids` | None | None | None | `reason` | Yes |
| `subagent.*` | `subagent_id` | `duration_seconds` on complete | Input, output and reasoning tokens and `api_calls` on complete | Dropped | `status`, `summary` | Yes, as the tree (ADR 0072) |
| `todo.updated`, `review.summary`, `moa.*` | Nothing | None | None | None | None | No |

**No event carries a server time.** An event frame is `{type, session_id, payload}` plus a per-session `seq` (`tui_gateway/server.py:589`, `tui_gateway/event_replay.py:72`). Every start and end the app records is its own arrival time. Only two lengths are measured by Hermes. `tool.complete` `duration_s` is the time from the tool's start callback to its completion (`tui_gateway/tool_progress.py:293`, `:345`). `subagent.complete` `duration_seconds` is the child's run time (`tools/delegate_tool_child_run.py:1105`).

**A model call has no event of its own.** The app can see its edges. A turn's first call starts at `message.start`. Reasoning and text deltas arrive during a call. A `tool.start` follows the call that asked for the tool. `session.usage` arrives at most once a second while a turn runs, and only when a counter changed (`tui_gateway/server.py:1877`). Its `calls` counter grows by one per model call (`tui_gateway/server.py:1297`). So a model call's start, end and tokens are inferred, to about a second, by comparing one `session.usage` with the next. The legacy `message.start` carries no field at `bf0203a` (`tui_gateway/prompt_turn.py:427`). At the other two it carries `turn_id` (`tui_gateway/stream_segments.py`). `message.complete` carries no `turn_id` at any of them (`events.py:281`), so a turn's start and end pair only by order.

**No cost reaches the legacy socket.** `Usage` declares `cost_usd` and `cost_status` (`tui_gateway/contracts/common.py:52`). `_get_usage` never sets them at any of the three commits (`tui_gateway/server.py:1289`). The child's `cost_usd` and `failure_reason` are built for `subagent.complete` (`tools/delegate_tool_child_run.py:1115`, `:1118`). The relay copies only the fields in `_SUBAGENT_FIELDS`, which names neither (`tui_gateway/tool_progress.py:460`). The chat's cost lives on the session row as `estimated_cost_usd` and `actual_cost_usd` (`hermes_state_common.py:497`). The app already reads it after every `message.complete` through `GET /api/sessions/{id}` (`src/hermes/transport.ts:2933`). A turn's cost can be inferred as the difference between the reads before and after it. A model call's cost can't be had at all.

**A failed tool call has no flag.** `tool.complete` has no error or status field (`events.py:416`). The executor passes `is_error` to its progress callback as `tool.completed` (`agent/tool_executor.py:1172`, wired at `tui_gateway/agent_callbacks.py:157`). The dashboard has no handler for that type, so it goes nowhere (`tui_gateway/tool_progress.py:504`, `:528`). The `post_tool_call` hook gets a status (`model_tools.py:703`). The app would have to judge failure from the result text.

**Tool events can be switched off.** With `display.tool_progress: off`, Hermes sends `tool.start` and `tool.complete` only for the UI tools: `clarify`, `delegate_task`, `write_file`, `patch`, `edit_file` and a few others (`tui_gateway/tool_progress.py:297`, `:366`, `tui_gateway/agent_factory.py:488`). The default is `all` (`agent_factory.py:317`). `HERMES_TUI_TOOL_PROGRESS` overrides it, and a live chat's mode can change through `config.set` (`tui_gateway/methods_config_set.py:261`).

**Compactions show as status lines.** Automatic compaction arrives as `status.update` kind `compacting` (`tui_gateway/server.py:747`). A manual one sends kind `compressing` (`tui_gateway/methods_session.py:2092`). `Usage.compressions` counts them. The stored compaction summary rows are what the context inspector already reads (`src/hermes/transport.ts:3717`).

**Retries and model fallbacks are mostly invisible.** Hermes holds back retry lines and drops them when the call recovers (`agent/status_output.py:216`, `:237`). They reach the client only when every retry failed (`status_output.py:259`). A switch to a fallback model is one `lifecycle` status line after the call recovers (`status_output.py:243`). `SessionUsagePayload` has `fallback_model`, but only the canonical gateway's frame fills it (`events.py:319`). The legacy ticker sends only `{usage}` (`server.py:1897`). There is no retry or fallback event.

**A reconnect loses times.** `session.events.since` replays the session's frames after a `seq` (`tui_gateway/methods_session.py:2309`). The ring holds 512 frames per session in that process (`tui_gateway/event_replay.py:30`). Text deltas fill it fast, so a long run can't be rebuilt from it. Replayed frames carry no time, so their steps get the reconnect's time.

### What a stored run holds

`GET /api/sessions/{session_id}/messages` takes `profile`, `limit`, `offset`, `order` (`oldest` or `latest`), `include_compacted` and `inline_images` (`hermes_cli/web_routers/sessions.py:743`). A page holds at most 500 rows. With no `limit` it returns the latest 500 (`sessions.py:760`). It includes the rows of the chat's earlier compression segments. It answers `{session_id, profile, messages, pagination}`.

Each row is the whole stored row (`hermes_state_messages.py:1410`, `:1297`). The columns are `id`, `role`, `content`, `tool_call_id`, `tool_calls`, `tool_name`, `effect_disposition`, `timestamp`, `token_count`, `finish_reason`, `reasoning`, `display_kind`, `display_metadata`, `message_uid` and a few flags (`hermes_state_common.py:531`). Assistant rows keep `tool_calls`, and tool rows pair with them by `tool_call_id`. Tool rows keep `display_metadata`, as the time machine survey found.

A row has one time, `timestamp`, and it marks the end of the step that made the row:

- An assistant row is stamped when Hermes builds it from the model's answer, after the call ended (`agent/chat_completion_helpers.py:1646`).
- A tool row is stamped when Hermes builds the result message, after the tool ran (`agent/tool_dispatch_helpers.py:464`).
- A user row is stamped when the turn starts, or with the time the platform gave (`agent/turn_context.py:703`).

So a stored step's length can only be inferred as the gap since the row before it. That gap holds the model call and the tool call both. For tools run together, Hermes adds the results in call order after they ran (`agent/tool_executor.py:1578`). The survey infers from that docstring that their gaps don't give each tool's own length.

A stored row has no start time, duration, usage or cost. The `token_count` column exists, but the survey found no code that sets it on a new message (searched `agent/`, `run_agent.py`, `gateway/` and `tui_gateway/` for `token_count`). `finish_reason` is set on assistant rows (`chat_completion_helpers.py:1648`), and on a few gate rows such as `verification_required` (`agent/turn_stop_gates.py:164`). Cost and tokens exist per chat on the session row (`hermes_state_common.py:485` to `:500`) and per model in `session_model_usage` (`hermes_state_common.py:564`). Only the analytics routes read the second (`hermes_cli/web_routers/analytics.py:314`).

One stored step is richer. The `delegate_task` tool row's result holds `results[]`, one per child, with `status`, `summary`, `api_calls`, `duration_seconds`, `model`, `tokens {input, output}`, `cost_usd` and a `tool_trace` (`tools/delegate_tool_child_run.py:657` to `:680`). The batch adds `total_duration_seconds` (`tools/delegate_tool_dispatch.py:215`). Those are numbers Hermes measured. The `tool_trace` names each child tool call and whether it failed, with no times (`delegate_tool_child_run.py:586`).

### Subagents of a stored run

`spawn_tree.list` takes `session_id`, `cross_session`, `limit` (default 50) and `profile` (`tui_gateway/contracts/sessions.py:665`). It answers `{entries}`, newest first, each `{path, session_id, started_at, finished_at, label, count}` (`methods_session.py:2265`). `spawn_tree.load {path}` returns the saved file, `{session_id, started_at, finished_at, label, subagents[]}`. It refuses a path outside `<home>/spawn-trees` with 4030 (`methods_session.py:2285`). Neither needs a live chat.

Hermes never saves a spawn tree itself. Only a client does, through `spawn_tree.save` (`methods_session.py:2228`). In the Hermes tree, the only caller is the Ink terminal UI at the end of a turn (`ui-tui/src/app/createGatewayEventHandler.ts:879`). So for chats run from Hermes Chat, cron or the Work board, `spawn_tree.list` returns nothing. Hermes Chat could save its own tree after a run it watched, then list and load it later. That would be a write, read back with `spawn_tree.list`. Any `spawn_tree.*` call creates the `spawn-trees` folder if it is missing (`tui_gateway/server.py:1826`, `:1832`).

`subagent.list` needs the chat live and lists only children still running, plus recently failed background delegations (`tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py:666`, `tui_gateway/methods_subagents.py:53`). A finished child drops out. The subagents drawer (ADR 0072, ADR 0163) builds its tree from `subagent.*` events, `subagent.list` and `subagent.tail` (`src/hermes/transport.ts:3782`, `:3804`), with Steer and Stop. It uses no `spawn_tree.*` method.

For a run the app didn't watch, the subagent lanes can come from the stored `delegate_task` rows above. They give each child's status, length, tokens and cost, but no per-step times inside the child.

### `session.usage`

The method (`methods_session.py:1443`) and the event (`server.py:1897`) send the same `Usage` counters: `input`, `output`, `reasoning`, `prompt`, `completion`, `total`, `calls`, `cache_read`, `cache_write`, `compressions`, context fields, `avg_latency_s` and `avg_tps` (`server.py:1289`). They are the live agent's running totals for the chat. They are not per turn or per message. `message.complete` carries the same counters as the final word for the turn (`events.py:354`). The app already works out a turn's usage by subtracting the counters at its start from those at its end (`src/hermes/transport.ts:4063`). The method needs the chat live and adds `credits_lines` for Nous accounts.

### From a cron run or a Work card to its chat

`GET /api/cron/jobs/{job_id}/runs?profile=&limit=` lists a job's runs, newest first, up to 100 (`hermes_cli/web_routers/cron.py:744`, `:516`). An agent run is a stored session row, and its `id` is the run's session id (`cron.py:486`). A script-only run has a made-up `cron_output:` id and no chat. The app already reads this and keeps `sessionId` (`src/hermes/cronJobs.ts:430`).

A task event names a Work card run's chat. When the profile's owner admits a run, it writes an `owner_admitted` event scoped to that run, with `session_id` in its payload (`gateway/session_kanban.py:127`). `GET /api/plugins/kanban/tasks/{task_id}` returns every event with its `run_id` and payload (`plugins/kanban/dashboard/plugin_api.py:402`). No other field names the chat. A card's `session_id` is the chat whose reply created the card (`hermes_cli/kanban_db.py:636`), and a run row has no session id (`kanban_db.py:681`). The worker's own chat is a new session tagged `kanban` (`hermes_cli/kanban_db_dispatch.py:2815`). The worker also prints `Session: <id>` to the card's log (`hermes_cli/kanban_worker_client.py:136`), which `GET /api/plugins/kanban/tasks/{task_id}/log` returns (`plugin_api.py:1255`). The log is one file per card, kept to 2 MiB plus one older file, so an early run's line can be gone. The Run view uses the event.

### Branch at a step

`session.branch {session_id, count, idempotency_key, name?}` needs the chat live (`methods_session.py:2184`). Hermes first keeps only the user and assistant rows that have visible text (`tui_gateway/methods_session_branch.py:21`). `count` then keeps the first `count` of those (`methods_session_branch.py:108`). The copy holds each row's role, content, reasoning, display fields and time, and nothing else (`methods_session.py:260`, `methods_session_branch.py:58`). Tool rows and `tool_calls` are not copied.

So a branch can start at any visible user or assistant message. It can't start between two tool calls of one reply, and a reply made only of tool calls has no place in the count. **Branch from here** on a tool step must start at the visible message before it and say the tool results don't come along. The same is true at all three commits.

### Traces that already exist

None holds a full run with step times and costs.

- `GET /api/sessions/{session_id}/export` streams the session row and every message row, rewound and compacted ones too (`sessions.py:945`). It holds no more step detail than the messages route.
- `session.save` writes the transcript to a file under `~/.hermes/sessions/saved` (`tui_gateway/contracts/sessions.py:474`). It has the same rows.
- Trajectory files are written only when `run_agent.py` is run with `--save_trajectories` (`run_agent.py:1505`). No dashboard, gateway or cron path sets it (searched `tui_gateway/`, `gateway/`, `cron/` and `hermes_cli/` for `save_trajectories`).
- `monitoring.export.otlp` sends OpenTelemetry spans, off by default (`hermes_cli/config_defaults.py:2083`). It carries only gateway health, diagnostics and cron outcomes, with no prompts, tools or model calls (`agent/monitoring/events.py:1`).
- Langfuse tracing left core for a catalog plugin (`hermes_cli/left_core_migration.py:471`). Its code isn't in these trees, so I can't say what it records.

The plugin hooks carry exactly what a trace needs. Hermes stores none of it.

- `post_api_request` fires once per model call with `turn_id`, `api_request_id`, `started_at`, `ended_at`, `api_duration`, `first_chunk_at`, `finish_reason`, `model` and token `usage` (`agent/turn_response_intake.py:77`). It has tokens but no cost (`agent/api_request_hooks.py:35`). `api_request_error` fires for a failed call with the same times plus `retry_count`, `retryable` and `reason` (`api_request_hooks.py:177`).
- `post_tool_call` fires once per tool call with `tool_call_id`, `turn_id`, `api_request_id`, `duration_ms`, `status`, `error_type` and `error_message` (`model_tools.py:705`).
- `subagent_stop` fires per child with `child_session_id`, `parent_turn_id`, `child_status` and `duration_ms` (`tools/delegate_tool_results.py:382`).
- `post_approval_response` and `post_compaction` exist too (`hermes_cli/plugins.py:147`, `:203`).
- A plugin's dashboard API mounts at `/api/plugins/<name>/` (`hermes_cli/web_server_dashboard.py:1136`), as the kanban plugin does.

### Where the research was wrong or incomplete

- Fable said stored tool rows have "stored times". Each row has one time, taken when the step ended, and no duration (`agent/tool_dispatch_helpers.py:464`).
- Fable and the combined idea name `spawn_tree.list` for runs the app didn't watch. Hermes never saves a tree. Only the Ink terminal UI does (`ui-tui/src/app/createGatewayEventHandler.ts:879`), so the list is empty for the owner's chats.
- Fable said `spawn_tree.save` could be called "after a run". That holds, but it is then the app's own record, not Hermes's.
- The combined idea and Fable say Hermes stores no per-step timing or cost. That is true for rows. They missed that `tool.complete` sends a measured `duration_s` live (`tui_gateway/tool_progress.py:345`), and that the stored `delegate_task` row holds each child's measured length, tokens and cost (`tools/delegate_tool_child_run.py:657`).
- Grok said cost and tokens for each turn "sit on the row, from Hermes's own figures". No row has tokens or cost. `token_count` is never set, and cost is per chat on the session row.
- Grok said a fork that keeps tool outputs "may be a branch flag Hermes does not have". Confirmed. `session.branch` takes only `name`, `count` and `idempotency_key` (`tui_gateway/contracts/sessions.py:403`) and drops tool rows (`methods_session.py:260`).
- Grok's `verification.status` lead holds. It is read-only and takes `session_id` or `cwd` (`methods_session.py:592`).
- Fable named `GET runs/{id}` and `GET tasks/{id}/log` for Work cards. Both exist. The run row has no session id, and the log's `Session:` line can be rotated away. The link that lasts is the run's `owner_admitted` event in `GET tasks/{id}` (`gateway/session_kanban.py:127`).
- The combined idea lists `approval.*` events. Since desktop contract 7, an Approval is a server request, not an event (`tui_gateway/server.py:1384`). The only `approval.*` event is `approval.cancelled`.
- Fable listed `tool.output_risk` and `tool.progress` as always sent. Both stop when `display.tool_progress` is `off` (`tui_gateway/tool_progress.py:388`, `:394`).
- Fable proposed an export Langfuse or OpenTelemetry tools can read. Astra was right that Hermes's own OpenTelemetry export is content-free (`agent/monitoring/events.py:1`). It can't serve as a run trace.
- Fable's plugin on the observer hooks is the right size. The hooks carry per-call start and end times and per-tool durations and status (`agent/turn_response_intake.py:77`, `model_tools.py:705`).
- Astra's rehearsal with recorded tool responses has nothing in source to build on.
- None of the research says that no event carries a server time, that the subagent cost is dropped on the wire, that a tool failure has no flag, that retries that recover leave no trace, or that `bf0203a` lacks `turn_id` and `subagent.roster`.

### On the owner's server

Everything the first version needs is the same on `bf0203a` and `f0d9488` as on `b200f5bc`. That covers every event, the messages, session and export routes, the cron runs route, the kanban routes, `session.branch`, `spawn_tree.*` and the hooks. Two things differ at `bf0203a`.

- `message.start`, `message.delta` and `message.interim` carry no `turn_id` (`tui_gateway/contracts/events.py:147` there, and no `stream_segments.py`). The recorder must pair a turn's events by order on the session, which works at all three.
- `subagent.roster` is missing. The recorder doesn't need it. The app already copes without it (`src/hermes/transport.ts:866`).

The feature must hide or explain these cases on any of the three:

- Tool steps are missing when `display.tool_progress` is `off`. Read `display.tool_progress` from `GET /api/config?profile=` and say so on the Run view.
- Costs are per chat. A turn's cost is inferred from two session reads, and a step's cost isn't shown.
- A Work card's run opens its chat through the run's `owner_admitted` event in `GET tasks/{task_id}`. A run with no such event has no chat to open, and the Run view says so.

No probe is needed to tell `bf0203a` from the other two. The first `message.start` the app receives says it, passively. `turn_id` present means `b200f5bc` or `f0d9488`. Absent means `bf0203a`.

### What Hermes would need

The first version needs no Hermes change. These would make stored runs exact instead of inferred. File them as issues.

- A trace plugin, not a core change. It records each `post_api_request`, `api_request_error`, `post_tool_call`, `subagent_stop`, `post_approval_response` and `post_compaction` call to `<home>/traces/<session_id>.jsonl`. It serves `GET /api/plugins/flight-recorder/sessions/{session_id}/trace?after_seq=&limit=`. The result is `{session_id, steps: [{seq, kind, turn_id, api_request_id, tool_call_id, name, started_at, ended_at, duration_ms, usage, cost_usd, status, error_type, error_message, child_session_id}], next_seq}`. The hooks carry tokens, not cost, so the plugin must price each call itself.
- `session_id` on the run row, returned on `GET /api/plugins/kanban/runs/{run_id}` and in the runs of `GET /api/plugins/kanban/tasks/{task_id}`, so the Run view doesn't have to read a card's whole event list to find one run's chat.
- `cost_usd` and `failure_reason` added to `_SUBAGENT_FIELDS`, so `subagent.complete` sends what the child already built (`tui_gateway/tool_progress.py:460`).
- `status` and `error_type` on `tool.complete`, from the same check `post_tool_call` uses (`model_tools.py:703`).
- A server time `ts` on every event frame, kept in the replay ring, so a replayed step keeps its time (`tui_gateway/server.py:589`).

### Open questions

- Does `spawn_tree.*` on a dashboard that serves several profiles read and write the profile named in `profile`, or the launch profile? The handler calls `get_hermes_home()` and ignores `profile` (`tui_gateway/server.py:1826`). Check on a throwaway Hermes. Save a tree with `profile: b`, then list it with `profile: a` and `profile: b`.
- Does `GET /api/sessions/{id}?profile=<the run's profile>` find the session that an `owner_admitted` event names? The event's `db` field names the owner's store, which may not be the profile's `state.db`. Check on a throwaway Hermes. Run one card, read the event from `GET /api/plugins/kanban/tasks/{task_id}`, then read that session and its messages.
- With `dashboard.turn_isolation` on, `tool.complete` `duration_s` is measured in the child process. Source doesn't settle whether the parent relays it unchanged. Check on a throwaway Hermes with turn isolation by comparing `duration_s` with the tool's own sleep.
- Is `session.usage` sent when a turn runs in a turn-isolation child? `_session_usage_snapshot` reads the child's mirror there (`tui_gateway/server.py:1389`). Check on a throwaway Hermes with turn isolation whether `session.usage` ticks arrive during a turn.

## Standing missions that run until proven done

The feature asks Hermes for four things. It must set a goal with a check that proves it done, read and change the goal, loop and heartbeat of a chat, tell the app when they change, and list them for chats the app doesn't have open. The first three are the same at `b200f5bc`, `bf0203a` and `f0d9488`, and they answer on the legacy `/api/ws` the app speaks today. The fourth exists at none of them.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `session.control.read` | `tui_gateway/methods_session_control.py:255` | Yes, same | Yes, same | A chat live in the dashboard process | `v2026.9.7` (2026-09-07) |
| `session.control` | `tui_gateway/methods_session_control.py:272` | Yes, same | Yes, same | A chat live in the dashboard process | `v2026.9.7` (2026-09-07) |
| `session.control.update` | `tui_gateway/contracts/events.py:582` | Yes, same (line 570) | Yes, same | A client attached to the chat | `v2026.9.14` (2026-09-14) |
| `command.dispatch` | `tui_gateway/methods_tools.py:1007` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `/goal` through `command.dispatch` | `tui_gateway/methods_tools.py:800` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `/goal` grammar | `hermes_cli/goal_command.py:182` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Inline goal contract fields | `hermes_cli/goals.py:312` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01) |
| `/goal gate add` | `hermes_cli/goal_command.py:118` | Yes, same | Yes, same | A goal set | `v2026.9.7` (2026-09-07) |
| Gate runner | `hermes_cli/goals.py:396` | Yes, same | Yes, same | A goal with gates | `v2026.8.13` (2026-08-13) |
| Gate timeout and retries | `hermes_cli/goals.py:51` | Yes, same | Yes, same | None | `v2026.8.13` (2026-08-13) |
| Goal judge | `hermes_cli/goals.py:894` | Yes, same | Yes, same | A reachable judge model | `v2026.5.7` (2026-05-07) |
| Goal evaluation after a turn | `hermes_cli/goals.py:1484` | Yes, same | Yes, same | An active goal | `v2026.5.7` (2026-05-07) |
| `auxiliary.goal_judge` | `hermes_cli/config_defaults.py:783` | Yes, same (line 810) | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `goals.max_turns` | `hermes_cli/config_defaults.py:1389` | Yes, same (line 1416) | Yes, same | None. Default 20 | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `loops` config | `hermes_cli/config_defaults.py:1397` | Yes, same (line 1424) | Yes, same | None | `v2026.8.16` (2026-08-16) |
| Goal state row `goal:<id>` | `hermes_cli/goals.py:502` | Yes, same | Yes, same | None | `v2026.5.7` (2026-05-07) |
| Loop state row `loop:<id>` | `hermes_cli/loops.py:236` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16) |
| Heartbeat state row `heartbeat:<id>` | `hermes_cli/heartbeat.py:103` | Yes, same contract (line 102) | Yes, same | None | `v2026.9.21` (2026-09-21) |
| `/loop` through `command.dispatch` | `tui_gateway/methods_tools.py:826` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `/heartbeat` through `slash.exec` | `hermes_cli/cli_commands_mixin.py:1608` | Yes, same (line 1627) | Yes, same | A live chat and its slash worker | `v2026.8.13` (2026-08-13) |
| `/subgoal` through `slash.exec` | `hermes_cli/cli_commands_mixin.py:1746` | Yes, same (line 1765) | Yes, same | A live chat with a goal | `v2026.5.16` (2026-05-16), in another file until `v2026.6.19` |
| `slash.exec` | `tui_gateway/methods_tools.py:1027` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `commands.catalog` entry for `/goal` | `hermes_cli/commands.py:149` | Yes, same | Yes, same | None | `v2026.5.7` (2026-05-07) |
| Dashboard loop driver | `tui_gateway/session_notifications.py:376` | Yes, same (line 347) | Yes, same | A chat live in the dashboard | `v2026.8.16` (2026-08-16), in another file until `v2026.9.7` |
| Dashboard heartbeat driver | `tui_gateway/session_notifications.py:287` | Yes, same (line 258) | Yes, same | A chat live in the dashboard | `v2026.9.7` (2026-09-07) |
| Clientless chat kept for a loop or heartbeat | `tui_gateway/session_notifications.py:332` | Yes, same (line 303) | Yes, same | None | `v0.21.7` (2026-10-12) |
| `HERMES_TUI_WS_ORPHAN_REAP_GRACE_S` | `tui_gateway/server.py:149` | Yes, same (line 143) | Yes, same | None. Default 20 s | `v2026.6.5` (2026-06-05) |
| Gateway goal continuation | `gateway/run_goals.py:302` | Yes, same (line 295) | Yes, same | `hermes gateway` running, a messaging chat | `v2026.5.16` (2026-05-16), in another file until `v2026.9.7` |
| Gateway loop watcher | `gateway/run_goals.py:531` | Yes, same (line 524) | Yes, same | `hermes gateway` running | `v2026.8.16` (2026-08-16), in another file until `v2026.9.7` |
| Gateway heartbeat restore | `gateway/run_heartbeat_restore.py:22` | Yes, same | Yes, same | `hermes gateway` running | `v2026.9.7` (2026-09-07) |
| `session.interrupt` | `tui_gateway/methods_session_interrupt.py:70` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v0.21.6` |
| `delegation.pause` | `tui_gateway/methods_session.py:2204` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `delegation.status` | `tui_gateway/methods_session.py:2196` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.active_list` | `tui_gateway/methods_session.py:1138` | Yes, same (line 1143) | Yes, same | None | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| `session.resume` | `tui_gateway/methods_session.py:1044` | Yes, same (line 1049) | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `status.update` kind `goal` | `tui_gateway/prompt_turn.py:377` | Yes, same (line 375) | Yes, same | A client attached to the chat | `v2026.9.7` (2026-09-07) |
| `hermes pause` | `hermes_cli/subcommands/pause.py:47` | Yes, same | Yes, same | A shell on the server | `v2026.9.7` (2026-09-07) |
| `ESTOP` sentinel | `agent/estop.py:24` | Yes, same | Yes, same | None | `v2026.8.13` (2026-08-13) |
| `session.control` (canonical) | `gateway/session_controls.py:277` | Yes, same (line 232) | Yes, same | Canonical gateway protocol only | `v0.22.3` (2026-10-21) |
| `session.control.read` (canonical) | `gateway/session_ancillary.py:26` | Yes, same | Yes, same | Canonical gateway protocol only | `v0.22.3` (2026-10-21) |
| `GET /api/sessions/control` | Absent | Absent | Absent | Not in Hermes | Not in Hermes |

### The methods, as the app would call them

`session.control.read` and `session.control` answer on the dashboard's legacy `/api/ws`. The module registers both with `@method` (`tui_gateway/methods_session_control.py:255`, `:272`), and `tui_gateway/server.py:2037` installs it on `server.dispatch`, which a dashboard with no session authority uses for every request (`tui_gateway/ws.py:387`). The canonical gateway answers the same names through its own handlers (`gateway/session_controls.py:277`, `gateway/session_ancillary.py:26`). The file is identical at all three commits, and so are its contracts.

`session.control.read` takes `session_id` and an optional `profile`. It answers `{control}`, where `control` is `{goal, loop, heartbeat, revision, updated_at}` (`methods_session_control.py:154`). Each part is `null` when there is none or it was cleared.

- `goal` has `title`, `status` (`active`, `paused` or `done`), `turns_used`, `max_turns`, `contract` (`outcome`, `verification`, `constraints`, `boundaries`, `stop_when`), `subgoals` (a list of strings), and `gates`. Each gate has `command`, `timeout_seconds`, `max_retries`, `attempts` and `last_exit_code` (`:49`). It may add `created_at`, `updated_at`, `paused_reason`, `last_verdict`, `last_reason`, and `wait_barrier` as `{type: until, until_at}` or `{type: session|pid, target}` with a `reason` (`:86`).
- `loop` has `prompt`, `status`, `mode` (fixed or self-paced), `interval_seconds`, `current_delay`, `times`, `until`, `max_ticks`, `ticks_fired`, `created_at`, `last_fired_at`, `next_due_at`, `awaiting_response` and `deferred_by_goal`, and may add `paused_reason` and `last_stop_reason` (`:98`).
- `heartbeat` has `prompt`, `status`, `interval_seconds`, `created_at`, `last_fired_at` and `fire_count` (`:125`). It has no next-due time. The app works it out as Hermes does, as `(last_fired_at || created_at) + interval_seconds` (`hermes_cli/heartbeat.py:180`), because `last_fired_at` is 0 until the first tick. A paused heartbeat shows no countdown.
- `revision` is a SHA-256 of the visible state, or `""` when all three are empty (`:163`). Two equal reads have equal revisions.

Errors are 4001 for a chat that isn't live in the dashboard process or has no stored key, and 5031 when the read fails.

`session.control` takes `session_id`, `action`, an optional `args` object, and an optional `profile`. There are 13 actions (`methods_session_control.py:27`):

- `goal.pause`, `goal.resume`, `goal.clear`, `goal.unwait`.
- `loop.pause`, `loop.resume`, `loop.stop`. There is no `loop.clear`; `loop.stop` clears it.
- `subgoal.add` with `args.text`, `subgoal.remove` with a 1-based integer `args.index`, `subgoal.clear`.
- `heartbeat.pause`, `heartbeat.resume`, `heartbeat.clear`. There is no `heartbeat.stop`.

It answers `{control, dispatch}`. `control` is the snapshot after the action. `dispatch` is `{type, output, notice, message, display}`, the text the command would have shown (`:407`). Errors are 4004 for a missing, unknown or gate action (`:278` to `:282`), for bad `args`, and for a manager refusal such as "no active goal". They are also 4001 for a chat that isn't live, and 5031. The goal and loop actions run the `/goal` and `/loop` command handlers through `command.dispatch` (`:343`). So a quick, plugin or skill command named `goal` or `loop` replaces them too, because `command.dispatch` tries those first (`tui_gateway/methods_tools.py:1016`).

`goal.resume` doesn't start a turn. It answers `dispatch.type: "send"` with the continuation prompt in `dispatch.message` (`methods_tools.py:819`). The client must send that message as the chat's next turn, or the goal waits for the next one the owner sends. Resume also resets `turns_used` to 0 (`hermes_cli/goals.py:1198`).

`session.control.update` carries `{control}` with the same shape (`tui_gateway/contracts/events.py:578`). Hermes sends it after each control action, after each `/goal`, `/loop`, `/heartbeat` or `/subgoal` command (`methods_tools.py:1021`, `:1096`), after the post-turn judge when any state exists (`tui_gateway/prompt_turn.py:1199`), and after a tool call that changed the revision (`tui_gateway/tool_progress.py:377`). The judge runs after `message.complete`, so an update keyed on that event would show the turn count from before the judge (`methods_session_control.py:235`).

### Answers to the open questions

**1. `session.control.read`, `session.control`, `session.control.update`.** All three exist at all three commits, identical, and answer on the legacy `/api/ws` as above. They also answer on the canonical protocol. Params, actions, results and errors are listed above.

**2. Setting a goal.** The app sends slash commands from `src/hermes/commands.ts:142`. `/steer` goes through `command.dispatch {name, arg, session_id}` and `/context` through `slash.exec`. Only names in its registry go to Hermes (ADR 0015). `/goal` goes the same way as `/steer`. `command.dispatch {name: "goal", arg, session_id}` reaches `_cmd_goal` (`tui_gateway/methods_tools.py:800`). `slash.exec "/goal …"` ends up there too (`tui_gateway/server.py:1960`). The grammar is in `hermes_cli/goal_command.py:182`:

- `/goal <text>` sets the goal. It replaces any goal already set. `/goal -- <text>` sets a goal that starts with a control word. `/goal draft <text>` asks the judge model to write the contract.
- The goal text may hold lines of the form `field: value` (`hermes_cli/goals.py:312`, aliases at `:273`). `outcome:` or `done when:` is the outcome. `verify:`, `verification:` or `proof:` is how to prove it. `must not:`, `do not change:`, `preserve:` or `constraints:` is what must not change. `scope:`, `files:` or `boundaries:` is what is in bounds. `stop when:` or `blocked:` is when to stop and ask. Any other line joins the title. These fields are text for the judge. Hermes runs none of them and enforces none of them.
- `/goal gate add <command>` adds a check. The rest of the line is the command, kept as typed (`goal_command.py:118`). `/goal gate`, `/goal gate remove N` and `/goal gate clear` list and remove gates. A gate can be added only after the goal is set, so setting a goal with a check is two calls. `session.control` refuses every `goal.gate…` action with 4004.
- There is no per-goal turn budget. `_cmd_goal` reads the profile's `goals.max_turns` (default 20, `hermes_cli/config_defaults.py:1392`) and copies it into the goal when it is set (`methods_tools.py:806`). No route writes that one key, and ADR 0121 rules out writing the whole config to change it.
- Status, pause, resume, clear, `wait <pid> [reason]` and `unwait` are the other verbs (`goal_command.py:98`).

Setting a goal answers `{type: "send", notice, message}` (`methods_tools.py:819`). The app must send `message` as the next turn, as `runServerCommand` already does for a `send` answer (`src/hermes/commands.ts:150`). Nothing runs until it does.

**The gate.** A gate is a shell command. `run_gate` runs it with `subprocess.run(shell=True)` inside the Hermes process that owns the chat, which is the dashboard for the app's chats (`hermes_cli/goals.py:396`). It runs as that process's OS user, with that process's environment, on the host. It doesn't use the chat's terminal backend, so a container terminal doesn't contain it. It runs in the chat's workspace folder, and when that folder isn't a directory on the host, Hermes pauses the goal instead of running it (`goals.py:374`, `:1319`). The timeout is 300 seconds and a timeout counts as exit code -1 (`goals.py:51`, `:410`). There is no approval. The dashboard passes `authorize_gate=lambda: None` (`methods_tools.py:812`), and Hermes's own comment says gates "run shell commands without a later approval" (`goal_command.py:126`). The 300-second timeout and the 3 retries can't be changed from `/goal`. The snapshot keeps `command` exactly as stored, so the app can read it back after saving.

**3. Who decides a goal is done.** Both, in order. After each turn, `evaluate_after_turn` counts the turn and then runs every gate (`goals.py:1484`, `:1505`). If a gate fails, the judge isn't asked. The gate's output becomes the next turn's prompt, and its `attempts` goes up. On the fourth failure in a row (`max_retries` is 3) the goal pauses with a `paused_reason` naming the command (`goals.py:1336`). Only when every gate exits 0 does the judge model run (`auxiliary.goal_judge`, `goals.py:894`). It answers done, continue, blocked or wait. Done marks the goal done. Blocked pauses it. Wait parks it on a process, a session or a timer without spending a turn. A judge error counts as continue, and five transport errors or three unreadable replies in a row pause the goal (`goals.py:1546`). A goal with no gates is decided by the judge alone. The turn budget pauses the goal either way (`goals.py:1561`).

Everything the bar needs lives in the goal's state row (`hermes_cli/goals.py:420`) and reaches the client in `session.control.read` and `session.control.update`. That covers each gate's `last_exit_code` and `attempts`, the subgoals, `turns_used` and `max_turns`, and `last_verdict` and `last_reason`. Each gate's output tail is stored as `last_output_tail` but left out of the snapshot (`methods_session_control.py:61`). It reaches the chat only as the next turn's prompt. The verdict line of each turn also arrives as `status.update {kind: "goal", text}` (`tui_gateway/prompt_turn.py:377`).

**4. Where state lives, and what happens with no client.** Goals, loops and heartbeats are rows in the profile's `state.db` `state_meta` table, keyed `goal:<session key>`, `loop:<session key>` and `heartbeat:<session key>` (`hermes_cli/goals.py:502`, `hermes_cli/loops.py:236`, `hermes_cli/heartbeat.py:103`). They survive a restart. Clearing keeps the row with status `cleared`.

In the dashboard process, nothing runs on a timer. A goal moves only at the end of a turn of a chat that is live there (`tui_gateway/prompt_turn.py:364`), and the next turn starts at once (`:453`). Loops and heartbeats fire from the chat's notification poller, only for chats live in that process (`tui_gateway/session_notifications.py:376`, `:287`). When the app disconnects, the dashboard keeps a chat for 20 seconds (`tui_gateway/server.py:149`), and then:

- A chat with an active loop or heartbeat, a background process that will report back, or live subagents stays live (`tui_gateway/session_lifecycle.py:1013`). Its loop and heartbeat keep firing with the app closed.
- A chat in the middle of a turn that is still producing output keeps running (`session_lifecycle.py:1024`). A goal chains turns this way and can reach done with the app closed.
- An idle chat with only a goal is closed (`session_lifecycle.py:1022`). That includes a goal parked on a wait barrier. The goal stays active in `state.db`, but nothing moves it until a client resumes the chat and a turn runs.

After a dashboard restart, no chat is live. The dashboard doesn't scan `state.db` for loops or heartbeats at start (the survey searched for callers of `list_active_loops` and `store_has_active_heartbeat`, and only `gateway/` calls them). The gateway's loop watcher skips loops with no messaging route, which is every loop set from the app (`gateway/run_goals.py:455`). So a loop, heartbeat or goal in an app chat sleeps until the chat is resumed.

In the gateway process, goals in messaging chats move after each turn with no client at all (`gateway/run_goals.py:302`). Loops are found by a 15-second scan of every profile's rows, which survives a restart (`run_goals.py:531`). Heartbeats are restored from the gateway's routing index (`gateway/run_heartbeat_restore.py:22`).

**5. Reads for chats that aren't open.** None list goals, loops or heartbeats across chats or profiles. The survey searched all three trees for routes and `@method` registrations naming goal, loop, heartbeat or control, and for callers of `list_meta_prefix`, `list_active_loops` and `store_has_active_heartbeat`. The only callers are the gateway's own watchers. `session.control.read` needs the chat live in the process (`_sess_nowait`, `tui_gateway/session_registry.py:304`). There is one partial read, though. `session.active_list` lists every chat live in the dashboard process with its runtime id, including chats another client opened (`tui_gateway/methods_session.py:1138`). `session.control.read` accepts any of those ids. So the app can read goals in every live chat on a server, not only the ones it opened. It can't read chats that aren't live, or chats live in the gateway process. The route the feature needs is in "What Hermes would need".

**6. Loops and heartbeats.** A loop re-runs a prompt in the chat on a cadence (`hermes_cli/loops.py:1`). It is started with `/loop [every] [interval] <prompt> [--times N] [--until <condition>]` through `command.dispatch` (`tui_gateway/methods_tools.py:826`, grammar at `loops.py:84`). With no interval it paces itself, starting at 60 seconds and backing off to 15 minutes while replies don't change. It stops on its own when the bot replies `LOOP_COMPLETE` on a line, after `--times`, when the `--until` judge says so, or at `loops.max_ticks` (100). An active goal defers it (`loops.py:613`). It is listed by `/loop status` or the snapshot, and stopped by `/loop stop` or `loop.stop`.

A heartbeat is one recurring instruction per chat that fires only into an idle chat, at least 60 seconds apart (`hermes_cli/heartbeat.py:1`, `:20`). It is started with `/heartbeat every <interval> <prompt>`. That isn't a `command.dispatch` command. `slash.exec` runs it in the chat's slash worker (`hermes_cli/cli_commands_mixin.py:1608`), and the dashboard's poller fires it (`tui_gateway/session_notifications.py:287`). It is listed by `/heartbeat status` or the snapshot, and stopped by `/heartbeat clear` or `heartbeat.clear`.

A goal differs from both. It has no cadence. It runs turn after turn until gates and judge agree it is done, or the budget or a failure pauses it. A loop or heartbeat runs on a clock and has no judge of done, except a loop's `--until`.

**7. Stopping.** `session.interrupt` stops the running turn only (`tui_gateway/methods_session_interrupt.py:70`). The goal stays active. No continuation follows the stopped turn, and the goal carries on after the owner's next message (`tui_gateway/prompt_turn.py:458`). Loops and heartbeats keep firing. `delegation.pause {paused}` blocks new subagents for the whole dashboard process and answers `{paused}` (`tui_gateway/methods_session.py:2204`). It is held in memory, so a restart clears it (`tools/delegate_tool_registry.py:16`). It doesn't touch goals, loops or heartbeats. `delegation.status` reads it back.

The one server-wide brake is `hermes pause`, a CLI command that writes `$HERMES_HOME/ESTOP` (`hermes_cli/subcommands/pause.py:47`, `agent/estop.py:24`). Cron, kanban, new gateway turns and the gateway's loop and heartbeat ticks skip work while it exists (`gateway/run_goals.py:167`, `:492`). The dashboard never checks it. `estop` appears nowhere under `tui_gateway/` or `hermes_cli/web_routers/` at any commit. No route or method sets it. So **Stop all** on the owner's server is one `session.control` call per goal, loop and heartbeat in each live chat, plus `session.interrupt` for a running turn.

**8. The owner's server.** `bf0203a` and `f0d9488` answer every call above as `b200f5bc` does. `methods_session_control.py`, `goals.py`, `goal_command.py` and `loops.py` are byte-identical across the three, and so are the `session.control` contracts and the `/goal` and `/loop` handlers. The one difference in source is inside Hermes and doesn't change what a client sees. At `bf0203a`, `heartbeat.py` has no compare-and-set when a driver claims a tick (`hermes_cli/heartbeat.py:226` at `b200f5bc`), so two drivers of one chat could both fire the same tick. `f0d9488` has the fix.

### Where the research was wrong or incomplete

- The combined idea says a goal "keeps working, even with the app closed". On the dashboard, that holds only while turns chain or a loop or heartbeat keeps the chat live. An idle chat with only a goal closes 20 seconds after the app does, and after a dashboard restart nothing resumes app chats' goals, loops or heartbeats until the chat is resumed.
- The brief and combined idea describe the check as "a shell command that must exit 0". Exit 0 isn't enough to finish. The judge model must also say done after the gates pass (`goals.py:1505`). A failing gate doesn't keep the goal running forever either. The fourth failure in a row pauses it.
- The brief and the combined idea put "a turn budget" in **Set a goal**. Hermes has no per-goal budget. It takes the profile's `goals.max_turns` when the goal is set.
- The brief and combined idea list "what must not change". Hermes takes it as a `must not:` line in the goal text, which only the judge reads. Nothing enforces it.
- No research says where a gate runs. It runs in the dashboard process as its OS user, with its environment, on the host, with no approval and outside any container terminal (`goals.py:396`, `methods_tools.py:812`). The app's "show the exact command before saving" is the only check.
- Grok said "loop or heartbeat pause and stop". Heartbeats take `clear`, not `stop`. Loops take `stop`, not `clear`. Grok and Fable both got the 4004 for gate actions right.
- Fable said `/goal`, `/loop` and `/heartbeat` all go through `command.dispatch` or `slash.exec`. `/goal` and `/loop` are `command.dispatch` built-ins, but `/heartbeat` and `/subgoal` exist only in the slash worker, through `slash.exec` (`methods_tools.py:1000`).
- No research says that `/goal` and `goal.resume` answer `type: "send"` and start nothing until the client sends the message.
- No research says that a quick or plugin command named `goal` or `loop` takes over both the slash command and the `session.control` goal and loop actions (`methods_tools.py:1016`). The app must treat `/goal` as replaceable, as it treats `/steer`.
- Grok and Fable said a fleet list of goals needs Hermes. That is right for chats that aren't live. They missed that `session.active_list` plus `session.control.read` already reads every chat live in the dashboard process, including chats other clients opened.
- The brief asks for **Stop all** to pause every loop. No single call does it. `delegation.pause` only stops new subagents. `hermes pause` is CLI only and the dashboard ignores it.
- Fable's "Pause all is several calls to several servers and can half succeed; it must report per item" holds, and source adds that a paused goal resumes with its budget reset to 0.
- Astra's "standing watchers" need a Hermes watcher plugin with persisted observations, incidents and post-action checks. None of that exists at any commit. Astra is right that heartbeats are tied to a running process (`hermes_cli/heartbeat.py:3`).
- The research missed the `status.update` kind `goal` line after each turn, and the canonical handlers (`gateway/session_controls.py:277`), which the app can't use yet (ADR 0174).

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as on `b200f5bc`. The feature has nothing to hide for lack of a method on the dashboard's `/api/ws`. It must hide or explain these cases:

- The cross-chat page can show goals, loops and heartbeats only for chats live in a dashboard process. It reads them from `session.active_list` plus `session.control.read` per chat. It must say that chats that aren't live, and messaging chats in the gateway process, aren't shown.
- **Stop all** pauses each goal, loop and heartbeat in each live chat one call at a time, interrupts running turns, and reports each result. It can't reach chats that aren't live without resuming them first.
- The budget field shows the profile's `goals.max_turns` read-only, since Hermes takes no budget per goal.
- A quick or plugin command named `goal` or `loop` replaces Hermes's. The app hides **Set a goal** when `commands.catalog` says so, as it does for `/steer`.
- The app is signed in to a gateway's canonical address. The app refuses that protocol today (ADR 0174).

The probe is one call that changes nothing. Send `session.control.read` with `__hermes_chat_probe__` as `session_id`. "Session not found" (4001) means Hermes has the method. "Method not found" (-32601) means it doesn't. Pair it with the existing `commands.catalog` read, where `canon["/goal"] === "/goal"` and no quick or plugin command named `goal` means `/goal` is Hermes's own.

### What Hermes would need

The first PR needs no Hermes change. The cross-chat page and a full **Stop all** need the first item. File all of them as issues.

- `GET /api/sessions/control?profile=<name>&include=goal,loop,heartbeat` returning `{sessions: [{session_id, title, source, live, control}]}`, where `control` is the same snapshot as `session.control.read`. It would read the profile's `goal:`, `loop:` and `heartbeat:` rows whose status isn't `cleared`, live or not.
- `POST /api/sessions/{session_id}/control {action, args, profile}` taking the same 13 actions for a stored chat that isn't live, answering `{control}`.
- A server-wide pause the dashboard honours, as `POST /api/ops/pause {reason}` and `POST /api/ops/resume`, answering `{paused, reason, engaged_at}`, with a read at `GET /api/ops/pause`. It would set `ESTOP`, and the dashboard's goal continuation and loop and heartbeat drivers would check it as the gateway does.
- A per-goal budget, as `/goal --max-turns N <text>` or `session.control {action: "goal.set", args: {text, max_turns}}`, so the budget the owner sets is the budget the goal gets.
- A gate add with its timeout and retries, such as `/goal gate add --timeout <s> --retries <n> <command>`, plus the gate's `last_output_tail` in the snapshot, so the bar can show why a check failed.

### Open questions

- Can a dashboard chat with an active goal, between a finished turn and its continuation, be closed by the 20-second reaper while the app is away? Source suggests the continuation starts at once (`prompt_turn.py:453`), so the gap is short. Check on a throwaway Hermes. Set a goal with a gate that passes on the third turn, close the client, and read `goal:<key>` in `state.db` after a minute.
- Does anything in the dashboard start a turn when a goal's timed wait barrier ends? The survey found no code in `tui_gateway/` that reads `waiting_until` except the snapshot. Check on a throwaway Hermes. Make the judge return wait with `wait_for_seconds: 60`, keep the client attached and idle, and see whether a turn starts after 60 seconds.
- Does a heartbeat set through `slash.exec` survive the slash worker restarting? The poller reads the persisted row (`session_notifications.py:287`), so source suggests yes. Check on a throwaway Hermes by killing the worker process and waiting one interval.

## Mission control on the Work board

The feature asks four things of Hermes's kanban plugin. It must split a goal into linked cards the owner can edit before anything runs (4a), show and control each running worker (4b), record the owner's review verdict (4c), and create a card for another bot from a chat (4d). Every kanban route below is the same at `b200f5bc`, `bf0203a` and `f0d9488`. The plugin file `plugins/kanban/dashboard/plugin_api.py` is byte for byte the same at all three, and so are `hermes_cli/kanban_decompose.py`, `hermes_cli/kanban_specify.py`, `hermes_cli/kanban_db_graph.py` and `hermes_cli/kanban_workflow.py`. Source does show three gaps. Nothing holds decomposed cards until the owner says go. The owner's "send back with notes" has no verdict route. A card made over REST can't name the chat it came from.

Line numbers are at `b200f5bc`. Lines in `plugin_api.py` are the same at all three commits. The survey TSV has every line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| **Shared** | | | | | |
| `plugins.disabled` (kanban) | `hermes_cli/web_server_dashboard.py:857` | Yes, same | Yes, same | Bundled plugin, on unless disabled | `v2026.9.7` (2026-09-07) |
| `/api/plugins/<name>/` mount | `hermes_cli/web_server_dashboard.py:1245` | Yes, same | Yes, same | Dashboard sign-in | `v0.21.6` (2026-10-08) |
| Dashboard sign-in on `/api/*` | `hermes_cli/web_server.py:469` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `GET boards` | `plugin_api.py:1411` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET board` | `plugin_api.py:359` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET workflow` | `plugin_api.py:1625` | Yes, same | Yes, same | Dashboard sign-in | `v0.21.6` (2026-10-08) |
| `GET tasks/{id}` | `plugin_api.py:379` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `WS events` | `plugin_api.py:1802` | Yes, same | Yes, same | `?token=` or `?ticket=` | `v2026.5.7` (2026-05-07) |
| **4a Plan** | | | | | |
| `POST tasks` | `plugin_api.py:435` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `POST tasks/{id}/decompose` | `plugin_api.py:1602` | Yes, same | Yes, same | Task in triage; aux model set up | `v2026.5.28` (2026-05-28) |
| `POST tasks/{id}/specify` | `plugin_api.py:1025` | Yes, same | Yes, same | Task in triage; aux model set up | `v2026.5.16` (2026-05-16) |
| `POST estimate` | `plugin_api.py:1071` | Yes, same | Yes, same | Aux model set up | `v2026.8.3` (2026-08-03) |
| `POST tasks/{id}/estimate` | `plugin_api.py:1077` | Yes, same | Yes, same | Aux model set up | `v2026.8.3` (2026-08-03) |
| `POST links` | `plugin_api.py:817` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `DELETE links` | `plugin_api.py:824` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `PATCH tasks/{id}` | `plugin_api.py:692` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `POST tasks/bulk` | `plugin_api.py:858` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `DELETE tasks/{id}` | `plugin_api.py:719` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.28` (2026-05-28) |
| `GET assignees` | `plugin_api.py:1247` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET profiles` | `plugin_api.py:1553` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.28` (2026-05-28) |
| `GET model-options` | `plugin_api.py:1280` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `GET orchestration` | `plugin_api.py:1633` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.28` (2026-05-28) |
| `PUT orchestration` | `plugin_api.py:1675` | Yes, same | Yes, same | Dashboard sign-in; writes `config.yaml` | `v2026.5.28` (2026-05-28) |
| `POST dispatch` | `plugin_api.py:1269` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `kanban.auto_decompose` | `hermes_cli/config_defaults.py:1926` | Yes, same | Yes, same | None. Default `True` | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| `kanban.auto_promote_children` | `hermes_cli/kanban_decompose.py:215` | Yes, same | Yes, same | None. Default `True` in code | `v2026.9.7` (2026-09-07) |
| `kanban.dispatch_in_gateway` | `hermes_cli/config_defaults.py:1881` | Yes, same | Yes, same | None. Default `True` | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `kanban.dispatch_interval_seconds` | `hermes_cli/config_defaults.py:1886` | Yes, same | Yes, same | None. Default 60 | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `kanban.default_assignee` | `hermes_cli/config_defaults.py:1899` | Yes, same | Yes, same | None. Default empty | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| Decompose promotes its children | `hermes_cli/kanban_db_graph.py:164` | Yes, same | Yes, same | `auto_promote_children` | `v2026.5.28` (2026-05-28), in another file until `v2026.9.7` |
| Each dispatcher tick promotes todo cards | `hermes_cli/kanban_db_dispatch.py:2232` | Yes, same | Yes, same | A running dispatcher | `v2026.9.7` (2026-09-07) |
| `hermes kanban decompose` | `hermes_cli/kanban_parser.py:432` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| **4b Workers** | | | | | |
| `GET workers/active` | `plugin_api.py:920` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.28` (2026-05-28) |
| `GET runs/{id}` | `plugin_api.py:936` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.28` (2026-05-28) |
| `GET runs/{id}/inspect` | `plugin_api.py:943` | Yes, same | Yes, same | Dashboard sign-in; `psutil` on the host | `v2026.5.28` (2026-05-28) |
| `POST runs/{id}/terminate` | `plugin_api.py:985` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05) |
| `POST tasks/{id}/reclaim` | `plugin_api.py:1008` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `POST tasks/{id}/reassign` | `plugin_api.py:1039` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET tasks/{id}/log` | `plugin_api.py:1255` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET stats` | `plugin_api.py:1240` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `GET diagnostics` | `plugin_api.py:882` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `owner_admitted` event (run to chat session) | `gateway/session_kanban.py:127` | Yes, same | Yes, same | Read through `GET tasks/{id}` | `v0.22.3` (2026-10-21) |
| Worker log `Session:` line | `hermes_cli/kanban_worker_client.py:136` | Yes, same (line 74) | Yes, same | None | `v0.22.3` (2026-10-21) |
| `GET /api/sessions/{id}` | `hermes_cli/web_routers/sessions.py:560` | Yes, same | Yes, same | Dashboard sign-in; `?profile=` | `v2026.7.30` (2026-07-30) |
| **4c Review** | | | | | |
| Send back (`reopen_review_task`) | `hermes_cli/kanban_db.py:3601` | Yes, same | Yes, same | Through `PATCH tasks/{id}` | `v2026.8.13` (2026-08-13) |
| Accept (`complete_task` from review) | `hermes_cli/kanban_db.py:2640` | Yes, same | Yes, same | Through `PATCH tasks/{id}` | `v2026.5.7` (2026-05-07) |
| `POST tasks/{id}/comments` | `plugin_api.py:802` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07) |
| `request_changes` (verdict) | `hermes_cli/kanban_db.py:3408` | Yes, same | Yes, same | An active reviewer run. No REST route | `v2026.8.13` (2026-08-13) |
| `kanban_request_changes` tool | `tools/kanban_tools_schemas.py:273` | Yes, same | Yes, same | Worker only | `v2026.8.13` (2026-08-13), in another file until `v2026.9.7` |
| `hermes kanban request-changes` | `hermes_cli/kanban_parser.py:344` | Yes, same | Yes, same | An active reviewer run | `v2026.9.7` (2026-09-07) |
| `kanban.review_dispatch` | `hermes_cli/config_defaults.py:1884` | Yes, same | Yes, same | None. Default `True` | `v2026.8.13` (2026-08-13) |
| **4d Hand off** | | | | | |
| `tasks.session_id` | `hermes_cli/kanban_db.py:636` | Yes, same | Yes, same | Set only by `kanban_create` in a chat | `v2026.9.7` (2026-09-07) |
| `kanban.auto_subscribe_on_create` | `hermes_cli/config_defaults.py:1875` | Yes, same | Yes, same | `kanban_create` only | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| `a2a_call` tool | `plugins/platforms/a2a/tools.py:172` | Yes, same | Yes, same | Model tool; `a2a` toolset | `v2026.8.3` (2026-08-03) |
| `a2a.forward` | `tui_gateway/contracts/canonical.py:459` | Yes, same | Yes, same | Canonical gateway protocol only | `v0.22.3` (2026-10-21) |

### The kanban plugin, as the app reaches it

The plugin is bundled with Hermes (`plugins/kanban/dashboard/manifest.json`, `"api": "plugin_api.py"`). The dashboard mounts its router under `/api/plugins/kanban` (`hermes_cli/web_server_dashboard.py:1243` to `:1247`). A bundled plugin mounts unless the profile lists it in `plugins.disabled`. It needs no `plugins.enabled` entry (`web_server_dashboard.py:857`). The dashboard checks this again on every request (`web_server_dashboard.py:910`). Sign-in is the dashboard's own. `auth_middleware` answers 401 for any `/api/` path without a session token (`hermes_cli/web_server.py:457`). The routes have no owner-only or loopback-only guard. A `?profile=` query runs the handler in that profile's config and secrets (`web_server_dashboard.py:995`). That fix exists so Decompose, Specify and Estimate can reach their model on a host with several profiles. Every board route takes `?board=<slug>`, and omits it for the current board.

The plugin has 47 HTTP routes and one WebSocket (`plugin_api.py:359` to `:1802`). The app uses seven today. It reads `GET boards` (the capability probe, `src/hermes/capabilities.ts:377`, and `src/hermes/kanban.ts:191`), `GET board` (`kanban.ts:131`), `GET workflow` (`kanban.ts:139`) and `GET tasks/{id}` (`kanban.ts:144`, `:215`). It writes with `POST tasks` (`kanban.ts:157`), `PATCH tasks/{id}` (`kanban.ts:165`, `:180`) and `POST tasks/{id}/comments` (`kanban.ts:170`). The Rust relay passes every `PATCH` and `DELETE` under `api/` without a field check (`src-tauri/src/transport.rs:1587`). It passes a kanban `POST` only through `kanban_write`, which allows `tasks` with `title`, `body`, `assignee`, `priority` and `idempotency_key`, and `tasks/{id}/comments` with `body` (`transport.rs:2567`). It passes no kanban `PUT`.

### 4a Plan

**Decompose needs an existing card in triage.** `decompose_task` loads the card and stops with `task is not in triage` for any other status (`hermes_cli/kanban_specify.py:126`). The Plan box must first create a card with `POST tasks {triage: true}`. Today's relay allowlist refuses the `triage` field.

**Decompose calls a model and blocks until it answers.** The route is a plain `def`, so it runs in the threadpool (`plugin_api.py:1602`). It calls the auxiliary model `kanban_decomposer` with a 180 second timeout and 4000 output tokens (`kanban_decompose.py:317` to `:325`). The answer is `{ok, task_id, reason, fanout, child_ids, new_title}` (`plugin_api.py:1607`). A failure comes back as `ok: false` with a 200 status, not an HTTP error.

**Decompose writes the cards at once. Nothing can be previewed.** In one transaction it creates each child in `todo`. It links children to each other by the model's `parents` indices, and links the root under every child, so the root waits for all of them. It moves the root from triage to todo and gives it to `kanban.orchestrator_profile`. It adds a "Decomposed into ..." comment and a `decomposed` event (`hermes_cli/kanban_db_graph.py:116` to `:161`). When the model answers `fanout: false`, decompose acts like Specify and tightens the one card (`kanban_decompose.py:221`). A second call answers `ok: false`, "task already decomposed or moved out of triage" (`kanban_db_graph.py:125`, `kanban_decompose.py:297`). No route or flag returns the plan without writing it.

**What each card can carry.** Decompose sets only `title`, `body` and `assignee` on a child (`kanban_decompose.py:264`). An assignee the roster doesn't know becomes `kanban.default_assignee`, so a child is never unassigned (`kanban_decompose.py:184`). A child takes the root's workspace kind. A `worktree` child gets a fresh worktree of its own when it runs (`kanban_db_graph.py:176` to `:195`). After decompose, `PATCH tasks/{id}` can change the assignee, `model_override`, `provider_override`, `reasoning_effort`, priority, title and body (`plugin_api.py:533`). It can't set `skills`, `workspace_kind`, `workspace_path` or `max_runtime_seconds`. Only `POST tasks` sets those, when a card is made (`plugin_api.py:414` to `:432`). A per-card skill or worktree choice works only on cards the app creates itself.

**Estimate is a token guess, not money.** `POST estimate {title, body}` and `POST tasks/{id}/estimate` send the title and body (cut to 400 and 4000 characters) to the auxiliary model `kanban_estimator`. They answer `{ok, est_tokens, complexity, rationale, model}`, where complexity is S, M or L (`plugin_api.py:1090` to `:1136`). The code says "NOT a dollar cost" (`plugin_api.py:1053`). Neither writes anything.

**Links.** `POST links {parent_id, child_id}` answers `{ok, gated}`. `gated` means a ready child went back to todo (`plugin_api.py:817`, `kanban_db.py:1534`). It refuses with 400 a self link, an unknown id, a running child and a cycle. A repeat adds no second row (`INSERT OR IGNORE`, `kanban_db.py:1348`). `DELETE links?parent_id=&child_id=` answers `{ok}` (`plugin_api.py:824`). It then runs `recompute_ready`, so removing a card's last open parent can start it (`kanban_db.py:1622`). There is no route that lists links. The app reads them from `GET tasks/{id}` (`links`, `link_tasks`) and the board's `link_counts`.

**Bots and models for the pickers.** `GET assignees` lists profiles on disk plus names already on the board (`plugin_api.py:1247`). `GET profiles` adds each profile's model, provider and description (`plugin_api.py:1553`). The decomposer routes by that description. `GET model-options` lists providers and models for `model_override` (`plugin_api.py:1280`).

### Dispatch, and why "nothing runs until the owner says so" fails today

The gateway runs the dispatcher when `kanban.dispatch_in_gateway` is on, the default (`config_defaults.py:1881`). It ticks every `kanban.dispatch_interval_seconds`, default 60 (`config_defaults.py:1886`). Each tick does three things that matter here.

- It promotes every `todo` card whose parents are all done or archived to `ready`. That includes cards with no parents (`kanban_db_dispatch.py:2232`, `kanban_db.py:2036`).
- It decomposes up to three triage cards, when `kanban.auto_decompose` is on, the default (`gateway/kanban_watchers_common.py:87`, `config_defaults.py:1926`).
- It claims each assigned `ready` card and starts its worker. With `kanban.default_assignee` set, it assigns unassigned ready cards to that profile first (`kanban_db_dispatch.py:2427` to `:2440`).

Decompose itself promotes the parentless children at once when `kanban.auto_promote_children` is on, which is the default in code (`kanban_db_graph.py:164`, `kanban_decompose.py:215`). With it off, the children stay in `todo` only until the next tick promotes them. So after Decompose, the first children start within one tick, whatever the owner does. On the default config a triage card can also be decomposed by the dispatcher before the owner presses Plan.

The "orchestration mode" the research names is two profile settings, not a board setting. `GET orchestration` reads `auto_decompose`, `auto_promote_children`, `orchestrator_profile` and `default_assignee`. `PUT orchestration` writes them into the profile's `config.yaml` (`plugin_api.py:1633`, `:1675`). Every board uses the one default workflow (`plugin_api.py:1627`). `POST dispatch` runs one tick now so the owner doesn't wait for the next one (`plugin_api.py:1269`). Its `dry_run=true` still runs the reclaim and promote steps, which write (`kanban_db_dispatch.py:2376`).

A card stays still only in these states, from source. It is in triage with `auto_decompose` off. It is blocked by the owner, which `recompute_ready` skips (`kanban_db.py:1978`, `:2059`). It has a parent that isn't done. Or it is ready with no assignee and no `default_assignee`, which the dispatcher skips (`kanban_db_dispatch.py:2434`).

### 4b Workers

`GET workers/active` lists open runs whose card is running. Each has `run_id`, `task_id`, `task_title`, `task_status`, `task_assignee`, `profile`, `worker_pid`, `started_at`, `claim_lock`, `claim_expires`, `last_heartbeat_at` and `max_runtime_seconds` (`plugin_api.py:920`). `GET runs/{id}` gives one run's full row, including `outcome`, `summary`, `metadata` and `error` (`plugin_api.py:936`, `kanban_db.py:681`).

**The worker process is not the bot.** The dispatcher starts `python -m hermes_cli.kanban_worker_client` (`kanban_db_dispatch.py:2697`). That process only hands the claim to the profile's owner and waits for a receipt. It "never run[s] an agent" (`hermes_cli/kanban_worker_client.py:1`). The bot runs inside the profile's owner process. So `GET runs/{id}/inspect`, which reports `psutil` CPU, memory, threads and command line for `worker_pid` (`plugin_api.py:943`), describes the waiting submitter. `GET tasks/{id}/log?tail=<bytes>` returns that process's output as `{task_id, path, exists, size_bytes, content, truncated}` (`plugin_api.py:1255`). The log holds a `Session: <id>` line (`kanban_worker_client.py:136`) and, at the end, the bot's last reply (bf0203a `kanban_worker_client.py:84`). It is not a live log of the bot's work.

**What ties a run to a chat session.** When the owner admits a claim it writes a task event of kind `owner_admitted`, scoped to the run, with payload `{db, session_id, request_id, pid, birth}` (`gateway/session_kanban.py:127`). `GET tasks/{id}` returns every event with `run_id` and parsed `payload` (`plugin_api.py:402`, `kanban_db.py:756`). That `session_id` is the only field that links a run to the chat doing the work. No run row, worker row or task row carries it.

**Tokens so far.** No kanban route returns tokens. The stored session row carries `input_tokens` and `output_tokens` (`hermes_state_sessions.py:834`, `hermes_state_schema.py:86`). The app reads that row today with `GET /api/sessions/{id}?profile=` (`src/hermes/transport.ts:2933`). Whether that route finds a kanban session by the `owner_admitted` id, in the assignee's profile, is in Open questions.

**Stop, Reclaim, Reassign.** `POST runs/{id}/terminate {reason}` and `POST tasks/{id}/reclaim {reason}` both call `reclaim_task`. It ends the claim, terminates the worker and puts the card back in `ready`, or `review` for a reviewer run (`plugin_api.py:985`, `:1008`, `kanban_db.py:2475`, `:2236`). A ready card starts again on the next tick, so neither is a stop. Terminate answers 409 for a run that already ended. Reclaim answers 409 when the card isn't running. `POST tasks/{id}/reassign {profile, reclaim_first, reason}` answers 409 for a running card unless `reclaim_first` is true (`plugin_api.py:1039`, `kanban_db.py:2511`). An empty profile unassigns. To stop a card for good, the owner must also block it (`PATCH {status: "blocked", block_reason}`), which the workflow allows from running (`kanban_workflow.py:130`).

`GET stats` (`plugin_api.py:1240`) and `GET diagnostics` (`plugin_api.py:882`) are cheaper polls than the whole board. Diagnostics says why a card sits in ready.

### 4c Review

The workflow has a Review column that takes no drop (`kanban_workflow.py:122`). From review a person may move a card to triage, todo, ready or done (`kanban_workflow.py:134`).

**Accept** is `PATCH tasks/{id} {status: "done"}`. It calls `complete_task(force=True)` (`plugin_api.py:595`). From review it needs no summary (`kanban_db.py:2661`). It is refused with 409 when a parent has reopened or a pull request acceptance check fails (`kanban_db.py:2665`, `:2674`). The app's move already sends this (`kanban.ts:179`).

**Send back** is `PATCH tasks/{id} {status: "ready"}`. Todo and triage do the same thing. Leaving review always runs `reopen_review_task` (`plugin_api.py:586`). It puts the card in ready, or todo when a parent reopened, gives it back to the implementer named in the `review_requested` event, and writes a `review_reopened` event (`kanban_db.py:3601` to `:3634`). It takes no reason. The notes must go as a separate `POST tasks/{id}/comments`, which has no idempotency key (`plugin_api.py:802`). The implementer re-runs "on the new comments" (`kanban_db.py:3602`).

**The verdict record isn't on REST.** Hermes has a structured verdict, `request_changes`. It ends the reviewer's run with outcome `changes_requested` and writes a `changes_requested` event with `reason`, `implementer`, `reviewer` and `status` (`kanban_db.py:3408` to `:3475`). It refuses unless the card is running in a reviewer run claimed from review (`kanban_db.py:3425`, `:3432`). Only the worker tool `kanban_request_changes` (`tools/kanban_tools.py:926`) and `hermes kanban request-changes` (`hermes_cli/kanban.py:1063`) call it. No plugin route does. So over REST, Hermes records an owner's acceptance as a completed card, and a send-back only as a `review_reopened` event with no reason attached.

**A bot reviews first on the default config.** `kanban.review_dispatch` is `True` by default (`config_defaults.py:1884`). Each tick then claims every assigned review card whose assignee is a profile and starts it with the `sdlc-review` skill (`kanban_db_dispatch.py:1821`, `:2389`). A worker's `kanban_request_review` without a reviewer leaves the card assigned to the implementer (`kanban_db.py:3340`), so the implementer's profile reviews its own work. A card reaches the owner's queue untouched only when `review_dispatch` is off or the card is unassigned. `PATCH {status: "review", assignee: ""}` moves a card to review and then unassigns it (`plugin_api.py:647`).

### 4d Hand off

`POST tasks {title, body, assignee, idempotency_key}` creates a card for another profile (`plugin_api.py:435`). With an assignee and no open parent it lands in ready and starts within one tick. A retry with the same key returns the first card (`kanban_db.py:1227`). The answer is `{task, warning?}`. The warning says when no dispatcher will run it (`plugin_api.py:448`).

**No field holds the source chat.** `CreateTaskBody` has no `session_id` (`plugin_api.py:414`). A dashboard card's `tasks.session_id` is NULL (`kanban_db.py:636`). Only `kanban_create` inside a chat sets it. The app's dispatched-work match reads that field (`src/hermes/dispatched.ts:237`), so a handed-off card never shows under its chat by itself. The selected text goes in `body`. The source chat id can only ride in the body text, or be kept by the app, which `KanbanWatch.add(task, sessionId)` already supports (`kanban.ts:302`). Hermes won't wake the source chat either. `auto_subscribe_on_create` applies only inside the `kanban_create` tool (`tools/kanban_tools.py:1235`).

**Reading the result back.** `GET tasks/{id}` returns `task.status`, `task.result`, the full `latest_summary`, `runs[].summary` and `child_results` (`plugin_api.py:392` to `:409`).

**Another server.** A2A exists only as model tools in the `a2a` toolset, such as `a2a_call` (`plugins/platforms/a2a/tools.py:172`), and as the inbound canonical method `a2a.forward` (`tui_gateway/contracts/canonical.py:459`). No dashboard route sends to a peer. The app can still hand off across servers without A2A. It holds a signed-in connection to each server (ADR 0125), so it can `POST tasks` to the other server's own kanban plugin. A card on one server can't link to a card on another, because links live in one board's database.

### Idempotency and stale writes

Only `POST tasks` takes an idempotency key (`plugin_api.py:424`, `kanban_db.py:1227`). No kanban write takes a version or an expected status. Status moves check the current state in SQL and answer 409 with a reason when refused (`plugin_api.py:655`). Title, body, priority and model edits overwrite blindly (`plugin_api.py:670`). `POST links` is safe to repeat. A second decompose answers `ok: false` with a 200 status. Reclaim, terminate and reassign answer 409 when the card has moved on. Comments, bulk edits, `PUT orchestration` and `POST dispatch` have no guard against a lost answer that is sent again.

### Where the research was wrong or incomplete

- The combined idea said "The decompose and dispatcher routes are in Hermes 0.23; your server may be older." Fable said the same of `bf0203a`. Source settles it. `plugin_api.py`, `kanban_decompose.py`, `kanban_db_graph.py` and `kanban_workflow.py` are byte for byte the same at all three commits. The owner's server has every route.
- The combined idea, Fable and the brief promise "a cost" or "a cost estimate" from `/estimate`. It returns a token guess and S, M or L, and says it is "NOT a dollar cost" (`plugin_api.py:1053`).
- No version of the research says that links have no list route. Links come from `GET tasks/{id}`.
- The combined idea, Fable and Grok's rank 2 say the owner edits the graph "before anything runs" and that "nothing may dispatch before the owner confirms". Decompose writes cards at once, promotes the children, and the next tick promotes them even with `auto_promote_children` off (`kanban_db_graph.py:164`, `kanban_db_dispatch.py:2232`). Grok said manual mode "leaves it until you press Decompose". That holds for triage only, not for the children afterwards.
- Fable and the combined idea say each card gets "a model, a worktree and pinned skills" in the plan. Decompose sets title, body and assignee only (`kanban_decompose.py:264`). `PATCH` can add a model but never skills or a workspace (`plugin_api.py:533`).
- Fable said to "flip the board between automatic and manual orchestration". It is the profile's `config.yaml`, not a board setting (`plugin_api.py:1675`).
- Fable described "a dispatcher that spawns one OS process per card" with "process stats, log tail". The process is a submitter that never runs the bot (`kanban_worker_client.py:1`). Inspect and the log describe it, not the work.
- Fable said the review verdict needs a live probe, "a status PATCH plus a comment versus the `kanban_request_changes` tool". Source settles it. The tool works only inside a reviewer run (`kanban_db.py:3425`). The PATCH route takes no reason. Fable's "Request changes ... sends the card back to its bot with your comment" is two separate writes.
- Grok's rank 2 said "Review is a real column ... you complete it or send it back". None of the research names `kanban.review_dispatch`, default on, which hands assigned review cards to a bot reviewer before the owner sees them (`config_defaults.py:1884`).
- Grok's rank 5 said the chat recognizes the card "the way dispatched work is already recognised (ADR 0096)" and wakes through `auto_subscribe_on_create`. A REST card has no `session_id` (`plugin_api.py:414`), and auto-subscribe runs only in `kanban_create` (`tools/kanban_tools.py:1235`).
- Grok's rank 5 said Stop uses `POST runs/{id}/terminate`. Terminate puts the card back in ready and it runs again next tick (`kanban_db.py:2475`).
- Grok's rank 5 hoped for "a small dashboard route" for A2A. None exists at any commit. It missed that the app can create the card on the other server's kanban directly.
- Grok's rank 2 lists `GET runs` as a read. There is only `GET runs/{id}`, and runs ride on `GET tasks/{id}`. Grok's count of 47 routes is right for HTTP.
- Astra leans on the `hermes-workflows` plugin. It isn't bundled. Only its catalog entry is in the tree (`plugin-catalog/hermes-workflows.yaml`).
- None of the research found the `owner_admitted` event, the only link from a run to its chat session (`gateway/session_kanban.py:127`). None noted that `DELETE links` can start a card, that `POST dispatch?dry_run=true` writes, or that the app's relay passes every kanban `PATCH` and `DELETE` without a field check.

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as it does on `b200f5bc`. The feature has no route to hide for lack of support. The one difference in this area is that `bf0203a` skips the Host and Origin check on plugin WebSocket upgrades (`hermes_cli/web_server_dashboard.py`, `PluginApiWebSocketGate`). The app's own requests don't notice it.

The feature must hide or explain these cases on any of the three:

- No dispatcher runs (gateway down or `dispatch_in_gateway: false`). `POST tasks` returns a `warning`. Cards sit in ready.
- The auxiliary model isn't set up. Decompose, Specify and Estimate answer `ok: false` with a reason. `GET diagnostics` names the missing `auxiliary.kanban_decomposer` slot (`hermes_cli/kanban_diagnostics.py:281`).
- `auto_decompose` is on, the default. A triage card made for the Plan box can be decomposed by the dispatcher first.
- `review_dispatch` is on, the default. Assigned review cards go to a bot reviewer.

The probe is the one the app already sends. `GET /api/plugins/kanban/boards` changes nothing and proves the plugin is mounted. Because the plugin file is one unit at all three commits, each new route can be checked with a call that changes nothing. Use `GET workers/active`, `GET orchestration` and `GET tasks/{id}/log` on a real card. Use `POST estimate {title: ""}`, which answers `ok: false` before any model call (`plugin_api.py:1092`). Use `POST tasks/__hermes_chat_probe__/decompose` and `/specify`, which answer `ok: false`, "unknown task id" before any model call (`kanban_specify.py:131`). A 404 with `Not Found` from the hot-mount fallback means the route is missing (`web_server_dashboard.py:1165`). Pair it with `GET orchestration` to learn `auto_decompose` and `auto_promote_children`, and with `GET /api/config` for `kanban.review_dispatch`.

### What Hermes would need

The first PR needs none of these. The feature can't keep its promises without them. File them as issues.

- **A plan preview.** `POST /api/plugins/kanban/tasks/{task_id}/decompose {author?, dry_run: true}` returning `{ok, reason, fanout, rationale, tasks: [{title, body, assignee, parents: [int]}]}` and writing nothing. Then `POST /api/plugins/kanban/tasks/{task_id}/decompose/apply {tasks: [{title, body, assignee, parents, skills?, workspace_kind?, model_override?}], hold: true, idempotency_key}` creating the graph in one transaction, returning `{ok, child_ids}`.
- **A hold the dispatcher respects.** A per-card `held: bool` (or `initial_status: "held"` on `POST tasks`, which `create_task` already half supports with `initial_status="blocked"`, `kanban_db.py:108`) that `recompute_ready` and the dispatcher skip. And `POST /api/plugins/kanban/tasks/release {ids, idempotency_key}` to start them, returning `{results: [{id, ok, status}]}`.
- **An owner's review verdict.** `POST /api/plugins/kanban/tasks/{task_id}/review {verdict: "approve" | "changes_requested", reason, expected_status: "review", idempotency_key}`. It should work on a card in `review`, not only inside a reviewer run. It should write the same `changes_requested` event with `reviewer: "owner"` and return `{ok, task}`, with 409 when the card has left review.
- **A human-review card.** A per-card `review_by: "owner"` (or `review_dispatch: false` per card) so the review lane skips it.
- **The source chat on a REST card.** `session_id` (and `creator_task_id`) on `POST tasks`, validated against the profile's sessions, with `auto_subscribe_on_create` honored, so a handed-off card wakes its chat.
- **The run's session on the run.** `session_id` on `GET workers/active` and `GET runs/{id}`, plus `input_tokens` and `output_tokens` so far, so the worker view doesn't need the event list or a second route.

### Open questions

- Whether `GET /api/sessions/{id}?profile=<run.profile>` finds the session named in `owner_admitted`, and whether its token counts move during the run. The payload's `db` field names the owner's store, which may not be the profile's `state.db`. Check on a throwaway Hermes. Run one card, read `owner_admitted` from `GET tasks/{id}`, then read that session and its messages twice during the run.
- Whether a block on a running card kills its worker. `block_task` clears `worker_pid` and the claim (`kanban_db.py:3196`), but the survey found no terminate call on that path. Check on a throwaway Hermes. Block a running card, then read `GET runs/{id}/inspect` and the owner's process list.
- Whether a blocked "gate" parent is a safe app-side hold for a plan built with `POST tasks {parents: [gate]}`. From source the children wait in todo while the gate is blocked (`kanban_db.py:2067`), and the gate stays blocked because the block is sticky (`kanban_db.py:1995`). Check on a throwaway Hermes with the dispatcher running for three ticks.

## Guardrails and budgets for each bot

The feature asks Hermes for three things. It must say what each bot spent in a period, and which chats spent it. It must let the app apply brakes when a budget runs out. It must show each bot's fallback models, approval default and toolsets. Every read and every brake below is the same at `b200f5bc`, `bf0203a` and `f0d9488`, with one exception. `bf0203a` has no route to stop a cron run in flight. Hermes enforces no money budget of its own at any of the three commits.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `GET /api/analytics/usage` | `hermes_cli/web_routers/analytics.py:149` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `GET /api/analytics/models` | `hermes_cli/web_routers/analytics.py:414` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.30` (2026-04-30), in another file until `v2026.9.7` |
| `GET /api/sessions` | `hermes_cli/web_routers/sessions.py:182` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:560` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `session.usage` (method) | `tui_gateway/methods_session.py:1443` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.usage` (event) | `tui_gateway/contracts/events.py:354` | Yes, same | Yes, same | A turn running | `v2026.9.14` (2026-09-14) |
| `message.complete` usage | `tui_gateway/contracts/events.py:305` | Yes, same | Yes, same | A turn running | `v2026.9.14` (2026-09-14) |
| Cost pricing, `estimate_usage_cost` | `agent/usage_pricing.py:686` | Yes, same | Yes, same | None | `v2026.3.23` (2026-03-23) |
| `dashboard.show_token_analytics` | `hermes_cli/config_defaults.py:999` | Yes, same | Yes, same | None | `v2026.5.16` (2026-05-16), in another file until `v2026.7.30` |
| `usage.bars` | `tui_gateway/methods_session.py:1841` | Yes, same | Yes, same | Nous Portal sign-in | `v2026.9.7` (2026-09-07) |
| `billing.state` | `tui_gateway/methods_session.py:1825` | Yes, same | Yes, same | Nous Portal sign-in | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| `GET /api/cron/jobs` | `hermes_cli/web_routers/cron.py:734` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/cron/jobs/{job_id}` | `hermes_cli/web_routers/cron.py:739` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `POST /api/cron/jobs/{job_id}/pause` | `hermes_cli/web_routers/cron.py:785` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `POST /api/cron/jobs/{job_id}/resume` | `hermes_cli/web_routers/cron.py:790` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `POST /api/cron/jobs/{job_id}/cancel` | `hermes_cli/web_routers/cron.py:800` | **No** | Yes, same | Dashboard sign-in, `?profile=` | `v0.22.6` (2026-11-02) |
| `cron.catch_up_missed` | `hermes_cli/config_defaults.py:1786` | Yes, same | Yes, same | None. Default `True` | `v2026.9.14` (2026-09-14) |
| `GET /api/plugins/kanban/orchestration` | `plugins/kanban/dashboard/plugin_api.py:1633` | Yes, same | Yes, same | Kanban plugin. No `?profile=` | `v2026.5.28` (2026-05-28) |
| `PUT /api/plugins/kanban/orchestration` | `plugins/kanban/dashboard/plugin_api.py:1675` | Yes, same | Yes, same | Kanban plugin. No `?profile=` | `v2026.5.28` (2026-05-28) |
| `kanban.dispatch_in_gateway` | `hermes_cli/config_defaults.py:1881` | Yes, same | Yes, same | Read once when the gateway starts | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `kanban.auto_decompose` | `hermes_cli/config_defaults.py:1926` | Yes, same | Yes, same | Read every dispatcher tick | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| `GET /api/plugins/kanban/stats` | `plugins/kanban/dashboard/plugin_api.py:1240` | Yes, same | Yes, same | Kanban plugin | `v2026.5.7` (2026-05-07) |
| `POST /api/plugins/kanban/estimate` | `plugins/kanban/dashboard/plugin_api.py:1071` | Yes, same | Yes, same | Kanban plugin, an auxiliary model | `v2026.8.3` (2026-08-03) |
| `hermes pause` / `hermes resume` | `hermes_cli/subcommands/pause.py:47` | Yes, same | Yes, same | A shell on the server | `v2026.9.7` (2026-09-07) |
| `ESTOP` sentinel file | `agent/estop.py:24` | Yes, same | Yes, same | None | `v2026.8.13` (2026-08-13) |
| `session.control` | `tui_gateway/methods_session_control.py:272` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `session.control.read` | `tui_gateway/methods_session_control.py:255` | Yes, same | Yes, same | A live chat | `v2026.9.7` (2026-09-07) |
| `session.control.update` | `tui_gateway/contracts/events.py:582` | Yes, same | Yes, same | A live chat | `v2026.9.14` (2026-09-14) |
| `delegation.pause` | `tui_gateway/methods_session.py:2204` | Yes, same | Yes, same | Legacy `/api/ws` only | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `delegation.status` | `tui_gateway/methods_session.py:2196` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.interrupt` | `tui_gateway/methods_session_interrupt.py:70` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v0.21.6` |
| `GET /api/config` | `hermes_cli/web_routers/config_env.py:81` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `PUT /api/config` | `hermes_cli/web_routers/config_env.py:122` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `PUT /api/config/raw` | `hermes_cli/web_routers/analytics.py:57` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `config.set` `approvals.mode` | `tui_gateway/methods_config_set.py:526` | Yes, same | Yes, same | `profile` param | `v2026.9.7` (2026-09-07) |
| `approvals.mode` | `hermes_cli/config_defaults.py:1663` | Yes, same | Yes, same | None. Default `smart` | `v2026.7.20` (2026-07-20), in another file until `v2026.7.30` |
| `approvals.cron_mode` | `hermes_cli/config_defaults.py:1666` | Yes, same | Yes, same | None. Default `deny` | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `fallback_providers` | `hermes_cli/config_defaults.py:24` | Yes, same | Yes, same | None. Default empty | `v2026.3.30` (2026-03-30), in another file until `v2026.7.30` |
| `hermes fallback` | `hermes_cli/subcommands/fallback.py:11` | Yes, same | Yes, same | A shell on the server | `v2026.9.7` (2026-09-07) |
| `GET /api/delegation/routing` | `hermes_cli/web_routers/delegation.py:92` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v0.22.5` (2026-10-23) |
| `GET /api/tools/toolsets` | `hermes_cli/web_routers/tools.py:223` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `PUT /api/tools/toolsets/{name}` | `hermes_cli/web_routers/tools.py:273` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `agent.max_turns` | `hermes_cli/config_defaults.py:66` | Yes, same | Yes, same | None. Default unlimited | `v2026.8.19` (2026-08-21) |
| `agent.run_budget_seconds` | `hermes_cli/config_defaults.py:73` | Yes, same | Yes, same | None. Default off | `v2026.8.19` (2026-08-21) |
| `goals.max_turns` | `hermes_cli/config_defaults.py:1392` | Yes, same | Yes, same | None. Default 20 | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `delegation.max_iterations` | `hermes_cli/config_defaults.py:1348` | Yes, same | Yes, same | None. Default 250 | `v2026.8.16` (2026-08-16) |
| `delegation.max_spawn_depth` | `hermes_cli/config_defaults.py:1368` | Yes, same | Yes, same | None. Default 1 | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `delegation.max_concurrent_children` | `hermes_cli/config_defaults.py:1362` | Yes, same | Yes, same | None. Default 10 | `v2026.8.16` (2026-08-16) |
| `delegation.subagent_auto_approve` | `hermes_cli/config_defaults.py:1377` | Yes, same | Yes, same | None. Default `False` | `v2026.4.30` (2026-04-30), in another file until `v2026.7.30` |
| `delegation.inherit_mcp_toolsets` | `hermes_cli/config_defaults.py:1346` | Yes, same | Yes, same | None. Default `True` | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `approvals.deny` | `hermes_cli/config_defaults.py:1678` | Yes, same | Yes, same | None. Default empty | `v2026.7.7` (2026-07-07), in another file until `v2026.7.30` |
| `kanban.max_in_progress` | `hermes_cli/config_defaults.py:1910` | Yes, same | Yes, same | None | `v2026.8.16.2` (2026-08-17) |
| `kanban.failure_limit` | `hermes_cli/config_defaults.py:1889` | Yes, same | Yes, same | None. Default 2 | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `mcp_servers.<name>.spend_limit` | `tools/mcp_tool_costs.py:24` | Yes, same | Yes, same | A server that declares `tool_costs` | `v0.22.3` (2026-10-21) |
| `agent.empty_response_guard.cost_threshold_usd` | `hermes_cli/config_defaults.py:140` | Yes, same | Yes, same | None. Default 0.25 | `v2026.8.16.2` (2026-08-17) |
| `hooks` | `hermes_cli/config_defaults.py:1731` | Yes, same | Yes, same | Shell commands on the server | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |

### Answers to the open questions

**What the usage reads give.** `GET /api/analytics/usage` takes `days` (1 to 365, default 30) and `profile` (`analytics.py:151`). It answers `daily`, `by_model`, `by_task`, `totals`, `period_days`, `skills` and `tools` (`analytics.py:136`). Each `daily` row has the day, input, output, cache read and reasoning tokens, `estimated_cost`, `actual_cost`, `sessions` and `api_calls` (`analytics.py:91`). `GET /api/analytics/models` takes the same params. It answers one row per model and provider, with tokens, both costs, sessions, API calls, tool calls, `last_used_at` and the model's capabilities (`analytics.py:383`). It counts each API call under the model that made it, so a chat that failed over splits correctly (`analytics.py:314`). The usage route's `by_model` instead puts a whole chat under its last model (`analytics.py:105`).

**Which breakdowns Hermes gives directly.** Per profile, by calling each route once per profile. Per model, from `/api/analytics/models`. Per day, from `daily`. Hermes gives no breakdown per project or per chat. The app must build those from the stored chat rows of `GET /api/sessions`, as it already does (`src/hermes/usageAnalytics.ts:10`, ADR 0026). Neither route takes a date range, only a number of days back from now.

**A chat's cost lands on the day it started.** Both routes filter and group by the session's `started_at` (`analytics.py:92`, `:101`). The stored chat rows the app adds up do the same. Hermes keeps no per-call timestamp for cost (`hermes_state_common.py:564` stores one row per chat, model and task, with only `first_seen` and `last_seen`). So "spent this week" really means "spent by chats started this week". A long chat started last week counts nothing this week, whatever it spends now.

**How cost is priced.** `estimate_usage_cost` (`agent/usage_pricing.py:686`) takes the provider's own reported cost first. A subscription route counts as `included` at $0 (`:696`). Otherwise it uses a pricing table, the OpenRouter models API or models.dev (`:575`). A model with no price comes back as status `unknown` with no amount (`:709`). The turn then adds nothing to the chat's `estimated_cost_usd` (`agent/turn_usage.py:240`). The analytics routes sum costs with `COALESCE(..., 0)` and send no cost status (`analytics.py:97`). An unpriced model therefore shows as $0 in Hermes's sums, the same as a free one. Only the stored chat rows carry `cost_status`, which the app already reads (`src/hermes/usage.ts:166`). Hermes itself warns that its token and cost figures are a lower bound and can be far below the provider's bill (`hermes_cli/config_defaults.py:995`).

**`session.usage`.** As a method it takes `session_id` and needs the chat live. It answers token counts, context use, cache hit rate and latency, plus Nous credit lines (`tui_gateway/methods_session.py:1443`). As an event it comes about once a second while a turn runs, only when the counts changed (`tui_gateway/server.py:1877`). Neither carries money. The contract has `cost_usd` and `cost_status` fields (`tui_gateway/contracts/common.py:52`), but `_get_usage` never fills them (`tui_gateway/server.py:1289`). The app reads the event today (`src/hermes/transport.ts:5851`) and not the method.

**What the app already reads.** `src/hermes/usageAnalytics.ts` adds up each chat's stored totals from `GET /api/sessions?order=created&archived=include`, a page at a time, and reads compression segments with `GET /api/sessions/{id}` (`src/hermes/transport.ts:5102`, `:5105`). It reads `GET /api/analytics/usage` only to cross-check a rolling period and to get the usage of Hermes's helper tasks (`src/hermes/transport.ts:5106`). It doesn't read `/api/analytics/models`.

**The top chats behind a budget.** No read names them. `GET /api/sessions` orders only by `created` or `recent` (`sessions.py:197`). Hermes's `/insights` report has "top sessions", but that is one session per metric, with a cut id, as text from a slash command (`agent/insights.py:465`, `gateway/slash_commands_status.py:682`). The app must sort the stored chat rows by cost itself. It already holds them.

**Pause and resume one cron job.** `POST /api/cron/jobs/{job_id}/pause?profile=` takes no body and answers the job with `enabled: false`, `state: "paused"` and `paused_at` (`cron.py:785`, `cron/jobs.py:2174`). It sets no `paused_reason`, so the server can't record that a budget paused it. `POST .../resume` answers the job back on schedule (`cron.py:790`). A recurring slot missed while paused is kept due and fires on the next tick, because `cron.catch_up_missed` defaults to `True` (`cron/jobs.py:2187`, `config_defaults.py:1786`). Read either back with `GET /api/cron/jobs/{job_id}`. Pausing never stops a run already going. `POST .../cancel` does that at `b200f5bc` and `f0d9488` (`cron.py:800`).

**Pause all of a profile's cron jobs.** No route does this. The app lists `GET /api/cron/jobs?profile=` and pauses each job. It must keep its own list of what it paused, so Resume undoes only that.

**Switch the board to manual dispatch.** No route does this. `PUT /api/plugins/kanban/orchestration` takes only `orchestrator_profile`, `default_assignee`, `auto_decompose` and `auto_promote_children` (`plugin_api.py:1615`). The real switch is `kanban.dispatch_in_gateway` (`config_defaults.py:1881`). The gateway reads it once when it starts (`gateway/kanban_watchers.py:231`). A partial `PUT /api/config` could write it, but it takes effect only after a gateway restart, which the app must not do. `auto_decompose: false` works on the next tick (`kanban_watchers.py:303`), but it stops only the splitting of triage tasks, not dispatch. The orchestration route also takes no `?profile=`. It loads and saves the dashboard process's own config file whole (`plugin_api.py:1681`, `:1693`).

**Pause a goal.** `session.control {session_id, action: "goal.pause"}` pauses it, and `goal.resume` resumes it (`methods_session_control.py:27`, `:272`). The same method pauses loops and heartbeats. It answers `{control, dispatch}`, and `control.goal.status` shows the result. `session.control.read` reads it back (`:255`), and `session.control.update` is sent after each change (`:250`). Both need the chat live in the dashboard process (`:294`). No route lists a profile's goals, so the app can pause goals only in chats it has open or can resume.

**`delegation.pause`.** Takes `{paused}` (default true) and answers `{paused}` (`tui_gateway/methods_session.py:2204`). It blocks new subagents. Running ones go on. The flag is a variable in the dashboard process (`tools/delegate_tool_registry.py:16`), so it covers every profile that process serves, and a restart clears it. `delegation.status` reads it back with the running subagents and the limits (`methods_session.py:2196`). A dashboard that runs the canonical gateway refuses it on the legacy socket (`tui_gateway/ws_legacy_fallback.py:46`).

**`session.interrupt`.** Takes `{session_id, expected_hosted_task_id?}` and answers `{status: "interrupted" | "not_interrupted"}` (`tui_gateway/contracts/sessions.py:603`). It stops one running turn and denies the turn's waiting approvals (`methods_session_interrupt.py:67`). The app already uses it for Stop (`src/hermes/transport.ts:3493`). There is nothing to read back except the turn ending.

**The brake the research missed.** `hermes pause` writes an `ESTOP` file in the profile's home (`agent/estop.py:31`, `:64`). While it exists, the cron scheduler (`cron/scheduler_tick.py:117`), the kanban dispatcher (`gateway/kanban_watchers.py:297`) and new messaging turns (`gateway/run_inbound.py:252`) skip new work. Hermes checks the file every tick, so `hermes resume` works with no restart. A file in the root home pauses every profile (`agent/estop.py:36`). This is a per-bot brake for exactly what a budget wants to stop. No route or WebSocket method sets it or reads it.

**Policy reads.** `GET /api/config?profile=` has all three (`config_env.py:81`). The fallback chain is `fallback_providers` (`config_defaults.py:24`). Legacy `fallback_model` entries are added after it (`hermes_cli/fallback_config.py:126`). The approval default is `approvals.mode` (`config_defaults.py:1663`). Cron runs use `approvals.cron_mode`, `deny` by default (`:1666`). The enabled toolsets come from `GET /api/tools/toolsets?profile=`, which answers `enabled` for each toolset's own platform, `cli` for most (`tools.py:223`). That is this app's chats, not Telegram chats or cron jobs. `GET /api/config` doesn't redact. A fallback entry may hold an inline `api_key` (`fallback_config.py:49`), so that read must go through Rust and drop the key before the webview (ADR 0133).

**Scoped writes.** The approval default has one. `config.set {key: "approvals.mode", value}` reads the raw file, changes that key and saves (`tui_gateway/methods_config_set.py:526`, `tui_gateway/server.py:1234`). The app already uses it (`src/hermes/transport.ts:3674`). Toolsets have one, `PUT /api/tools/toolsets/{name}`, also in use (`src/hermes/toolsets.ts:438`). The fallback chain has none. `hermes fallback add|remove|clear` is CLI only (`hermes_cli/subcommands/fallback.py:11`). `PUT /api/config` deep-merges a partial body over the file on disk (`config_env.py:138`). The app already sends partial bodies (`src/hermes/modelSettings.ts:406`). A list is replaced whole, though, so changing one fallback means sending every entry back, inline keys included. That is the whole-map problem of ADR 0121. `PUT /api/config/raw` replaces the whole file (`analytics.py:57`).

**What Hermes enforces on spend by itself.** No money budget per chat, per profile or per day exists at any of the three commits. A search of `config_defaults.py` for `budget`, `spend`, `cost` and `daily` finds only these limits:

- `agent.max_turns`, default unlimited (`config_defaults.py:66`). Cron honors it (`cron/scheduler.py:2451`).
- `agent.run_budget_seconds`, a wall-clock limit per run, default off (`:73`).
- `goals.max_turns`, 20. A goal pauses itself after 20 continuation turns, "against unbounded spend" in Hermes's own words (`:1390`).
- `delegation.max_iterations` 250, `max_spawn_depth` 1 and `max_concurrent_children` 10 (`:1348`, `:1368`, `:1362`).
- `kanban.max_in_progress` and `max_in_progress_per_profile` cap running workers (`:1910`). `kanban.failure_limit` blocks a task after 2 failures (`:1889`).
- `mcp_servers.<name>.spend_limit` with `tool_costs` and `cost_unit`. Hermes tallies a server's declared tool costs per chat, in memory, and asks before a call that passes the limit (`tools/mcp_tool_costs.py:1`).
- `agent.empty_response_guard.cost_threshold_usd`, 0.25. It cuts retries of empty replies from 3 to 1. It is the only dollar figure Hermes acts on (`:140`).

Hermes has no provider spend limit read. `/usage` prints a provider's account usage as text from a slash command (`tui_gateway/methods_slash.py:138`). `usage.bars` and `billing.state` cover only the Nous Portal (`methods_session.py:1841`, `:1825`).

**Autonomy contracts (design note only).** Parts of one exist today. Children inherit narrower toolsets, because `delegate_task` narrows a child's toolsets to the parent's (`config_defaults.py:1344`). Children never ask for approval. `delegation.subagent_auto_approve` decides whether they deny or approve dangerous commands (`:1377`). `approvals.deny` blocks matching commands even under YOLO (`:1675`). A `pre_tool_call` shell hook can block any tool call (`agent/shell_hooks.py:4`), which could act as a tool allowlist. `max_spawn_depth` limits how deep children go. Hermes has nothing that holds a worktree limit, a shared spend allowance, an expiry or a revocable grant across child agents and restarts. A contract would need Hermes to own and check it.

### Where the research was wrong or incomplete

- The brief and the combined idea list "kanban orchestration" as the brake that switches the board to manual dispatch. Fable named `PUT orchestration` for it. The route has no dispatch field (`plugin_api.py:1615`). The real switch, `kanban.dispatch_in_gateway`, has no route and needs a gateway restart (`gateway/kanban_watchers.py:231`).
- The brief names `session.usage` as a cost read. It carries tokens only. `cost_usd` is in the contract but never filled (`tui_gateway/server.py:1289`).
- None of the research says that both analytics routes and the stored chat rows count a chat's whole cost on the day it started (`analytics.py:92`). A daily or weekly budget built on them is a budget on chats started in the period.
- None says that an unpriced model shows as $0 in Hermes's sums with no flag (`analytics.py:97`, `agent/usage_pricing.py:709`). The combined idea's "costs are only what Hermes could price" is right, but the gap is silent.
- Fable listed `POST /api/cron/jobs/{id}/cancel` among the existing brakes. It is absent at `bf0203a` (searched `cancel_job_run` and `/cancel` in the whole tree, no hits).
- Fable listed `usage.bars` and `billing.state` "for subscription limits". They cover only the Nous Portal and answer "not available" for other providers (`methods_session.py:1841`).
- Fable listed kanban `GET stats` and `POST estimate` as reads. `stats` has task counts and no tokens or cost (`plugin_api.py:1240`). `estimate` is a model's guess that spends tokens itself (`plugin_api.py:1071`).
- Fable said Hermes 0.23 enforces each MCP server's per-chat spend limit. It asks for a yes before a call that passes it, rather than refusing. The tally is in memory and counts the server's declared units, not money (`tools/mcp_tool_costs.py:1`). It is the same at `bf0203a`. Astra described it correctly.
- Fable and the brief treat `delegation.pause` as a per-bot brake. It is one flag for the whole dashboard process, every profile at once, and a restart clears it (`tools/delegate_tool_registry.py:16`).
- Grok said "some delegation routes already echo" the fallback chain. `GET /api/delegation/routing` shows each subagent route's own `fallback_providers`, with keys redacted, not the profile's main chain (`delegation.py:109`, `:184`).
- Grok expected a whole-file write for config. `PUT /api/config` deep-merges a partial body (`config_env.py:138`), and the app already uses it that way. The fallback chain is a list, so it still goes back whole. Grok didn't note that `GET /api/config` returns inline fallback keys.
- All four versions missed `hermes pause`, the `ESTOP` file per profile that stops cron, kanban dispatch and new messaging turns live (`agent/estop.py:1`). It is the brake closest to what a budget wants, and it has no route.
- All four missed the limits Hermes already enforces: `agent.max_turns`, `agent.run_budget_seconds`, `goals.max_turns` and the delegation and kanban caps. A policy view can show them read-only.
- All four missed that resuming a cron job fires a slot it missed while paused (`cron/jobs.py:2187`). Resume all at the start of a new period can start a burst of runs.
- Nobody noted that `approvals.cron_mode` (default `deny`) is the approval rule for unattended cron runs, separate from `approvals.mode` (`config_defaults.py:1666`).

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as it does on `b200f5bc`, except `POST /api/cron/jobs/{job_id}/cancel`, which `bf0203a` lacks. On `bf0203a` a cron brake pauses future runs and can't stop one already going. The UI must say so. The usage reads, cron pause and resume, `session.control`, `delegation.pause` and `delegation.status`, `session.interrupt`, the config read and the scoped approval and toolset writes all answer.

The feature must hide or explain these cases on every commit:

- Manual dispatch can't be switched from the app. Offer pausing auto-decompose only if the owner understands it doesn't stop dispatch, or leave it out.
- Goal pause works only in chats the app has live.
- `delegation.pause` covers every profile the dashboard serves, not one bot.
- The fallback chain is read-only.

Probes that change nothing:

- `GET /api/analytics/models?days=1&profile=` answers the models list, or 404 on a Hermes without it.
- `delegation.status` answers on any Hermes that has the delegation methods.
- `session.control.read` with `__hermes_chat_probe__` as `session_id`. 4001 "session not found" means Hermes has `session.control`. "Method not found" means it doesn't.
- `POST /api/cron/jobs/__hermes_chat_probe__/cancel?profile=`. A 404 "Job not found" means the cancel route exists (`cron.py:51`). A 404 "Not Found" or a 405 means it doesn't. No job has that id, so nothing is cancelled.

### What Hermes would need

The first PR needs no Hermes change. A budget that holds while the app is closed does. File these as issues.

- **A budget Hermes enforces.** A `budgets` block in each profile's config: `budgets: {daily_usd, weekly_usd, monthly_usd, daily_tokens, on_limit: pause | ask | warn, count_unpriced_as: tokens | zero}`. The gateway checks it after each priced call (where `agent/turn_usage.py:240` adds the cost) and applies the `ESTOP` file for that profile at the limit. Routes: `GET /api/budgets?profile=` answering `{limits, spent: {day, week, month}, period_start, state: ok | warned | paused, unpriced_tokens}`, and `PUT /api/budgets?profile=` with `{limits, expected_revision}` answering the same shape. An event `budget.state {profile, state, spent, limit}`.
- **The emergency stop as a route.** `GET /api/ops/estop?profile=` answering `{engaged, reason, engaged_at}`, and `POST /api/ops/estop?profile=` with `{engaged: bool, reason}` answering the same shape. It writes or removes the same file `hermes pause` does.
- **A live manual-dispatch switch.** `PUT /api/plugins/kanban/orchestration?profile=` accepting `dispatch_paused: bool`, read every tick like `auto_decompose`, and returned by the GET.
- **Spend by when it happened.** A per-call usage ledger with a timestamp, and `GET /api/analytics/usage?profile=&from=&to=&group=day|model|session` bucketed by call time. Each row adds `cost_status` counts and `unpriced_tokens`.
- **Top chats.** `GET /api/analytics/sessions?profile=&from=&to=&order=cost&limit=` answering `[{session_id, title, model, estimated_cost, cost_status, tokens}]`.
- **Cost on live usage.** Fill `cost_usd` and `cost_status` on `session.usage` and `message.complete` usage, as the contract already allows (`tui_gateway/contracts/common.py:52`).
- **A pause reason.** `POST /api/cron/jobs/{job_id}/pause` accepting `{reason}`. `pause_job` already takes one (`cron/jobs.py:2174`). The read-back would then show who paused a job.
- **A scoped fallback route.** `GET /api/model/fallback?profile=` answering `{chain: [{provider, model, base_url, key_env, has_inline_key}], revision}` with keys redacted, and `PUT /api/model/fallback?profile=` with `{chain, expected_revision}` that keeps each stored inline key it isn't given.

### Open questions

- Does the `ESTOP` file hold a turn the app sends on the dashboard's `/api/ws`? The `pause` command's docstring says desktop turns are held (`hermes_cli/subcommands/pause.py:4`), but no file under `tui_gateway/` checks `estop`. To check, run `hermes -p <profile> pause` on a throwaway Hermes, then send `prompt.submit` on `/api/ws` and see whether the turn runs.
- Does `delegation.pause` stop subagents in cron runs, messaging chats and turns run in their own process (`dashboard.turn_isolation`)? Source shows a variable in one process. Whether those run in the dashboard process depends on how the server is started. To check, pause on a throwaway Hermes, then trigger a cron job whose prompt delegates, and read `delegation.status`.
- What does a stored chat row show for a chat whose model has no price: `estimated_cost_usd` 0 or null, and which `cost_status`? Check with the throwaway Hermes's fake model and `GET /api/sessions/{id}`.
- On a dashboard that serves several profiles, which profile's config does `PUT /api/plugins/kanban/orchestration` write? Source suggests the dashboard's own launch profile (`plugin_api.py:1681` calls `load_config()` with no profile scope). Check on a throwaway Hermes with two profiles.

## Bot test lab

The lab needs Hermes to copy a bot into a throwaway profile, write one edit to the copy, run each saved prompt as a chat nobody sees, read back the answer, the tools it called and the cost, score it with a model call, and then delete the chats and the copy. Every route and method below is the same at `b200f5bc`, `bf0203a` and `f0d9488`, so the owner's server has everything the research version has. What it lacks at all three commits is a way to pick the judge's model per call, a chat that is hidden everywhere, and a per-chat "deny every risky command" setting.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `POST /api/profiles` | `hermes_cli/web_routers/profiles.py:814` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `clone_from` on create | `hermes_cli/web_models.py:457` | Yes, same | Yes, same | None | `v2026.3.30` (2026-03-30), in another file until `v2026.7.30` |
| Clone copies `config.yaml`, `.env`, `SOUL.md` | `hermes_cli/profiles.py:43` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Clone copies the memory files | `hermes_cli/profiles.py:46` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Clone copies the memory provider's config | `hermes_cli/profiles.py:1331` | Yes, same | Yes, same | None | `v2026.9.24` (2026-09-24) |
| Create notifies a running multiplexer | `hermes_cli/profiles.py:1421` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `GET /api/profiles` | `hermes_cli/web_routers/profiles.py:809` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `DELETE /api/profiles/{name}` | `hermes_cli/web_routers/profiles.py:981` | Yes, same | Yes, same | Dashboard sign-in. Refuses `default` | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `delete_profile` | `hermes_cli/profiles.py:1692` | Yes, same | Yes, same | No gateway may still own the folder | `v2026.3.30` (2026-03-30) |
| `GET /api/profiles/{name}/soul` | `hermes_cli/web_routers/profiles.py:1002` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `PUT /api/profiles/{name}/soul` | `hermes_cli/web_routers/profiles.py:1017` | Yes, same | Yes, same | Dashboard sign-in | `v2026.5.7` (2026-05-07), in another file until `v2026.7.30` |
| `PUT /api/profiles/{name}/model` | `hermes_cli/web_routers/profiles.py:1053` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `GET /api/skills` | `hermes_cli/web_routers/skills.py:343` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `PUT /api/skills/content` | `hermes_cli/web_routers/skills.py:472` | Yes, same | Yes, same | `?profile=` | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| `PUT /api/skills/toggle` | `hermes_cli/web_routers/skills.py:418` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `POST /api/skills` | `hermes_cli/web_routers/skills.py:457` | Yes, same | Yes, same | `?profile=` | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| `PUT /api/tools/toolsets/{name}` | `hermes_cli/web_routers/tools.py:273` | Yes, same | Yes, same | `?profile=` | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `GET /api/config` | `hermes_cli/web_routers/config_env.py:81` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `PUT /api/config` | `hermes_cli/web_routers/config_env.py:122` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `profile` param on `/api/ws` | `tui_gateway/server.py:456` | Yes, same | Yes, same | The profile folder exists, else 4064 | `v2026.6.5` (2026-06-05) |
| Multi-profile hosting switch | `tui_gateway/server.py:475` | Yes, same | Yes, same | None | `v2026.9.21` (2026-09-21) |
| `session.create` | `tui_gateway/methods_session.py:479` | Yes, same | Yes, same | The profile exists | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.create` `hidden` | `tui_gateway/contracts/sessions.py:134` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16), in another file until `v2026.9.14` |
| `session.create` model override | `tui_gateway/methods_session.py:398` | Yes, same | Yes, same | A coherent model and provider | `v0.21.6` (2026-10-08) |
| `session.create` `source` | `tui_gateway/agent_factory.py:39` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `prompt.submit` | `tui_gateway/methods_prompt.py:820` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `message.complete` | `tui_gateway/contracts/events.py:305` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `session.close` | `tui_gateway/methods_session.py:2177` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.set_hidden` | `tui_gateway/methods_session.py:1276` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16) |
| Hidden listing filter | `hermes_state_sessions.py:1330` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16), in another file until `v2026.9.7` |
| `session.list` `include_hidden` | `tui_gateway/contracts/sessions.py:224` | Yes, same | Yes, same | None | `v2026.8.16` (2026-08-16), in another file until `v2026.9.14` |
| `session.active_list` | `tui_gateway/methods_session.py:1138` | Yes, same | Yes, same | None | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| `GET /api/sessions` | `hermes_cli/web_routers/sessions.py:182` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:560` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}/messages` | `hermes_cli/web_routers/sessions.py:743` | Yes, same | Yes, same | `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}/mutation-snapshot` | `hermes_cli/web_routers/sessions.py:586` | Yes, same | Yes, same | `?profile=` | `v0.22.3` (2026-10-21) |
| `DELETE /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:850` | Yes, same | Yes, same | Request id, revision and generation. The chat idle | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| Delete removes messages | `hermes_state_mutation_retirement.py:269` | Yes, same | Yes, same | None | `v0.22.3` (2026-10-21) |
| Delete scrubs session files | `hermes_state_sessions.py:1630` | Yes, same | Yes, same | None | `v2026.4.30` (2026-04-30), in another file until `v2026.9.7` |
| `session.delete` | `tui_gateway/methods_session.py:1167` | Yes, same | Yes, same | The chat not live | `v2026.4.30` (2026-04-30), in another file until `v2026.7.30` |
| Session cost columns | `hermes_state_common.py:497` | Yes, same | Yes, same | None | `v2026.3.23` (2026-03-23), in another file until `v2026.7.30` |
| `session.usage` | `tui_gateway/methods_session.py:1443` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `llm.oneshot` | `tui_gateway/methods_session.py:1339` | Yes, same | Yes, same | Credentials for the chosen route | `v2026.7.1` (2026-07-01), in another file until `v2026.7.30` |
| `LlmOneshotParams` | `tui_gateway/contracts/sessions.py:767` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `run_oneshot` | `agent/oneshot.py:80` | Yes, same | Yes, same | None | `v2026.4.30` (2026-04-30), in another file until `v2026.7.1` |
| Auxiliary task routing | `agent/auxiliary_client.py:6055` | Yes, same | Yes, same | None | `v2026.3.12` (2026-03-12) or earlier |
| `max_tokens` forwarding | `agent/auxiliary_client.py:6468` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `temperature` stripping | `agent/auxiliary_client.py:663` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23) |
| `approvals.mode` | `hermes_cli/config_defaults.py:1652` | Yes, same | Yes, same | None. Default `smart` | `v2026.3.17` (2026-03-17), in another file until `v2026.7.30` |
| `approvals.timeout` | `hermes_cli/config_defaults.py:1664` | Yes, same | Yes, same | None. Default 300 s | `v2026.3.12` (2026-03-12) or earlier, in another file until `v2026.7.30` |
| Approval timeout denies | `tools/approval.py:912` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `approval.respond` | `tui_gateway/methods_prompt.py:1332` | Yes, same | Yes, same | Not under `dashboard.turn_isolation` | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `config.set` `yolo` | `tui_gateway/methods_config_set.py:526` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Unattended approval platforms | `tools/approval_context.py:175` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |

### Answers to the open questions

**1. Cloning a candidate.** `POST /api/profiles` takes `name` and `clone_from` (`hermes_cli/web_models.py:454`). With `clone_from` set, Hermes builds the profile in a hidden staging folder and renames it into place (`hermes_cli/profiles.py:1396` to `:1409`), so a failure leaves nothing. It copies `config.yaml`, `.env` and `SOUL.md` (`profiles.py:43`), every skill folder (`:1326`), `memories/MEMORY.md` and `memories/USER.md` (`:46`), `plugins/` (`:1329`) and the active memory provider's own files (`:1331`). Toolsets, approval mode, MCP servers and the model all live in `config.yaml`, so they come along. API keys come along in `.env`. Messaging channels are stripped unless `clone_channels` is set (`:1403`). Chats, scheduled jobs and checkpoints are never copied. `auth.json`, which holds OAuth sign-ins, is not in the copy list. A named profile reads the root profile's `auth.json` read-only (`hermes_cli/auth.py:493`), so a clone of `default` keeps its OAuth sign-ins, and a clone of a named profile with its own OAuth sign-in may not. `clone_all` copies the whole folder instead, minus history (`profiles.py:91`). `DELETE /api/profiles/{name}` stops the profile's gateway and backends, shuts its MCP servers, releases this process's database handles and removes the whole folder (`profiles.py:1713` to `:1776`). It answers `{ok, path}`, or `{ok, settlement_pending, retry_command}` when the folder is gone but the identity cleanup isn't (`web_routers/profiles.py:996`).

The app's clone (`src/hermes/profileClone.ts`, ADR 0074) sends `{name, clone_from, description?}` only for the "full" copy the owner opts into (`profileClone.ts:210`). Its default "fresh" clone sends no `clone_from`. That profile starts with an empty `.env` and Hermes's default toolsets, MCP servers and memory provider (`profileClone.ts:8`, `:131`). A fresh clone is not the bot, so the lab must use `clone_from`. The app deletes with `DELETE api/profiles/{name}` (`profileClone.ts:384`).

**2. Writing the edit to the candidate.** Every write the lab needs names the profile, so the app's active profile never changes.

- Persona goes through `PUT /api/profiles/{name}/soul` with `{content}` (`web_routers/profiles.py:1017`). Read back with the `GET` at `:1002`.
- Model goes through `PUT /api/profiles/{name}/model` with `{provider, model}` (`:1053`). A Model test needs no clone at all. `session.create` takes `model`, `provider` and `reasoning_effort` for that chat only and writes nothing (`tui_gateway/contracts/sessions.py:128`, `methods_session.py:398`).
- Skills go through `PUT /api/skills/content`, `PUT /api/skills/toggle` and `POST /api/skills`, each with `?profile=` or `profile` in the body (`web_routers/skills.py:472`, `:418`, `:457`). Read back with `GET /api/skills?profile=` (`:343`).
- Toolsets go through `PUT /api/tools/toolsets/{name}?profile=` with `{enabled}` (`web_routers/tools.py:273`).
- Approval mode goes through `PUT /api/config?profile=` with `{config: {approvals: {mode}}}` (`web_routers/config_env.py:122`).

`POST /api/profiles/active` is the only route that changes an active profile, and it changes only the sticky default for the command line (`web_routers/profiles.py:908`). The lab never calls it.

**3. Running a case on the candidate.** The dashboard's `/api/ws` serves any profile on the host when a call names it. `_profile_home` resolves the folder and binds that profile's home, secrets and terminal for the call (`tui_gateway/server.py:456`, `:485`). The turn runs in the dashboard's own process. `session.create` makes no database row (`methods_session.py:440`). The row is written to the profile's own `state.db` on the first prompt (`_persist_session_row_for_submit`, `tui_gateway/methods_prompt.py:625`). Nothing on that path starts or needs a gateway. The combined research's "a cloned profile may need its gateway started before its chats are kept", and Fable's "Hermes keeps a new profile's chats only once a gateway serves it", are not what source shows. The only gateway contact is that a create asks a running multiplexing gateway to serve the new profile too (`profiles.py:1421`), and that a prompt for a chat whose gateway ledger holds work is forwarded to that gateway (`tui_gateway/owner_forward.py:1`). A new chat has no ledger entry.

A case runs as five calls the app already makes for ordinary chats.

1. `session.create {profile, source: "gui", hidden: true, title, cwd, cwd_explicit: true, idempotency_key}` (`contracts/sessions.py:118`). The `idempotency_key` returns the same session on a retried create (`methods_session.py:338`).
2. `prompt.submit {session_id, text}` (`methods_prompt.py:820`). It takes no idempotency key, so a lost answer is settled by reading the stored messages before sending again.
3. Wait for `message.complete` (`contracts/events.py:305`).
4. Read the result (question 6).
5. `session.close`, then the delete (question 5).

The first call that names a second profile flips the dashboard process into multi-profile hosting for the rest of its life (`server.py:469` to `:475`). From then on, a secret read that names no profile fails instead of falling back to the launch environment. An owner who has only `default` gets this the first time the lab runs. None of the research mentions it.

**4. Hidden chats.** Hermes has a `hidden` flag. `session.create` takes it (`contracts/sessions.py:134`) and stores it as `pending_hidden` (`methods_session.py:424`), so the row is born hidden on the first prompt (`:1295`). `session.set_hidden` and `PATCH /api/sessions/{id}` set it later (`methods_session.py:1276`, `web_routers/sessions.py:934`). The flag keeps a chat out of `GET /api/sessions` and `session.list`, which drop hidden rows unless `include_hidden` is set (`hermes_state_sessions.py:1329`). The app's chat list and its Unread count read `GET /api/sessions` (`src/hermes/transport.ts:4867`, `:4884`), so a hidden test chat never shows there. It does show in three places.

- `session.active_list` lists every live session in the process with no hidden flag, source or profile (`tui_gateway/session_registry.py:665`). The app reads it for running work in other profiles (`transport.ts:1756`), so another computer's app sees a running test chat.
- The `archived=only` view still lists rows that are both hidden and archived (`hermes_state_sessions.py:1325`). A test chat is never archived, so this doesn't bite unless something archives it.
- The candidate profile itself appears in `GET /api/profiles` (`web_routers/profiles.py:809`) for every app on the server while it exists.

A `source` tag is not a safe alternative. Hermes stores `source` as given and builds the chat's agent with it as its platform (`tui_gateway/agent_factory.py:39`, `:654`), so a new tag can change what the bot does. Keep `source: "gui"`. Run every case in a clone, so the chats live in the clone's own `state.db` and go with it. A chat that truly hides needs a Hermes change (below).

**5. Deleting.** The app's fenced delete is `DELETE /api/sessions/{id}?profile&request_id&expected_revision&expected_generation`, after `GET …/mutation-snapshot` (`transport.ts:4973`). Hermes refuses a live or busy chat (`hermes_state_mutation_retirement.py:264`), so `session.close` comes first. It deletes the session row, all its messages and its delegate children in one transaction (`hermes_state_mutation_retirement.py:261` to `:270`). Branch children are kept and unlinked. It then removes the session's `<id>.json`, `<id>.jsonl`, `session_<id>.json` and `request_dump_<id>_*.json` files (`web_routers/sessions.py:876`, `hermes_state_sessions.py:1630`). No other attachment store is touched. An id already gone answers `{ok, already_absent}` (`web_routers/sessions.py:869`). `session.delete` over `/api/ws` does the same without the fence (`methods_session.py:1167`). It answers 4007 for an unknown id and 4023 for a live one.

The reads that prove cleanup are these. `GET /api/sessions/{id}?profile=` answers 404 for a deleted chat (`web_routers/sessions.py:566`). `GET /api/profiles` no longer lists a deleted profile. Any `/api/ws` call naming it answers 4064 "Profile '…' does not exist." (`server.py:466`). Deleting the profile removes its whole `state.db`, so the chats go with it even if a chat delete failed. Delete the chats first anyway, so a failed profile delete leaves nothing visible.

**6. Reading the result.** `GET /api/sessions/{id}/messages?profile=` returns stored rows whole (`web_routers/sessions.py:743`). Assistant rows keep `tool_calls` and gain `tool_call_labels` (`:634`). Tool rows keep their results. The answer is the last assistant row, or `text` on `message.complete`. Cost comes from the stored session only. The contract for `message.complete` `usage` declares `cost_usd` and `cost_status` (`tui_gateway/contracts/common.py:52`), but the dashboard never fills them. `_get_usage` sends `model`, token counts and `calls`, and no cost (`tui_gateway/server.py:1289`). `GET /api/sessions/{id}` returns the stored row with `model`, `tool_call_count`, token counts, `estimated_cost_usd`, `actual_cost_usd` and `cost_status` (`hermes_state_common.py:475` to `:499`). A cost Hermes couldn't price must stay unknown, not zero.

**7. Scoring with `llm.oneshot`.** It is the same at all three commits, and `agent/oneshot.py` is byte-identical. Params are `profile`, `instructions`, `input`, `template`, `variables`, `task`, `temperature`, `max_tokens` and `session_id` (`contracts/sessions.py:767`). The result is `{text}` and nothing else (`:780`). It sends one system and one user message, gives up after 60 s, and strips one wrapping code fence (`agent/oneshot.py:80`, `:115`). Defaults are `temperature` 0.3 and `max_tokens` 1024 (`methods_session.py:1351`, `:1363`). Errors are 4030 when there is no prompt, 4031 for an unknown template, 4032 for a bad value, 5030 for any model failure (`:1354` to `:1369`), and 4064 for an unknown profile.

There is no `model` or `provider` param and no JSON mode. The model comes from `auxiliary.<task>` in the profile's config, with `task` defaulting to `title_generation` (`methods_session.py:1362`). When that task names no provider, a live chat passed as `session_id` lends its model (`agent/auxiliary_client.py:6061`, `:4887`, `tui_gateway/session_registry.py:833`). So the owner's pick reaches the judge in one of two ways. The app can make a never-prompted judge chat with `session.create {model, provider}` and pass its id with a `task` that has no route of its own. Or it can set an `auxiliary.<task>` route in a profile's config. The answer never says which model replied. A chat whose agent isn't built yet lends nothing (`session_registry.py:835`), and the call then quietly uses the task's route. The app uses `llm.oneshot` today for titles, summaries and edits (`transport.ts:3435`, `:3454`, `:1014`).

Two provider quirks drop params. `max_tokens` is sent only to Anthropic-compatible, NVIDIA, Gemini native, OpenRouter and managed local routes (`auxiliary_client.py:6468`). Every other route, OpenAI direct and custom endpoints included, gets no cap. `temperature` is dropped for Kimi, OpenAI models that take only the default (gpt-5.x, o-series), Gemini 3.6 and later, Opus 4.7 and later, and any route that refused it once (`auxiliary_client.py:663`, `:6633`).

**8. Unattended runs.** `approvals.mode` takes `manual`, `smart` or `off`, and the default is `smart` (`hermes_cli/config_defaults.py:1663`). In `smart`, a guardian model may approve a flagged command with nobody asked (`tools/approval.py:804` to `:808`). In `manual`, every command Hermes flags as dangerous waits for an answer. The wait is `approvals.timeout`, 300 s by default (`config_defaults.py:1664`). When nobody answers, Hermes denies it with "Silence is not consent." (`tools/approval.py:912`). `approvals.unattended_mode: deny` exists, but it covers only the `webhook`, `msgraph_webhook` and `api_server` gateway platforms (`tools/approval_context.py:175`). Dashboard chats bind no session platform, so it never applies to a test chat. `approvals.mode` is a profile setting (`methods_config_set.py:379`). `yolo` is the only per-chat switch, and it can only loosen (`methods_config_set.py:526`, `:537`). A command matching `approvals` blocklist globs is blocked even under YOLO (`config_defaults.py:1675`).

So the lab sets `approvals.mode: manual` on each clone through `PUT /api/config?profile=` and reads it back. It answers every Approval in a test chat with `approval.respond {choice: "deny"}` (`methods_prompt.py:1332`) and records the command as "asked to run". It refuses to start when `session.info` reports `yolo` on (`src/hermes/approvals.ts:14`), which a dashboard started with `--yolo` does. With `dashboard.turn_isolation` on, `approval.respond` doesn't reach the waiting Approval (`docs/compatibility.md`, Approvals), so the Approval waits out the 300 s and is denied. A command Hermes doesn't flag runs in either mode. Cases with tools should run in a scratch folder (`cwd` with `cwd_explicit`, `contracts/sessions.py:121`), never the bot's own checkout.

**9. Repeats.** Nothing fixes a seed or a temperature for a chat. `session.create` has neither param (`contracts/sessions.py:118`). The agent sends a fixed temperature per model or none (`agent/chat_completion_helpers.py:1451`). `"seed"` appears only in the image and video tools. Only `llm.oneshot` takes `temperature`, and some models drop it (question 7). Repeats are just more chats.

**10. The owner's server.** `bf0203a` and `f0d9488` have every item above with the same client contract. The differences read in source don't touch the lab. `PUT /api/profiles/{name}/model` saves without the locked-key guard at `bf0203a` (`web_routers/profiles.py:148`). `bf0203a` lacks `PUT /api/skills/lock`, which the lab doesn't need. `GET /api/sessions/{id}/messages` at `b200f5bc` adds `display_content` for a vetoed prompt.

### Where the research was wrong or incomplete

- The combined idea says "a cloned profile may need its gateway started before its chats are kept". Fable says "Hermes keeps a new profile's chats only once a gateway serves it". Source shows the dashboard serves any profile on the host in its own process and writes the chat to that profile's `state.db` on the first prompt (`tui_gateway/server.py:456`, `tui_gateway/methods_prompt.py:625`). No gateway is needed.
- Fable says to set "Approvals set to deny so a test never acts on the server". No such mode exists for a dashboard chat. `approvals.mode` is `manual`, `smart` or `off`, and `unattended_mode: deny` covers only three gateway platforms (`tools/approval_context.py:175`). The lab must use `manual` and answer deny itself, or wait out the 300 s timeout. In the default `smart`, a guardian model can approve a flagged command unasked.
- The brief, the combined idea and Fable say to score "with `llm.oneshot` on a model the owner picks". `llm.oneshot` takes no model or provider (`contracts/sessions.py:767`). The model comes from an auxiliary task route or a lent live chat, and the result doesn't say which model answered. It has no JSON mode, and `max_tokens` and `temperature` are dropped on many routes.
- The brief points at `src/hermes/profileClone.ts`. Its default clone is "fresh", with an empty `.env` and default toolsets and MCP servers (`profileClone.ts:131`). The lab needs the "full" copy (`clone_from`), which copies the bot's API keys.
- The brief and every version run the suite "on the current setup", meaning the bot itself. That puts test chats in the real bot's `state.db` and lets them write its memory. Running the baseline in a second, unedited clone keeps the real bot untouched. None of the research says so.
- Grok and Astra say a Model change needs a candidate. `session.create` takes `model` and `provider` for one chat (`contracts/sessions.py:128`), so a Model test needs no clone. Grok's "override on `session.create` that does not write the profile" exists for the model, not for persona or skills.
- Fable and Grok say `session.create` with `hidden` makes a hidden chat. That holds for the chat lists. It doesn't hold for `session.active_list` (`session_registry.py:665`), and the candidate profile shows in `GET /api/profiles` while it exists.
- Grok says hidden chats "can still write memory". In a clone they write the copy's memory, which is deleted. But the clone copies the memory provider's config (`profiles.py:1331`), so an external memory provider may receive the writes.
- None of the research mentions that the first call naming a second profile flips the dashboard into multi-profile hosting for good (`server.py:475`).
- None says that a `source` tag becomes the chat's platform (`agent_factory.py:654`), so tagging test chats by source can change their behavior.
- None says that `auth.json` isn't copied by a clone (`profiles.py:43`).
- Fable's routes hold. `PUT /api/profiles/{name}/soul`, `PUT /api/skills/content`, `PUT /api/profiles/{name}/model` and `DELETE /api/profiles/{name}` all exist and name the profile.

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as on `b200f5bc`. The lab has nothing to hide for lack of a route. It must refuse or explain these cases.

- The dashboard runs with YOLO on. `session.info` then reports `yolo` true for every chat, and no Approval would be asked. The lab refuses to run cases with tools.
- `dashboard.turn_isolation` is on. A test chat's Approval can't be denied at once, so it waits out `approvals.timeout`. The lab says each such case may take five minutes longer.
- The owner has a single profile. The first run flips the dashboard into multi-profile hosting (`server.py:475`). Say so before the first run.
- The bot uses an external memory provider. Say that a test chat may write to it.
- The app is signed in to a gateway's canonical address. The app refuses that protocol today (ADR 0174).

Two reads that change nothing tell the app which case it is in. Send `llm.oneshot {profile}` with no prompt. "Requires a template or instructions/input" (4030) means the method is there, before any model call (`methods_session.py:1354`). "Method not found" means it isn't. Send `session.set_hidden {session_id: "__hermes_chat_probe__"}` without `hidden`. 4021 "hidden required" means it is there (`methods_session.py:1281`). Read `GET /api/config?profile=` for `approvals.mode`, `approvals.timeout` and `dashboard.turn_isolation`.

### What Hermes would need

The first PR needs no Hermes change. These changes would make the lab exact rather than careful. File them as issues.

- `llm.oneshot {…, model, provider, response_format: "json"}` returning `{text, model, provider, usage}`, so the judge runs on the model the owner picked and the app can prove it.
- `session.create {…, ephemeral: true}` for a chat that `session.active_list` leaves out (or a `hidden` and `profile` field on each `session.active_list` row), and that Hermes deletes with its messages when the chat closes.
- `session.create {…, approval_policy: "deny"}`, a per-chat setting that denies every flagged command at once without asking, whatever the profile's mode.
- `session.create {…, skip_memory: true}`. The agent already has `skip_memory` (`tui_gateway/agent_factory.py:682`), but only the `HERMES_IGNORE_RULES` environment variable turns it on.
- `session.create {…, soul, skills_disabled: [str]}`, so a persona or skill edit can be tried in one chat without a clone.
- `POST /api/profiles {…, ephemeral: true, ttl_s}` for a profile that `GET /api/profiles` leaves out by default and Hermes removes when the time runs out, so a crashed run leaves nothing.
- `session.create {…, temperature, seed}` for repeatable runs where the provider supports them.

### Open questions

- Does a judge chat made with `session.create {model, provider}` and never prompted have its agent built by the time `llm.oneshot` names it? If not, the call quietly uses the task's route (`session_registry.py:835`). Check on a throwaway Hermes. Create the chat, wait for its `session.info`, call `llm.oneshot` with its `session_id` and a task with no route, and read which model `agent.log` names.
- With a running multiplexing gateway, does adopting the candidate (`profiles.py:1421`) make it own the candidate's store, so that `DELETE /api/profiles/{name}` waits or fails on `wait_profile_unowned` (`profiles.py:1774`)? Check on a throwaway Hermes with `gateway.multiplex_profiles` on. Clone, run one case, delete, and read `GET /api/profiles`.
- Does an external memory provider in a clone write to the same store as the bot? Check on a throwaway Hermes with that provider configured. Run one case in a clone that tells the bot to remember a word, then ask the original bot.
- Under `dashboard.turn_isolation`, does a test chat's Approval reach this app at all, and does it end at the timeout as denied? Check on a throwaway Hermes with turn isolation on and `approvals.mode: manual`. Prompt `rm -rf ./x` in a scratch folder and read the stored tool row.
- If the dashboard still holds a live chat for the candidate when the profile is deleted, does that chat's next write recreate files under the tombstone? Source closes database handles first (`profiles.py:1750`) but doesn't settle a live agent. The lab closes every chat first. Check on a throwaway Hermes by deleting with one chat still open.

## Fleet console with versioned bot releases

The console (7a) asks Hermes for each server's and each bot's health, and for buttons that restart, drain, update, check and back up a server, each of which the app can watch to the end. Releases (7b) ask Hermes for a bot's persona, skills, models and MCP setup as reads and writes the app can save as a named version and put back. Every route and method below exists at `b200f5bc`, `bf0203a` and `f0d9488`. Three differ in small ways, named in the table.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| **7a Console: reads** | | | | | |
| `GET /api/health` | `hermes_cli/web_routers/status.py:119` | Yes, same | Yes, same | None (public) | `v2026.9.7` (2026-09-07) |
| `GET /api/status` | `hermes_cli/web_routers/status.py:530` | Yes, same (line 482) | Yes, same | None (public). `?profile=` for one bot's gateway | `v2026.9.7` (2026-09-07) |
| `/api/status` `active_agents` | `hermes_cli/web_routers/status.py:588` | Yes, same | Yes, same | Gateway running | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `/api/status` `gateway_platforms` | `hermes_cli/web_routers/status.py:580` | Yes, same | Yes, same | Gateway running | `v2026.9.7` (2026-09-07) |
| `/api/status` `gateway_drainable` | `hermes_cli/web_routers/status.py:592` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `/api/status` `can_update_hermes` | `hermes_cli/web_routers/status.py:484` | Yes, same | Yes, same | None | `v2026.6.19` (2026-06-19), in another file until `v2026.9.7` |
| `/api/status` `memory` and `disk` | `hermes_cli/web_routers/status.py:461` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `GET /api/system/stats` | `hermes_cli/web_routers/status.py:638` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `GET /api/health/idle` | `hermes_cli/web_routers/status.py:152` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.21` (2026-09-21) |
| `GET /api/profiles` | `hermes_cli/web_routers/profiles.py:809` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| Profile row `distribution_version` | `hermes_cli/web_routers/profiles.py:98` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `GET /api/messaging/platforms` | `hermes_cli/web_routers/messaging.py:974` | Yes, without the three Team Gateway fields | Yes, without the three Team Gateway fields | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `GET /api/cron/jobs` | `hermes_cli/web_routers/cron.py:734` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `scheduler_heartbeat_age_s` | `hermes_cli/web_server_cron.py:139` | Yes, same | Yes, same | None | `v2026.9.21` (2026-09-21) |
| `platforms.changed` | `tui_gateway/contracts/events.py:862` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `pairing.changed` | `tui_gateway/contracts/events.py:864` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| `cron.changed` | `tui_gateway/contracts/events.py:860` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| **7a Console: actions** | | | | | |
| `POST /api/gateway/start` | `hermes_cli/web_routers/ops.py:296` | Yes, same | Yes, same | 409 for a bot the multiplexer serves, unless that bot is parked | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/gateway/stop` | `hermes_cli/web_routers/ops.py:309` | Yes, same | Yes, same | 409 while chats are live, unless `?interrupt=true`. For a bot the multiplexer serves, stop parks that bot | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/gateway/restart` | `hermes_cli/web_routers/actions.py:160` | Yes, same | Yes, same | A system gateway needs passwordless sudo | `v2026.4.23` (2026-04-23), in another file until `v2026.9.7` |
| `POST /api/gateway/drain` | `hermes_cli/web_routers/actions.py:187` | Yes, same | Yes, same | Only the drain secret works when `HERMES_DASHBOARD_DRAIN_SECRET` is set | `v2026.9.7` (2026-09-07) |
| `HERMES_DASHBOARD_DRAIN_SECRET` | `plugins/dashboard_auth/drain/__init__.py:118` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01) |
| Drain marker watcher | `gateway/run_shutdown.py:735` | Yes, same | Yes, same | Gateway running | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `GET /api/hermes/update/check` | `hermes_cli/web_routers/actions.py:289` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/hermes/update` | `hermes_cli/web_routers/actions.py:241` | Yes, same | Yes, same | Refused for a container, Docker, Nix or APT install and a commit build | `v2026.9.7` (2026-09-07) |
| `GET /api/hermes/update/receipt` | `hermes_cli/web_routers/actions.py:491` | Yes, same | Yes, same | Dashboard sign-in | `v2026.8.27` (2026-08-27), in another file until `v2026.9.7` |
| `GET /api/actions/{name}/status` | `hermes_cli/web_routers/actions.py:385` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.23` (2026-04-23), in another file until `v2026.9.7` |
| `POST /api/ops/doctor` | `hermes_cli/web_routers/ops.py:563` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/ops/security-audit` | `hermes_cli/web_routers/ops.py:569` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/ops/backup` | `hermes_cli/web_routers/ops.py:583` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `GET /api/ops/backup/download` | `hermes_cli/web_routers/ops.py:602` | Yes, same | Yes, same | 403 outside the profile's `backups` folder | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `GET /api/pairing` | `hermes_cli/web_routers/ops.py:84` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `POST /api/pairing/approve` | `hermes_cli/web_routers/ops.py:91` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `POST /api/pairing/revoke` | `hermes_cli/web_routers/ops.py:120` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `GET /api/ops/checkpoints` | `hermes_cli/web_routers/ops.py:808` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `POST /api/ops/checkpoints/prune` | `hermes_cli/web_routers/ops.py:838` | Yes, same | Yes, same | 400 without `?profile=` on a host with several profiles | `v2026.6.5` (2026-06-05), in another file until `v2026.9.7` |
| `GET /api/credentials/pool` | `hermes_cli/web_routers/ops.py:351` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| **7b Releases** | | | | | |
| `GET /api/profiles/{name}/soul` | `hermes_cli/web_routers/profiles.py:1002` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `PUT /api/profiles/{name}/soul` | `hermes_cli/web_routers/profiles.py:1017` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `GET /api/skills` | `hermes_cli/web_routers/skills.py:343` | Yes, without `locked` | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `GET /api/skills/content` | `hermes_cli/web_routers/skills.py:436` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `PUT /api/skills/content` | `hermes_cli/web_routers/skills.py:472` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `PUT /api/skills/toggle` | `hermes_cli/web_routers/skills.py:418` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `POST /api/skills` | `hermes_cli/web_routers/skills.py:457` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `GET /api/model/options` | `hermes_cli/web_routers/models.py:138` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `GET /api/model/auxiliary` | `hermes_cli/web_routers/models.py:219` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `POST /api/model/set` | `hermes_cli/web_routers/models.py:376` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `PUT /api/profiles/{name}/model` | `hermes_cli/web_routers/profiles.py:1053` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `GET /api/delegation/routing` | `hermes_cli/web_routers/delegation.py:92` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v0.22.5` (2026-10-23) |
| `GET /api/mcp/servers` | `hermes_cli/web_routers/mcp.py:94` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `PUT /api/mcp/servers` | `hermes_cli/web_routers/mcp.py:160` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.7.30` (2026-07-30) |
| `GET /api/config` | `hermes_cli/web_routers/config_env.py:81` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |
| `PUT /api/config` | `hermes_cli/web_routers/config_env.py:122` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `GET /api/config/raw` | `hermes_cli/web_routers/analytics.py:34` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `PUT /api/config/raw` | `hermes_cli/web_routers/analytics.py:57` | Yes, same | Yes, same | Dashboard sign-in, `?profile=` | `v2026.9.7` (2026-09-07) |
| `POST /api/profiles` | `hermes_cli/web_routers/profiles.py:814` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `POST /api/profiles/{name}/export` | `hermes_cli/web_routers/profiles.py:1099` | Yes, with a shorter list of secret folders left out | Yes, same | Dashboard sign-in | `v2026.8.13` (2026-08-13) |
| `POST /api/profiles/import` | `hermes_cli/web_routers/profiles.py:1117` | Yes, same | Yes, same | Dashboard sign-in | `v2026.8.13` (2026-08-13) |
| `hermes profile export` | `hermes_cli/subcommands/profile.py:115` | Yes, same | Yes, same | Shell on the server | `v2026.9.7` (2026-09-07) |
| `hermes profile install` | `hermes_cli/subcommands/profile.py:130` | Yes, same | Yes, same | Shell on the server | `v2026.9.7` (2026-09-07) |
| `hermes profile update` | `hermes_cli/subcommands/profile.py:148` | Yes, same | Yes, same | Shell on the server | `v2026.9.7` (2026-09-07) |
| `hermes profile info` | `hermes_cli/subcommands/profile.py:161` | Yes, same | Yes, same | Shell on the server | `v2026.9.7` (2026-09-07) |
| `distribution.yaml` | `hermes_cli/profile_distribution.py:35` | Yes, same (line 32) | Yes, same (line 32) | None | `v2026.5.16` (2026-05-16) |
| Distribution-owned paths | `hermes_cli/profile_distribution.py:41` | Yes, same | Yes, same | None | `v0.21.7` (2026-10-12) |
| `hermes skills snapshot export` | `hermes_cli/subcommands/skills.py:158` | Yes, same | Yes, same | Shell on the server | `v2026.9.7` (2026-09-07) |

### What each Fleet field reads

Hermes has no single fleet route. The Fleet page builds each row from these reads.

- **Gateway state.** `GET /api/status?profile=<name>` field `gateway_state` (`status.py:579`). Values seen in source are `running`, `draining`, `degraded`, `starting`, `startup_failed` and `stopped`. `gateway_running` says whether the process is alive. `GET /api/profiles` gives `gateway_running` for every profile in one call (`profiles.py:92`). There is no `/api/gateway/status` route. The source says status comes from `/api/status` (`ops.py:293`).
- **Telegram and Discord.** `GET /api/messaging/platforms?profile=` gives each platform's `state`, with `error_code` and `error_message` (`messaging.py:272` to `:296`). The route passes on the state the running gateway reported for the platform (`messaging.py:272`). That is `connecting`, `connected`, `retrying`, `fatal`, `paused`, `disconnected` or `disabled` (`gateway/run_startup.py:1321`, `:1418`, `gateway/run_shutdown.py:782`, `gateway/platforms/base.py:2077`, `:2092`). The route itself answers `disabled`, `not_configured`, `pending_restart`, `startup_failed` or `gateway_stopped` when the platform is off, isn't set up, or the gateway reported nothing. All three commits have every one of these states. The Fleet page must show each of them, and show a state it doesn't know as unknown, never as healthy. The app already reads it (`src/hermes/gateways.ts:245`). `/api/status` `gateway_platforms` has only the platforms the running gateway reported, and an empty map once it stops (`status.py:277` to `:282`).
- **Last cron tick.** `GET /api/cron/jobs?profile=` puts `scheduler_heartbeat_age_s` on every job row (`web_server_cron.py:139`). It is the seconds since that profile's ticker last ran, or null when unknown (`cron/jobs.py:1318`). A profile with no jobs gives no reading. `/api/status` has no tick field. The app already parses it (`src/hermes/cronJobs.ts:204`).
- **Working agents.** `/api/status` `active_agents` (`status.py:569`, `:588`), from the gateway's runtime record. `gateway_busy` is true when the gateway is serving and `active_agents` is above 0 (`gateway/status.py:1246`). `active_sessions` counts dashboard chats active in the last 5 minutes, at most 50 (`status.py:88` to `:91`).
- **CPU, memory and disk.** `GET /api/system/stats` (`status.py:638`) gives `cpu_percent`, `load_avg`, `memory {total, available, used, percent}`, `disk {total, used, free, percent}` for the volume that holds the Hermes home, and `uptime_seconds`. These are for the whole host, never per profile. Without psutil on the server, `psutil` is false and only `load_avg` remains (`status.py:684`). `/api/status` adds `memory` and `disk` as coarse pressure levels only (`status.py:454`).
- **Hermes version.** `GET /api/health` `version`, `displayVersion` and `commit` (`status.py:127`). `commit` is the code the dashboard process started from. `/api/system/stats` repeats `hermes_version`. The app already reads `/api/health` (`src/hermes/capabilities.ts:989`).
- **Pending updates.** `GET /api/hermes/update/check` (`actions.py:289`) gives `update_available`, `behind` (commits behind, `-1` unknown, null when the check could not run), `can_apply` (git installs only), `update_command`, `message`, and up to 20 `commits`. Hermes caches the answer for 24 hours, and `?force=true` asks again (`actions.py:330`). It is per server. `?profile=` changes only which config the check reads.

The owner signs in with a password, so `auth_required` is true. `/api/status` then leaves out `gateway_pid`, `hermes_home` and the per-gateway `gateways` list (`status.py:624`). The Fleet page can't show a gateway's process id on the owner's server.

### The actions, as the app would call them

Every action except drain spawns a `hermes` command on the server and answers at once with `{ok, pid, name}` (`web_routers/_common.py:138`). The app then polls `GET /api/actions/{name}/status?lines=` for `{name, running, exit_code, pid, lines}` (`actions.py:385`). Each action has one record per dashboard process, and a newer spawn of the same name replaces it (`web_server_gateway.py:557`). Two doctor runs for two bots at once share one record.

- **Start.** `POST /api/gateway/start?profile=` runs `hermes gateway start` (`ops.py:296`). Poll `gateway-start`, then read `/api/status?profile=` until `gateway_running` is true. For a bot the multiplexer serves, start unparks a parked bot and is refused otherwise.
- **Stop.** `POST /api/gateway/stop?profile=&interrupt=` (`ops.py:309`). It refuses with 409 while the bot has live chats, unless `interrupt=true`. Poll `gateway-stop`. For a bot the multiplexer serves, stop parks that bot and leaves the gateway running for the others.
- **Restart.** `POST /api/gateway/restart?profile=` always runs `hermes gateway restart --interrupt` (`actions.py:165`). It cuts any running turn, even during a drain. A request within the cooldown, or while a restart runs, gets the same process back (`web_server.py:713` to `:732`). Poll `gateway-restart` for `exit_code` 0, then read `/api/status?profile=`. On the owner's server the app can't compare process ids, so the read-back is the exit code plus `gateway_running` true and `gateway_state` `running`.
- **Drain.** `POST /api/gateway/drain` with body `{action: "drain" | "cancel", suppress_notification}` (`actions.py:187`). It takes no `profile`. It writes `.drain_request.json` in the dashboard process's own home (`gateway/drain_control.py:124`) and answers `{ok, action, requested_at, draining}`. It is not a job.
- **Update.** `POST /api/hermes/update` takes no params (`actions.py:241`). It answers `{ok, pid, name: "hermes-update", action_id}`, or `ok: false` with `error`, `message` and `update_command` when the install can't update itself. Poll `GET /api/actions/hermes-update/status`. Its record survives the dashboard restart, because it also reads the update log and the update receipt (`actions.py:396` to `:422`). `GET /api/hermes/update/receipt` gives `outcome`, `pre_sha`, `post_sha`, `post_version` and owed `followups` (`actions.py:476`).
- **Doctor.** `POST /api/ops/doctor?profile=` runs `hermes doctor` (`ops.py:563`). The findings are the plain text in `lines`. There is no structured result.
- **Backup.** `POST /api/ops/backup?profile=` with body `{output?}` (`ops.py:583`). With no `output`, it writes the zip under `<profile home>/backups` and answers with `archive`, the zip's path on the server. With an `output`, the answer has no `archive` (`ops.py:597`), so the app sends none and always gets the path. Poll `backup`, then fetch it with `GET /api/ops/backup/download?archive=<path>&profile=` (`ops.py:602`).

### Answers to the open questions

**Guards.** No route in this feature is limited to loopback or to a local owner, at any of the three commits. Every one sits behind the same dashboard sign-in as the routes the app uses today. With a password sign-in, the cookie gate checks the session (`hermes_cli/dashboard_auth/middleware.py:208`). On a loopback bind, the session token does (`hermes_cli/web_server.py:457`). `/api/health` and `/api/status` need no sign-in (`hermes_cli/dashboard_auth/public_paths.py:9`). The research's warning that "some routes may be limited to local owners" doesn't hold for any route here. These are the per-route limits The survey found:

- Drain. When `HERMES_DASHBOARD_DRAIN_SECRET` is set to a strong value, the drain plugin makes `/api/gateway/drain` a token route (`plugins/dashboard_auth/drain/__init__.py:118`). Only that bearer secret passes, and the app's sign-in gets 401 (`hermes_cli/dashboard_auth/token_auth.py:80` to `:96`). With it unset, drain takes the normal sign-in.
- Stop refuses with 409 while chats are live unless `interrupt=true` (`ops.py:318`). A bot the shared multiplexer serves is started and stopped by itself. Stop parks that bot inside the multiplexer, and start unparks a parked bot. Start refuses with 409 only for a served bot that isn't parked, because one host gateway already serves every bot (`hermes_cli/web_server_gateway.py:621` to `:656`, `hermes_cli/gateway_profile_lifecycle.py:63`, `ops.py:301`, `:314`). All three commits do this.
- Restart, start and stop on a system-scope gateway service need passwordless sudo for the dashboard's user, or the route fails with 500 and says so (`web_server_gateway.py:498` to `:516`).
- Update refuses a commit build, an install managed outside the dashboard, and Docker, Nix and APT installs (`actions.py:244` to `:262`). `can_apply` is true only for a git install (`actions.py:322`).
- Backup has no `destructive_profile` guard, and `output` may name any path the dashboard's user can write (`ops.py:585` to `:593`). Download refuses any file outside `<profile home>/backups` with 403 (`ops.py:612`).
- Only checkpoint prune in this feature uses `destructive_profile` (`ops.py:838`). Doctor, backup and restart don't.

No route takes a confirmation token. Over an SSH tunnel or the tailnet, the Host check applies to every route alike (`hermes_cli/web_server.py:383`), so it doesn't single out these.

**Restart and update, and the app's own connection.** A gateway restart spawns `hermes gateway restart` for the gateway process (`actions.py:165`, `web_server.py:712`). The survey found nothing in that path that stops a standalone dashboard, and the app talks to a standalone dashboard (ADR 0174). From source the survey infers that a gateway restart doesn't drop the app's `/api/ws`. An update does. At its end it restarts the systemd unit of each `hermes dashboard` or `hermes serve`, and stops or respawns the manual ones (`hermes_cli/update_cmd_maint.py:282`, `hermes_cli/dashboard_procs.py:609`). The app's connection drops there. Before it restarts gateways, `hermes update` waits for running work, up to `agent.restart_after_turn_timeout`, 30 minutes by default (`hermes_cli/update_cmd_drain_report.py:3`). After reconnecting, `GET /api/health` `commit` proves the new version, since it is the code the new process started from (`status.py:123`). It should equal the receipt's `post_sha`. A dashboard the update couldn't restart still reports the old commit, and the receipt then lists it as owed.

**Drain.** In source, a drain refuses new messaging turns, lets running turns finish, and keeps the process up (`gateway/run_shutdown.py:706` to `:716`, `gateway/run_inbound.py:1319`). It also stops the in-process cron ticker from starting jobs (`gateway/run_bootstrap.py:433`). The gateway watcher sees the marker within a second and sets `gateway_state` to `draining` (`run_shutdown.py:735`). A drain never ends by itself. It lasts until `cancel`, a restart, or the marker's one-hour expiry (`drain_control.py:97`). The read that shows it finished is `GET /api/status` with `gateway_state` `draining` and `active_agents` 0. `gateway_busy` doesn't show it. That field is true only for a gateway in `running` or `degraded`, so it is false for the whole drain, with turns still running or not (`gateway/status.py:1246`). A restart interrupts running turns, so the app must wait for `active_agents` 0 before it restarts the gateway itself. A drain doesn't stop the dashboard's own chats, which run in the dashboard process.

**Backup.** `hermes backup` zips the whole Hermes root, every profile included, whatever `profile` says (`hermes_cli/backup.py:603`). `profile` only picks which `backups` folder holds the zip (`ops.py:577`). The zip holds `.env`, `auth.json`, the credential vault and `state.db`. The code lists them as secret files to restore owner-only, not to leave out (`backup.py:169`). It leaves out browser profiles, caches, checkpoints, old backups and the Hermes checkout (`backup.py:77`). The zip can be downloaded over HTTP with the path the backup returned. No route lists backups. The download carries every secret on the server, so it must stream to disk in Rust and never pass through the webview (ADR 0133, ADR 0023).

**Releases.** Every part of a release has a read and a write route, each scoped to one profile.

- Persona. `GET` and `PUT /api/profiles/{name}/soul` (`profiles.py:1002`, `:1017`). The app uses both (`src/hermes/persona.ts:181`, `:201`).
- Skills. `GET /api/skills?profile=` lists them with `enabled` (`skills.py:343`). `GET` and `PUT /api/skills/content` read and edit one `SKILL.md` (`skills.py:436`, `:472`). `PUT /api/skills/toggle` turns one on or off (`skills.py:418`). `POST /api/skills` creates one (`skills.py:457`). None of them carries a skill's other files. Those need the Server files routes, as the app's skill copy already does (`src/hermes/skills.ts:435`).
- Models. `POST /api/model/set`, `PUT /api/profiles/{name}/model`, `GET /api/model/options`, `GET /api/model/auxiliary`, `GET /api/delegation/routing`, and the `model`, `providers`, `auxiliary` and `delegation` sections of `GET` and `PUT /api/config` (`models.py:376`, `profiles.py:1053`, `config_env.py:81`, `:122`).
- MCP. `GET /api/mcp/servers` lists them with env values masked (`mcp.py:94`). `PUT /api/mcp/servers` replaces the whole map (`mcp.py:160`, ADR 0121).

`GET /api/config/raw?profile=` returns `{yaml, path}`. `yaml` is the profile's `config.yaml` exactly as written, with nothing redacted (`analytics.py:34`). `${VAR}` references stay references, but a key typed into the file in clear comes through in clear. `GET /api/config?include_defaults=false` gives the same values parsed (`config_env.py:89`), which the app's Rust already reads for MCP (`src-tauri/src/transport.rs:3366`). Either one must pass through the secret matcher in Rust before the window sees it (ADR 0150).

Hermes has two bundle formats. Neither is a release the app can apply over HTTP.

- **Profile export.** `POST /api/profiles/{name}/export` writes a `.tar.gz` on the server and returns its path (`profiles.py:1099`). For a named profile it copies the whole profile folder except credential stores, then redacts secret-shaped text (`profiles.py:2167`, `:2130`). So it also carries the bot's chats, memories and `state.db`. No route downloads it. `POST /api/profiles/import` takes a path on the server and refuses a name that exists (`profiles.py:1117`). It can make a new bot from an archive but can't update one in place.
- **Profile distribution.** A folder or git repo with `distribution.yaml` (`profile_distribution.py:35`). The manifest has `name`, `version`, `hermes_requires`, `env_requires` and `distribution_owned` (`profile_distribution.py:107`). It owns `SOUL.md`, `config.yaml`, `mcp.json`, `skills` and `cron` by default (`profile_distribution.py:41`). Secrets are named in `env_requires`, never copied, and an install never writes a credential store (`profile_distribution.py:53`). Memories, sessions and the workspace stay the bot's own (`profile_distribution.py:44`). `hermes profile install`, `update` and `info` are CLI only (`subcommands/profile.py:130`, `:148`, `:161`). No route installs, updates or describes a distribution. `GET /api/profiles` shows only `distribution_name`, `distribution_version` and `distribution_source` (`profiles.py:97`). `update` keeps `config.yaml` unless `--force-config` is given.

`hermes skills snapshot export` writes only the hub sources of installed skills and the taps, with no local skills and no content (`hermes_cli/skills_hub.py:1448`).

So a release must live on the app's side. It stores the persona text; each skill's name, category, `enabled` flag, `SKILL.md`, and its other files; the `config.yaml` sections for models, providers, auxiliary, delegation, `mcp_servers` and `skills.disabled`, with every secret replaced by the name of its env var; and the Hermes version it was taken on. Applying it is a run of the single writes above, each read back. It is not atomic, and a server between two writes holds a mix (Astra's risk holds). No write route takes an expected revision, so "refuse if changed" means reading just before each write.

### Where the research was wrong or incomplete

- The combined idea and Fable say "some routes may be limited to local owners." None of the routes here is, at any commit. The one route with its own gate is drain, and only when `HERMES_DASHBOARD_DRAIN_SECRET` is set (`plugins/dashboard_auth/drain/__init__.py:118`).
- The combined idea says releases "need a Hermes format for bundling a bot's config." Hermes has one, the profile distribution (`profile_distribution.py:35`), but only the CLI can install or update it. The profile export (`profiles.py:1099`) is a whole-bot snapshot with chats and memories, not a config release. None of the three versions mentions either.
- Fable says drain "waits for running work to finish before a restart." A drain only stops new turns. It never restarts the gateway, and `POST /api/gateway/restart` always interrupts running work (`actions.py:165`). The app must wait for `active_agents` 0, then restart.
- Fable says "make a backup and download it." It can, but the backup holds the whole server, every profile and every secret (`backup.py:603`, `:169`). None of the research says so.
- The brief lists `/api/gateway/*` for gateway state. No gateway status route exists. State comes from `/api/status` (`ops.py:293`).
- None of the research names where the last cron tick lives. It is `scheduler_heartbeat_age_s` on `GET /api/cron/jobs` rows (`web_server_cron.py:139`), not `/api/status`.
- Fable names the start-then-poll pattern but not the poll route. It is `GET /api/actions/{name}/status` (`actions.py:385`), plus `GET /api/hermes/update/receipt` (`actions.py:491`) for an update. The research missed both.
- The research treats CPU, memory and disk as per bot. `/api/system/stats` is per host (`status.py:638`).
- The brief says "the app's own connection drops when its server restarts." From source, that holds for an update. The survey infers a gateway restart doesn't drop it (see Open questions).
- Astra says skill support files must travel with a release, not only `SKILL.md`. That holds. The skill routes carry `SKILL.md` only (`skills.py:436`).
- Astra's "server deployment plugin" for staging and activation is not in Hermes at any commit. Its point that a run of writes is not an atomic activation holds.
- Fable's `GET /api/config/raw` for the Compare view holds, and it returns the file unredacted (`analytics.py:34`).
- Fable's `GET /api/health/idle`, `POST /api/ops/security-audit`, pairing routes, `GET /api/credentials/pool` and the `platforms.changed`, `pairing.changed` and `cron.changed` events all exist at all three commits. The change events watch the dashboard's own home only (`tui_gateway/change_watcher.py:380` to `:387`), so they don't cover other profiles.

### On the owner's server

Everything above is at `bf0203a` and `f0d9488`. The feature has nothing to hide for lack of a route. Three small differences:

- `GET /api/messaging/platforms` has no `disabled_by_relay`, `relay_fronted` or `relay_exclusive` at either commit (`messaging.py:916` at `bf0203a`). The Fleet page must not depend on them.
- `GET /api/skills` has no `locked` at `bf0203a` (`skills.py:343`). A release must not record lock state there.
- A profile export at `bf0203a` leaves out fewer secret folders. Its list lacks the gateway Webapp's `webapp/` sign-in folder and the 1Password value caches (`bf0203a` `profiles.py:169`). Releases don't use export, so this doesn't touch the feature.

The feature must explain these cases, which come from the server's setup, not its version:

- When `can_update_hermes` or `can_apply` is false, show the `update_command` instead of an Update button.
- When drain answers 401, the drain secret is set, and only its holder can drain this server.
- When `/api/status?profile=` shows `gateway_shared_with`, the multiplexer serves this bot. Stop on this bot's own profile parks only this bot, and Start unparks it. The Fleet page must never send Stop to the multiplexer's profile to stop one bot, because that stops the one gateway that serves every bot.
- When a 500 names sudo, the gateway is a system service and the dashboard's user can't restart it.

The probes are reads that change nothing. `GET /api/system/stats` answers or gives 404. `GET /api/actions/doctor/status` answers `running: false` on a server with the action routes, and 404 on one without. `GET /api/status` `can_update_hermes` says whether an update can be offered at all. Drain has no read that shows the secret, so the first drain's 401 is the signal.

### What Hermes would need

The read-only console needs no Hermes change. These would make the actions and releases exact. File them as issues.

- `POST /api/gateway/drain?profile=<name>` writing the marker in that profile's home. Today drain reaches only the gateway whose home is the dashboard's (`drain_control.py:124`).
- `POST /api/ops/backup {profile, include_secrets: false}` backing up one profile without `.env`, `auth.json` or the vault, and `GET /api/ops/backups?profile=` → `[{archive, bytes, created_at}]`.
- `GET /api/cron/status?profile=` → `{heartbeat_age_s, success_age_s}`, so a bot with no jobs still shows its last tick.
- `GET /api/profiles/{name}/distribution` → the manifest; `POST /api/profiles/{name}/distribution/apply {source, expected_version?, force_config}` → `{ok, pid, name}` as a polled action; and `POST /api/profiles/install {source, name?}` → the same. With them, a release could be a distribution applied on the server in one step.
- An `expected_revision` (or ETag) on `PUT /api/profiles/{name}/soul`, `PUT /api/skills/content`, `PUT /api/config` and `PUT /api/mcp/servers`, answered 409 when the file changed, so "refuse if changed" isn't a separate read.
- `GET /api/skills/files?name=&profile=` and a matching write, so a skill's other files travel without the Server files routes.

### Open questions

- Does a gateway restart drop the app's `/api/ws` on a standalone dashboard? Source suggests not. Check on a throwaway Hermes. Open a chat on the dashboard's address, `POST /api/gateway/restart`, and watch the socket.
- Does the owner's dashboard come back after `hermes update`? `dashboard_procs.py:618` says manual dashboards respawn from their saved command line, and `:625` says manual dashboards aren't restarted. It depends on how the owner started theirs. Check on a throwaway git install one commit behind. Start the dashboard by hand, run the update from the route, and see whether `/api/health` answers with the new `commit`.
- On a host where each profile runs its own gateway, does a drain reach any gateway other than the one in the dashboard's home? Source says the marker sits in the dashboard's home (`drain_control.py:124`), and each gateway reads its own (`run_shutdown.py:737`). Check on a throwaway Hermes with two profile gateways. Drain, then read `/api/status?profile=` for each.

## Fleet memory with sources

The feature asks Hermes for three things. It must search the chats of every profile, read whole chats to answer questions and to open a hit at its message, and list and change memory entries along with the chat each one came from. Searching, reading and editing memory work the same at `b200f5bc`, `bf0203a` and `f0d9488`. No commit records which chat a memory entry came from.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `GET /api/sessions/search` | `hermes_cli/web_routers/sessions.py:286` | Yes, same | Yes, same | Dashboard sign-in, one profile per request | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| Search route's field projection | `hermes_cli/web_routers/sessions.py:425` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Search store's result fields | `hermes_state_search.py:292` | Yes, same (line 198) | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `GET /api/sessions` | `hermes_cli/web_routers/sessions.py:182` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `GET /api/profiles/sessions` | `hermes_cli/web_routers/profiles.py:455` | Yes, same | Yes, same | Dashboard sign-in | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `GET /api/profiles` | `hermes_cli/web_routers/profiles.py:809` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.30` (2026-07-30) |
| `GET /api/sessions/{session_id}/messages` | `hermes_cli/web_routers/sessions.py:743` | Yes, one display field missing | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `GET /api/sessions/{session_id}/timeline` | `hermes_cli/web_routers/sessions.py:805` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.21` (2026-09-21) |
| `GET /api/sessions/{session_id}/messages/around` | `hermes_cli/web_routers/sessions.py:827` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.21` (2026-09-21) |
| `session_search` agent tool | `tools/session_search_tool.py:799` | Yes, smaller default | Yes, smaller default | The profile's `session_search` toolset | `v2026.3.12` (2026-03-12) or earlier |
| `llm.oneshot` | `tui_gateway/methods_session.py:1339` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01), in another file until `v2026.7.30` |
| `GET /api/learning/graph` | `hermes_cli/web_routers/status.py:746` | Yes, same | Yes, same | Dashboard sign-in | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `GET /api/learning/node` | `hermes_cli/web_routers/status.py:773` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `PUT /api/learning/node` | `hermes_cli/web_routers/status.py:791` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `DELETE /api/learning/node` | `hermes_cli/web_routers/status.py:780` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `learning.frames` | `tui_gateway/methods_tools.py:1332` | Yes, same | Yes, same | The dashboard's own profile only | `v2026.7.1` (2026-07-01), in another file until `v2026.7.30` |
| `learning.detail` | `tui_gateway/contracts/tools_mcp_plugins.py:347` | Yes, same | Yes, same | The dashboard's own profile only | `v2026.9.14` (2026-09-14) |
| `learning.edit` | `tui_gateway/contracts/tools_mcp_plugins.py:353` | Yes, same | Yes, same | The dashboard's own profile only | `v2026.9.14` (2026-09-14) |
| `learning.delete` | `tui_gateway/contracts/tools_mcp_plugins.py:350` | Yes, same | Yes, same | The dashboard's own profile only | `v2026.9.14` (2026-09-14) |
| `GET /api/memory` | `hermes_cli/web_routers/ops.py:498` | Yes, same | Yes, same | Dashboard sign-in | `v2026.9.7` (2026-09-07) |
| `memory` agent tool | `tools/memory_tool.py:469` | Yes, wider schema | Yes, same | Memory turned on for the profile | `v2026.3.12` (2026-03-12) or earlier |
| `memory.write_approval` | `hermes_cli/config_defaults.py:1305` | Yes, same (line 1332) | Yes, same | None. Default `False` | `v2026.6.19` (2026-06-19), in another file until `v2026.7.30` |
| Pending memory store | `tools/write_approval.py:66` | Yes, same | Yes, same | `memory.write_approval` on, or a background review that patches or removes | `v2026.6.19` (2026-06-19) |
| Memory tool's staging call | `tools/memory_tool.py:100` | Yes, same | Yes, same | `memory.write_approval` on | `v2026.9.7` (2026-09-07) |
| `command.dispatch` `/memory pending`, `approve`, `reject` | `tui_gateway/methods_tools.py:1005` | Yes, same | Yes, same | The chat's profile, else the dashboard's own | `v0.21.6` (2026-10-08) |
| `review.summary` | `tui_gateway/contracts/events.py:382` | Yes, same | Yes, same | A live chat | `v2026.9.14` (2026-09-14) |
| Background review keeps no chat record | `agent/background_review.py:1018` | Yes, same | Yes, same | None | `v2026.7.1` (2026-07-01) |
| Memory provider write metadata | `agent/background_review.py:755` | Yes, same | Yes, same | An external memory provider | `v2026.5.28` (2026-05-28) |
| `GET /api/fs/list` | `hermes_cli/web_routers/files.py:1012` | Yes, same | Yes, same | Dashboard sign-in. Locked deployments refuse paths outside the managed folder | `v2026.9.7` (2026-09-07) |
| `GET /api/fs/read-text` | `hermes_cli/web_routers/files.py:1032` | Yes, one optional parameter missing | Yes, same | As above | `v2026.9.7` (2026-09-07) |
| `GET /api/config` | `hermes_cli/web_routers/config_env.py:81` | Yes, same | Yes, same | Dashboard sign-in | `v2026.4.13` (2026-04-13), in another file until `v2026.9.7` |

### Searching every profile

`GET /api/sessions/search` searches one profile's store per request. It takes `q`, `limit`, `profile`, `source`, `sources` and `exclude_sources` (`sessions.py:287`). `limit` defaults to 20 and is clamped to 1 to 100 (`sessions.py:303`). There is no `offset`, no date, no role and no tool parameter. An unknown profile is a 404 (`hermes_cli/web_server_cron.py:123`). An empty `q` answers `{"results": []}` without opening the store (`sessions.py:297`).

The route returns one row per chat. It folds every compressed segment of a chat into one row and keeps the first hit (`sessions.py:361`). Id matches come first, then message matches by rank, then title matches (`sessions.py:407`, `:422`, `:443`). Each row has `session_id`, `id`, `lineage_root`, `profile`, `snippet`, `role`, `source`, `model`, `title`, `started_at`, `ended_at`, `last_active`, `is_active`, `message_count`, `tool_call_count`, `input_tokens`, `output_tokens`, `preview`, `parent_session_id` and `archived` (`sessions.py:375` to `:392`). `role` is null for an id or title match.

**A hit does not name its message.** The route asks the store for six fields only: `session_id`, `role`, `snippet`, `source`, `model` and `session_started` (`sessions.py:425`). The store can also return the message `id`, its `timestamp`, its `tool_name` and a few neighbouring lines (`hermes_state_search.py:292`). It also takes `offset`, `role_filter`, `sort`, `after_ts` and `before_ts` (`hermes_state_search.py:1257`). No route passes them on. So the app gets the chat and a snippet, never the message.

The app can still open a hit at its message. Message rows from `GET /api/sessions/{id}/messages` carry `id` and `timestamp` (`hermes_state_messages.py:1300`, every column of the row). The app can read the chat and find the snippet's words, as Search already does with its `find` term (`src/hermes/transport.ts:1945`). `GET /api/sessions/{id}/messages/around` opens a page at a row id, but only at a user prompt (`hermes_state_timeline.py:110`).

**What the app sends today.** `searchPage` sends `q`, the profile on screen, `limit` and `exclude_sources=cron`, plus `sources` when filtered (`src/hermes/transport.ts:1934`). `limit` is 50 for words alone and 100 with filters (`src/hermes/chatFilter.ts:96`, `:98`). That is one request, to one profile, on one connection. ADR 0125 allows at most four background reads at once across connections. Everywhere would send one search per profile per live connection, four at a time.

### The filters

- **Bot.** A bot is a profile. The server filters by `profile`, one per request. `GET /api/profiles` lists them (`profiles.py:809`).
- **Date.** The search route has no date filter. Each row has `started_at` and `last_active`, so the app filters after the fact. Hermes cuts to 100 chats first, so older matches can be missing.
- **Model.** No server filter. Each row's `model` is the chat's model (`sessions.py:378`), not the model of the matching message.
- **Tool used.** No server filter. A row has only `tool_call_count`. The message rows name each tool, in `tool_name` on tool rows and in `tool_calls` on assistant rows. The search index covers both columns (`hermes_state_common.py:953`). A word search for a tool's name therefore finds chats that used it, mixed with chats that only mention the word. The sanitizer strips `:` (`hermes_state_search.py:1031`), so a column filter can't narrow it.
- **File touched.** No server filter and no field in a row. `write_file` and `patch` name the file in `tool_calls` arguments. A search for the file name finds those chats among chats that only mention it. The sanitizer quotes dotted names such as `app.config.ts` as a phrase (`hermes_state_search.py:1042`). The app must read the chat's messages to confirm.

### Ask mode

No route answers a question from past chats. Two paths exist.

1. **Search, read, then `llm.oneshot`.** The app finds chats with the search route, reads the messages, and sends the passages to `llm.oneshot` (`tui_gateway/methods_session.py:1339`). It takes `instructions`, `input`, `task`, `temperature` (0.3 by default), `max_tokens` (1024 by default, no upper limit in the handler, `methods_session.py:1363`), `session_id` and `profile`. Hermes doesn't cut the input, so the model's context size is the limit. It gives up after 60 seconds (`agent/oneshot.py:89`). It has no tools. The app already uses it for titles and summaries (`src/hermes/transport.ts:3454`). The app holds each passage's message id, so every link in the answer is exact.
2. **The agent's own `session_search` tool.** Every profile's agent has a recall tool in its default tool list (`toolsets.py:22`, `tools/session_search_tool.py:799`). A discovery result carries `match_message_id`, the matched message's id (`session_search_tool.py:269`), and a link `@session:<profile>/<id>`. Its `profile` argument reads another profile's store. It returns at most 10 chats and a window of 1 to 20 messages (`session_search_tool.py:587`, `:538`). It runs only inside a chat turn. No client method calls it. To use it, the app would send the question to a bot in a hidden chat and read the tool rows back.

### Memory reads and writes today

The memory editor reads and writes through four profile-scoped routes (ADR 0118). `GET /api/learning/graph?profile=` lists the entries (`status.py:746`). `GET /api/learning/node?id=&profile=` reads one (`status.py:773`). `PUT /api/learning/node` with `{id, content}` replaces one (`status.py:791`). `DELETE /api/learning/node` with `{id}` removes one (`status.py:780`). An id is `memory:<memory|profile>:<index>:<fingerprint>`. The conflict check is that fingerprint. Under the memory file lock, Hermes refuses an id whose text changed with "memory node id is stale" (`agent/learning_mutations.py:70`, `:78`, `:81`). The REST routes answer that refusal as 400 (`status.py:769`).

The socket methods `learning.frames`, `learning.detail`, `learning.edit` and `learning.delete` do the same for the profile the dashboard runs as (`tui_gateway/methods_tools.py:1332`, `:1359`). They take no `profile` (`tui_gateway/contracts/tools_mcp_plugins.py:325`). `GET /api/memory?profile=` gives file sizes and the active external provider (`ops.py:498`). The memory map (ADR 0124) is still a proposal and would read the same graph route. The graph comes back whole with each entry's first 1,200 characters. It has no page size.

All of this is the same at `bf0203a`, including the REST routes (`status.py:693` to `:738` there).

### Where a memory write comes from

Hermes records no source for a memory entry. MEMORY.md and USER.md hold plain text. The graph has no source field. The brief is right that source links need a Hermes change. What the app can work out today depends on who made the write.

- **A write in a chat, applied.** The assistant row holds the `memory` call in `tool_calls`, and the tool row holds the result. `GET /api/sessions/{id}/messages` returns both whole. The assistant row's `id` is the source message. An `add` holds the whole entry. A `patch` holds only the replaced span (`tools/memory_tool.py:117`), so its full entry can't be matched. The call comes in two shapes. `bf0203a` advertises top-level `action`, `content` and `old_text` as well as `operations` (`tools/memory_tool.py:402` there). `b200f5bc` and `f0d9488` advertise `operations` only. The handler takes both at all three (`memory_tool.py:275`).
- **A write in a chat, staged.** The tool result carries `pending_id` (`memory_tool.py:101`). That joins a staged record to its chat and message.
- **A background review write.** After a turn, Hermes may fork the agent to review it and save memory. The fork has no session store (`agent/background_review.py:1018`), so its calls appear in no chat. The only trace is the `review.summary` event, sent live to the chat whose turn was reviewed (`tui_gateway/session_registry.py:131`). It carries only `text` (`tui_gateway/contracts/events.py:376`), such as a line saying memory was updated (`agent/background_review.py:715`). It names no entry and is not stored. The app ignores it today.
- **An edit from this app or another dashboard.** `PUT /api/learning/node` leaves no tool row at all.

Hermes does build a source record for every memory write in a chat: `write_origin`, `execution_context`, `session_id`, `parent_session_id`, `platform`, `tool_name`, `task_id` and `tool_call_id` (`agent/background_review.py:755`). It hands that record only to an external memory provider (`agent/inline_tool_executors.py:157`). The built-in files never get it.

To link entries to chats, Hermes needs that record kept per entry and returned on `GET /api/learning/graph`. See What Hermes would need.

### A review queue

Hermes has one. `memory.write_approval` defaults to `False` (`hermes_cli/config_defaults.py:1305`). When it is on, a write from the background review is always staged. A write in a chat asks inline where a prompt callback exists, and is staged otherwise (`tools/write_approval.py:201`). A background review that tries to patch or remove an entry is staged even with the gate off (`tools/memory_tool.py:179`).

A staged write is a file, `<profile home>/pending/memory/<id>.json` (`tools/write_approval.py:66`). It holds `id`, `subsystem`, `action`, `summary`, `origin`, `created_at` and `payload` (`write_approval.py:80`). `origin` is `foreground` or `background_review`. A patch or remove also pins the full entry it will change, as `matched_entry` (`memory_tool.py:64`). The record has no chat id, message id or tool call id.

The only client path to the queue is the `/memory` command. `command.dispatch {name: "memory", arg: "pending"}` lists it. `approve <id>`, `approve all`, `reject <id>` and `reject all` act on it, and `approval on|off` sets the gate (`tui_gateway/methods_tools.py:972`, `:1005`, `hermes_cli/write_approval_commands.py:35`). It answers `{type: "exec", output}` with plain text (`methods_tools.py:188`). It runs for the chat's profile, or the dashboard's own profile with no chat (`methods_tools.py:1017`). Approve applies the payload as staged. Nothing approves an edited version.

The app could read the records as data through `GET /api/fs/list` and `GET /api/fs/read-text` on that folder. `pending` is not on the file routes' sensitive list (`hermes_cli/web_routers/files.py:84`, `:97`). A locked deployment refuses paths outside its managed folder (`hermes_cli/web_server_files.py:489`). This is a read of Hermes's files, not a contract. It can only list, and approve and reject still go through `/memory`.

With the gate off, only a background review's patch or remove waits in the queue (`tools/memory_tool.py:179`). Every other write is applied at once. Proposals staged earlier stay until someone approves or rejects them. For the applied writes, the app can list what changed after the fact. It finds memory calls in stored tool rows of chats it reads, and compares the graph over time. A background review's add doesn't show either way.

### A local index

These reads let the app page through a profile.

- `GET /api/profiles/sessions?profile=all` lists every profile's chats on a host in one read, up to 500 a page with `offset`, newest activity first (`profiles.py:455`). Rows are tagged with their profile. The app doesn't use it yet.
- `GET /api/sessions?profile=` lists one profile, up to 100 a page (`sessions.py:182`).
- `GET /api/sessions/{id}/messages` reads up to 500 rows a page with `offset` and `order` (`sessions.py:743`, `:760`). It includes earlier compressed segments.
- `GET /api/sessions/{id}/timeline` lists user prompts with a real cursor, `after_row_id` and `next_cursor` (`sessions.py:805`).

The change markers are weak. A chat row has `last_active` and `message_count`, and `order=recent` sorts by `last_active`. No route takes "changed since". The store has keyset paging by message id (`hermes_state_messages.py:1372`), but the messages route offers only `offset`. No route lists deleted chats. To stay current, the app re-lists chats by `last_active`, re-reads each chat whose `last_active` or `message_count` moved, and re-lists everything to notice deletions.

### Where the research was wrong or incomplete

- Fable said results "open at the message". The search route returns no message id (`sessions.py:425`). The app has to read the chat to find the message.
- Fable's "at most its 100 best matches" holds (`sessions.py:303`). It is 100 chats, one hit each, and older matches can fall off before the app's date or model filter runs.
- Fable's index plan uses `GET /api/sessions`, which pages 100 at a time. It missed `GET /api/profiles/sessions`, which covers every profile in pages of 500 (`profiles.py:455`). It also missed that no read has a "changed since" marker.
- None of the research found the agent's own recall tool, `session_search`, which already returns message ids and profile links (`tools/session_search_tool.py:269`).
- Grok said Hermes knows a write's origin at approval time "and then throws that origin away". The staged record keeps `origin` until it is approved or rejected (`tools/write_approval.py:82`). It is lost once applied.
- Grok said the review queue's list might need a second Hermes change. The pending store exists at all three commits (`tools/write_approval.py:66`), with approve and reject through `/memory` (`tui_gateway/methods_tools.py:1005`). What is missing is a route that returns it as data.
- The combined idea and the brief say each queued write names its source chat. Neither a staged record nor an applied entry records one. A staged write from a chat can be joined to its chat through `pending_id` in the stored tool row. A background review write can't.
- Astra and ADR 0124 say Hermes has no provenance. That is true for the built-in files. Both missed that Hermes builds a full source record for every chat memory write and gives it only to external providers (`agent/background_review.py:755`).
- None of the research says background review writes leave no tool row in any chat (`agent/background_review.py:1018`). Inference from tool rows can never find them.
- Grok's points hold that the graph has no page size and that `PUT /api/learning/node` is the edit path.
- The app's own ADR 0118 and `src/hermes/memory.ts` name `f0d94882` as the server with the profile-scoped learning routes. `bf0203a` has the same routes, line for line (`hermes_cli/web_routers/status.py:693` to `:738` at `bf0203a`).

### On the owner's server

Everything above works on `bf0203a` and `f0d9488` as on `b200f5bc`. These are the differences.

- At `bf0203a` the `memory` tool also advertises the single-change shape. The app's reader of stored tool calls must accept both shapes. It must anyway, since the handler takes both at all three.
- At `bf0203a` and `f0d9488` the `session_search` tool lists 3 chats when called with no query, not 10. That only matters if Ask goes through a bot.
- At `bf0203a` the messages route lacks one display field for a withheld prompt. Nothing here reads it.

The feature must hide or explain these cases on every commit.

- Source links. Every source shown is inferred from tool rows, and is marked so. A background review write and an edit from a dashboard show "Source not recorded".
- With `memory.write_approval` off, the default, the queue holds only what a background review wanted to patch or remove, plus proposals staged earlier. The app reads the pending records whatever the setting. The queue says which case applies and how to turn the gate on.
- A locked deployment refuses the pending folder read. The queue falls back to the `/memory pending` text.

Three reads that change nothing tell the app which case it is in. `GET /api/sessions/search?q=&profile=` answers `{"results": []}` without touching the store (`sessions.py:297`), and proves the route. `GET /api/config?profile=` gives `memory.write_approval`. `GET /api/fs/list?path=<home>/pending/memory&profile=` shows whether the queue folder is readable. An absent folder answers an empty list with an error code, not a refusal (`files.py:1027`).

### What Hermes would need

Search, Ask and an inferred queue ship without a Hermes change. These changes would make sources exact. File them as issues.

- `GET /api/sessions/search` returning, per row, `match_message_id`, `match_timestamp` and `match_tool_name`. It would also take `offset`, `after`, `before` and `role`. The store already has every one (`hermes_state_search.py:292`, `:1257`).
- A source record per memory entry. The memory tool would keep `{session_id, message_id, tool_call_id, at, origin}` for each `add` and `patch`, keyed by entry fingerprint and written under the memory lock, as ADR 0124 proposes. The background review would record the reviewed chat's `session_id`, which the fork already holds (`agent/background_review.py:1019`). `PUT /api/learning/node` would record `origin: "dashboard"`. `GET /api/learning/graph` would return it on each memory node as `source`, and drop a `session_id` whose chat was deleted.
- `session_id`, `message_id` and `tool_call_id` on each staged record (`tools/write_approval.py:80`).
- `GET /api/memory/pending?profile=` answering `{records: [{id, action, target, summary, origin, created_at, payload, matched_entries, session_id}]}`.
- `POST /api/memory/pending/{id}/approve?profile=` with an optional `content` to approve an edited version, and `POST /api/memory/pending/{id}/reject?profile=`. Each answers the applied result and refuses a record that changed since it was listed.
- `GET /api/sessions?updated_after=<time>` and a list of deleted chat ids, so a local index can stay current. Exposing the store's `after_id` paging on the messages route would let it read only new rows.

### Open questions

- Does a memory write in an app chat prompt or stage when `memory.write_approval` is on? The inline prompt needs a per-thread callback (`tools/write_approval.py:237`). The survey found no `set_approval_callback` in `tui_gateway/` or `gateway/`, which suggests it always stages there. Check on a throwaway Hermes. Turn the gate on, ask the bot to remember something in an app chat, then run `/memory pending`.
- Does `GET /api/fs/read-text` read `<home>/pending/memory/<id>.json` on a default dashboard? Source suggests yes. Check on a throwaway Hermes with one staged write.
- Do a rewind and a compaction change a chat's `last_active` and `message_count`? Source didn't settle it. Check on a throwaway Hermes. Read the chat row, rewind a turn, read it again.
- Does `review.summary` reach the app when `dashboard.turn_isolation` runs the turn in a child process? Check on a throwaway Hermes with turn isolation on and a turn that saves memory.

## Rooms where bots work together

A room needs Hermes to keep a group chat of two to six bots, run each bot's turn when the owner or another bot mentions it, hold its approvals, and keep a log the app can read back. Bots on another server need a way to join. Hermes calls this a Group Chat. The owner's servers have most of it. `bf0203a` serves 18 of the 21 `groups.*` methods `b200f5bc` lists, and `f0d9488` serves 20 plus `groups.discard`. All four `bot_relay.*` methods are at all three commits.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `groups.capabilities` | `tui_gateway/methods_groups.py:224` | Yes, differs (18 methods listed) | Yes, differs (20 methods listed) | None | `v2026.8.31` (2026-08-31) |
| `groups.list` | `tui_gateway/methods_groups.py:354` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.create` | `tui_gateway/methods_groups.py:369` | Yes, same | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.state` | `tui_gateway/methods_groups.py:378` | Yes, differs (no `context`) | Yes, differs (no `context`) | None | `v2026.8.31` (2026-08-31) |
| `groups.send` | `tui_gateway/methods_groups.py:396` | Yes, same | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.rename` | `tui_gateway/methods_groups.py:527` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.context` | `tui_gateway/methods_groups.py:531` | No | No | None | `v0.22.7` (2026-11-03) |
| `groups.log` | `tui_gateway/methods_groups.py:535` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.disband` | `tui_gateway/methods_groups.py:432` | Yes, same | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.stop` | `tui_gateway/methods_groups.py:464` | Yes, same | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.approve` | `tui_gateway/methods_groups.py:472` | Yes, same | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.retry` | `tui_gateway/methods_groups.py:483` | Yes, differs (fewer params) | Yes, same | Room worker running | `v2026.8.31` (2026-08-31) |
| `groups.discard` | `tui_gateway/methods_groups.py:501` | No | Yes, same | Only when forwarded to a gateway | `v0.22.6` (2026-11-02) |
| `groups.attachment.upload` | `tui_gateway/methods_groups.py:411` | No | Yes, same | Room worker running | `v0.22.6` (2026-11-02) |
| `groups.attachment.download` | `tui_gateway/methods_groups.py:422` | No | Yes, same | Room worker running | `v0.22.6` (2026-11-02) |
| `groups.replicate` | `tui_gateway/methods_groups.py:542` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.replica_state` | `tui_gateway/methods_groups.py:548` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.promote` | `tui_gateway/methods_groups.py:553` | Yes, same | Yes, same | `confirm: true` | `v2026.8.31` (2026-08-31) |
| `groups.demote` | `tui_gateway/methods_groups.py:566` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.peer.invite` | `tui_gateway/methods_groups.py:258` | Yes, same | Yes, same | Approvals not off on the bot's profile | `v2026.8.31` (2026-08-31) |
| `groups.peer.revoke` | `tui_gateway/methods_groups.py:290` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `groups.peer.register` | `tui_gateway/methods_groups.py:305` | Yes, same | Yes, same | Room worker running; other server on `https` | `v2026.8.31` (2026-08-31) |
| `bot_relay.roster.sync` | `tui_gateway/methods_bot_relay.py:31` | Yes, same | Yes, same | None | `v2026.8.27` (2026-08-27) |
| `bot_relay.outbox.drain` | `tui_gateway/methods_bot_relay.py:56` | Yes, same | Yes, same | None | `v2026.8.27` (2026-08-27) |
| `bot_relay.deliver` | `tui_gateway/methods_bot_relay.py:67` | Yes, differs (`@hermes` lookup) | Yes, same | The target profile's gateway running | `v2026.8.27` (2026-08-27) |
| `bot_relay.reply` | `tui_gateway/methods_bot_relay.py:125` | Yes, same | Yes, same | None | `v2026.8.27` (2026-08-27) |
| `bot_relay.outbox.pending` event | `tui_gateway/contracts/events.py:867` | Yes, same | Yes, same | None | `v2026.9.14` (2026-09-14) |
| Forward to the profile's gateway | `tui_gateway/methods_groups_forward.py:147` | No | Yes, same | A ready gateway serves the profile | `v0.22.6` (2026-11-02) |
| Canonical `GROUP_METHODS` | `gateway/session_group_controls.py:13` | Yes, differs (no `groups.context`) | Yes, differs (no `groups.context`) | Canonical gateway protocol | `v0.22.3` (2026-10-21) |
| Legacy `/api/ws` dispatch | `tui_gateway/ws.py:387` | Yes, same | Yes, same | Dashboard with no session authority | `v0.22.3` (2026-10-21) |
| Room worker starts with the dashboard | `hermes_cli/web_server_app.py:88` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31), in another file until `v0.22.3` |
| Room log event kinds | `gateway/hosted_rooms.py:50` | Yes, differs (no lead or context events) | Yes, differs (same) | None | `v2026.8.31` (2026-08-31) |
| `message.member` payload | `gateway/hosted_room_discussion.py:72` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| Turn end events | `gateway/hosted_room_discussion.py:75` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| `member_activity` in `groups.state` | `tui_gateway/hosted_room_service.py:706` | Yes, differs (no `last_error`, `max_rounds`) | Yes, differs (no `max_rounds`) | None | `v0.22.5` (2026-10-23) |
| Room approval in `pending_actions` | `tui_gateway/hosted_room_driver.py:422` | Yes, same | Yes, same | None | `v2026.9.7` (2026-09-07) |
| Room approval takes `once` or `deny` | `tui_gateway/hosted_room_service.py:661` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| Member session `Group: <room_id>` | `tui_gateway/hosted_room_driver.py:945` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| Room store `shared-state.db` | `gateway/hosted_rooms.py:425` | Yes, same | Yes, same | None | `v2026.9.11` (2026-09-11) |
| Roster of 2 to 6 | `gateway/hosted_room_discussion.py:28` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `@handle` syntax | `gateway/hosted_room_discussion.py:41` | Yes, same | Yes, same | None | `v2026.3.30` (2026-03-30), in another file until `v2026.8.31` |
| Who answers first | `gateway/hosted_room_discussion.py:342` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| A bot pulls a peer in | `gateway/hosted_room_discussion.py:361` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `@user` needs-you (Hermes desktop) | `apps/desktop/src/plugins/hermes-bots/group-chat.ts:1784` | Yes, same | Yes, same | Client side only | `v2026.8.31` (2026-08-31) |
| Hermes desktop polls the room | `apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx:126` | Yes, same | Yes, same | Client side only | `v2026.9.11` (2026-09-11), in another file until `v0.22.3` |
| RoomLink refuses approvals off | `gateway/hosted_room_peer.py:262` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| RoomLink needs durable run storage | `tui_gateway/methods_groups.py:145` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `hosted_rooms.discussion` | `hermes_cli/config_defaults.py:2088` | No | Yes, same | None | `v0.22.6` (2026-11-02) |
| `room_link_url` | `gateway/config.py:626` | Yes, same | Yes, same | None. Unset by default | `v2026.8.31` (2026-08-31) |
| `HERMES_ROOM_LINK_URL` | `gateway/hosted_room_peer.py:310` | Yes, same | Yes, same | None | `v2026.8.31` (2026-08-31) |
| `POST /v1/room-members/invitations` | `gateway/platforms/api_server_room_grants.py:75` | Yes, same | Yes, same | Messaging gateway API server reachable | `v2026.8.31` (2026-08-31) |
| `GET /v1/room-members/capabilities` | `gateway/platforms/api_server_room_grants.py:76` | Yes, same | Yes, same | A room grant | `v2026.8.31` (2026-08-31) |
| `bot_mode.envelope_ttl_seconds` | `hermes_cli/config_defaults.py:1948` | Yes, same | Yes, same | None. Default 900 | `v2026.8.27` (2026-08-27) |
| `message_agent` tool | `tools/bot_mode_dm.py:39` | Yes, same | Yes, same | A Bot Chat | `v2026.8.27` (2026-08-27) |
| `bot_relay.deliver` forwards to the gateway | `tools/bot_live_delivery.py:72` | Yes, same | Yes, same | The target profile's gateway running | `v0.22.3` (2026-10-21) |
| `profiles.list` | `tui_gateway/methods_profiles.py:282` | Yes, same | Yes, same | None | `v2026.8.13` (2026-08-13) |
| `session.list` | `tui_gateway/methods_session.py:536` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.create` | `tui_gateway/methods_session.py:479` | Yes, same | Yes, same | None | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |
| `session.active_list` | `tui_gateway/methods_session.py:1138` | Yes, same | Yes, same | None | `v2026.5.28` (2026-05-28), in another file until `v2026.7.30` |
| `approval.respond` | `tui_gateway/methods_prompt.py:1332` | Yes, same | Yes, same | A live chat | `v2026.4.23` (2026-04-23), in another file until `v2026.7.30` |

### The methods, as the app would call them

Every `groups.*` and `bot_relay.*` method answers on the dashboard's legacy `/api/ws`. `methods_bot_relay.register` installs the room methods on the same server (`tui_gateway/methods_bot_relay.py:143` to `:152`), and the dashboard sends every request to `server.dispatch` when it has no session authority (`tui_gateway/ws.py:387`). Nothing on the dashboard filters them. This holds at all three commits.

At `b200f5bc` and `f0d9488` the dashboard first asks whether a ready messaging gateway serves the profile. If one does, it forwards the call there and answers with the gateway's reply (`tui_gateway/methods_groups_forward.py:147` to `:177`). Otherwise it runs the call itself. The `groups.peer.*`, replication, promote and demote methods always run locally (`:21`). At `bf0203a` there is no forwarding file. The dashboard always runs rooms itself.

**`groups.capabilities`** takes an optional `profile`. It answers `protocol_version` (2), `driver` (the room worker is running), `persistent_process`, `authority_gateway_id`, `room_link`, `features`, `methods` and `max_log_limit` (500) (`tui_gateway/methods_groups.py:247`). `methods` lists 21 names at `b200f5bc` (`:21`), 18 at `bf0203a`, and 20 at `f0d9488`. It is the one call that tells the app which verbs a server has.

**`groups.list`** takes `limit` (up to 500), `offset` and `include_disbanded`. It answers `{rooms, next_offset}` (`:354`). Each room has `room_id`, `name`, `members`, `authority_gateway_id`, `authority_epoch`, `revision`, `created_at`, `updated_at`, `latest_seq` and `disbanded_at` (`tui_gateway/contracts/groups_bot_relay.py:58`).

**`groups.create`** takes `room_id`, `name` and `members` (`methods_groups.py:368`). The client picks the `room_id`, and a repeat with the same id is a no-op. Each member is `{member_id, profile, handle, display_name?, target?}`. The worker checks the roster (`tui_gateway/hosted_room_service.py:553`). Errors are 4110 for a bad room, 4123 when the worker is down, and 5111 for anything else.

**`groups.state`** takes `room_id`. It answers `{room, context, driver_status}` (`methods_groups.py:378`). `driver_status` has `running`, `working`, `blocked`, `counts`, `pending_actions`, `member_activity`, `last_error`, `max_rounds` and `peer_routes` (`hosted_room_service.py:682`). At `bf0203a` and `f0d9488` there is no `context`, and `max_rounds` is missing. `bf0203a` also has no `last_error`.

**`groups.send`** takes `room_id`, `event_id` and `payload: {text, thread_id, attachments?}` (`methods_groups.py:396`, `gateway/hosted_room_discussion.py:220`). `event_id` is the client's retry key. The server maps it to its own id (`gateway/hosted_rooms.py:250`), so a resend never posts twice. Text is up to 64 KB. It answers `{event, client_event_id, accepted, driver_started}`. Errors are 4111, 4123 and 5112.

**`groups.log`** takes `room_id`, `since_seq` (default 0) and `limit` (default 100, at most 500). It answers `{events, cursor, latest_seq, has_more, authority}` (`methods_groups.py:535`, `gateway/hosted_rooms.py:1173`). Each event has `room_id`, `seq`, `event_id`, `kind`, `actor`, `payload` and `created_at` (`contracts/groups_bot_relay.py:44`).

**`groups.approve`** takes `room_id`, `member_id`, `task_id`, `execution_generation`, `choice` and `request_id` (`methods_groups.py:472`). All of them come from the approval's row in `groups.state` `pending_actions`. It answers `{approved: true, result}`. It refuses with 5119 when the approval is no longer pending.

**`groups.stop`** takes `room_id` and an optional `cancel_id`, and answers `{cancelled}` (`:464`). **`groups.retry`** takes `room_id`, `task_id`, and at `b200f5bc` and `f0d9488` also `member_id` and `execution_generation` (`:483`). **`groups.disband`** stops work, revokes peer routes and tombstones the room id for good (`:432`). **`groups.rename`** takes `room_id`, `event_id` and `name` (`:527`).

**`groups.context`** is only at `b200f5bc` (`:531`). It sets a room's purpose, shared notes, and routing (`everyone` or `lead`). Lead routing lives in `gateway/hosted_room_lead.py`, which the older trees don't have.

### Answers to the open questions

**1. Which methods each commit has.** The brief says these methods need Hermes 0.23 and are absent on the owner's server. Source says otherwise. `tui_gateway/methods_groups.py` and `methods_bot_relay.py` exist at all three commits. `bf0203a` lacks `groups.context`, `groups.attachment.upload`, `groups.attachment.download` and `groups.discard` on `/api/ws` (`bf0203a:tui_gateway/methods_groups.py:18`). Its canonical gateway does serve the attachment methods and discard (`bf0203a:gateway/session_group_controls.py:22`, `:26`). `f0d9488` lacks only `groups.context` (`f0d9488:tui_gateway/methods_groups.py:21`). Every shared method has the same params, result and error codes, except `groups.state` (no `context`) and `groups.retry` at `bf0203a` (only `room_id` and `task_id`, `bf0203a:methods_groups.py:448`).

**2. What turns rooms on.** Nothing. The dashboard starts the room worker on every boot in a background thread (`hermes_cli/web_server_app.py:76` to `:100`). There is no config key, plugin, feature flag or account. The `hosted_room_*` files mean rooms hosted by the owner's own gateway. The room store is a file on the server (`gateway/hosted_rooms.py:410`). A self-hosted server with no other account answers `groups.capabilities` in full. `driver` is `true` once the worker runs. `room_link.enabled` is `true` when the server has durable run storage and the profile's approvals are not off (`methods_groups.py:233` to `:246`, `gateway/hosted_room_peer.py:262`). Even then `room_link.endpoint` says `{available: false, reason: "not_configured"}` until `room_link_url` is set (`gateway/hosted_room_peer.py:283`). That setting only matters for a bot that joins a room on another server.

One catch for a probe. The first `groups.capabilities` call writes a secret file, `.room-link-grant-secret`, into the Hermes home if none exists (`gateway/hosted_room_peer.py:60` to `:76`). It is not a read that changes nothing.

**3. Legacy or canonical.** Both. See "The methods" above. The canonical gateway has its own list with per-method permissions (`gateway/session_group_controls.py:13`). It adds `seatable_profiles` to `groups.capabilities` (`:139`), which the legacy answer lacks.

**4. The events a room sends.** None are pushed. No room code emits a WebSocket event. The only push in this feature is `bot_relay.outbox.pending`, and it is for bot messages, not rooms (`tui_gateway/change_watcher.py:390`). The official Hermes desktop reads `groups.state`, then `groups.log` from its cursor, every 2 seconds (`apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx:96` to `:126`). The app must do the same. What the log holds (`gateway/hosted_rooms.py:50`):

- The owner's message is `message.user` with `{text, thread_id, attachments?}`.
- A member's message is `message.member` with `{discussion_event_id, member_id, member_index, round_index, task_id, thread_id, turn_id, text}` (`gateway/hosted_room_discussion.py:72`). Its `actor` has `kind: "member"`, `id`, `profile`, and `display_name` and `connection_id` when known. Hermes cuts a reply at 64 KB (`:34`).
- A member finishing is `turn.settled` with `message_event_id` and `passed`, or `turn.failed` with `error` and `reason_code`, or `turn.cancelled`, or `turn.deferred` (`:73` to `:77`). `passed: true` means the bot said "(pass)" and posted nothing.
- `room.activity` with status `settled` or `bounded` ends a discussion (`:81`). `member.unavailable` says a member could not be woken (`tui_gateway/hosted_room_prepare_stall.py:104`).
- A member starting has no log event. `turn.started` is an allowed kind, but nothing in `gateway/` or `tui_gateway/` writes it. The start shows only in `groups.state` `driver_status.member_activity`, as `{member_id, status: queued|running|stopping, thread_id, round_index, started_at, tool, progress_at}` (`tui_gateway/hosted_room_service.py:700`). A member's tool calls and streaming never reach a client. The member's session has no client socket (`tui_gateway/hosted_room_member_activity.py:3` to `:10`).
- An approval has no event. It shows in `groups.state` `pending_actions` (question 7).
- A mention of the owner has no event (question 6).

**5. Members.** A room holds 2 to 6 members (`gateway/hosted_room_discussion.py:28`, `:293`). Handles must be unique, and `all` and `everyone` are reserved (`:303`). A member is a profile on the same server by default. The worker checks it against the profiles under `profiles/` (`tui_gateway/hosted_room_service.py:185`). Each member answers in a hidden session in its own profile titled `Group: <room_id>`, with source `bot_room` (`tui_gateway/hosted_room_driver.py:943`, `:29`).

A bot on another server joins as a peer member through RoomLink, not through `bot_relay`. The steps, from source:

1. On the other server, `groups.peer.invite {profile, room_id, home_install_id, authority_gateway_id, authority_epoch, member_id, ttl_seconds}` mints a grant. It answers `{grant, target_profile, catalog, endpoint}` (`methods_groups.py:258`). `home_install_id` and the authority come from the home server's `groups.capabilities`. The grant lasts 60 seconds to 24 hours.
2. On the home server, `groups.create` seats that member with `target: {kind: "peer", peer_id, installation_id, profile, capability_digest}` (`gateway/hosted_room_discussion.py:63`, `:244`). `installation_id` and `capability_digest` come from the catalog.
3. On the home server, `groups.peer.register {room_id, member_id, target_url, target_profile, grant, catalog}` probes the other server and saves the route (`methods_groups.py:305`).

After that the home server calls the other server's API directly over HTTPS (`gateway/platforms/api_server_room_grants.py:75`, `tui_gateway/hosted_room_peer_http.py:577`). The app carries the grant and catalog once, at setup. A room keeps running when the app is closed, whether or not it mixes servers. The other server must have `room_link_url` set to an `https` address the home can reach (`gateway/hosted_room_peer.py:322` to `:345`). Its profile must not have approvals off (`:262`).

`bot_relay.*` is a different thing. It carries `message_agent` messages between bots in their Bot Chats on different connections (`tui_gateway/methods_bot_relay.py:1` to `:7`). The app is the courier. It pushes the roster of other connections' bots with `roster.sync`. When `bot_relay.outbox.pending` fires, it calls `outbox.drain` on the sender and `deliver` on the target. Then it calls `reply` on the sender. `bot_relay.deliver` needs a delivery `id` (`:73`) that the contract file leaves out. On the dashboard it does not run the turn. It forwards to the target profile's messaging gateway and refuses with 5094 `runtime_unavailable` when none runs (`:117` to `:122`, `tools/bot_live_delivery.py:72`). All of this stops when the app is closed. A message not drained within 900 seconds is refused as `queued_expired` (`tools/bot_relay.py:43`). It also means sending on background connections, which ADR 0125 forbids today.

**6. Mentions.** `@handle` matches a member's handle, case-insensitive (`gateway/hosted_room_discussion.py:41`). An owner message with no mention goes to every member, and `@all` or `@everyone` does the same (`:342` to `:358`, `:761` to `:767`). A mention narrows the first round to the members named. A bot pulls another in by writing its `@handle`. That member gets the next round, if it hasn't spoken since (`:361` to `:376`, `:829` to `:836`). A discussion stops after 3 rounds or 10 messages by default (`:30`, `:31`). `@user` means nothing to the server. Hermes desktop badges "needs you" when a member's text matches `/@user\b/i` (`apps/desktop/src/plugins/hermes-bots/group-chat.ts:1784`). The app can do the same from `message.member` text in `groups.log`, and raise it in the Inbox.

**7. Approvals inside a room.** A member's approval appears in `groups.state` `driver_status.pending_actions` as `{kind: "approval", task_id, execution_generation, run_id, session_id, request_id, approval, member_id}` (`tui_gateway/hosted_room_driver.py:417` to `:424`). The app answers with `groups.approve`. For a local member Hermes then calls `approval.respond` on the member's hidden session (`tui_gateway/hosted_room_service.py:672`). For a peer member it sends the answer to the other server (`:664`). Three things differ from a chat's approval. Only `once` and `deny` are allowed, never `session` or `always` (`:661`, `hosted_room_driver.py:419`). No `approval.request` event reaches the app. The worker keeps the pending approval in memory (`hosted_room_service.py:127`), so it shows again only after the worker polls the member session.

**8. Storage.** Rooms and their logs live in `shared-state.db` in the install's root home, shared by every profile (`gateway/hosted_rooms.py:410` to `:425`). Each member's turns also live in its hidden `Group: <room_id>` session. The read after a reconnect is `groups.state` for `room.latest_seq`, then `groups.log` with `since_seq` set to the last `seq` the app holds, repeated while `has_more` is true. Limits are 256 active rooms, 50,000 events a room, and 16 MB of events for the whole store. Disbanded rooms are kept 90 days (`gateway/hosted_rooms.py:36` to `:43`).

**9. The Bots view today.** The app calls `profiles.list` for the roster (`src/hermes/transport.ts:2060`, probed in `src/hermes/capabilities.ts:389`). It calls `session.list` by title, `session.create` and `session.title` to find or make each Bot Chat (`src/hermes/bots.ts:177`, `:213`, `:220`). It reads `session.active_list` for activity (`src/hermes/transport.ts:1756`) and answers approvals with `approval.respond` (`src/hermes/transport.ts:3637`). It calls no `groups.*` or `bot_relay.*` method. Rooms can reuse the roster for the member picker, using each profile's name and Bot Mode handle. They can reuse the Bots view rows, the Inbox's entry model (`src/hermes/inbox.ts`), and the approval card's look. They can't reuse `approval.respond`.

### Where the research was wrong or incomplete

- The brief, the combined idea and Fable say the owner's `bf0203a` server "will say no", so the feature stays hidden. It won't. `bf0203a` has 18 `groups.*` methods and all four `bot_relay.*` methods on `/api/ws`, and `f0d9488` has 21. Rooms of local bots can ship on the owner's server.
- Fable said a room that mixes servers "runs while the app is open, with the app carrying the messages". Rooms that mix servers use RoomLink, where the home server calls the other server directly (`methods_groups.py:305`, `tui_gateway/hosted_room_peer_http.py:577`). The app is needed only at setup. The courier role belongs to `bot_relay`, which carries Bot Chat messages, not room turns.
- Fable described `bot_relay.deliver` as running one Bot Chat turn on the target. On the dashboard it forwards to the target profile's messaging gateway and refuses when none runs (`tools/bot_live_delivery.py:72`). It also needs an `id` the contract leaves out.
- Fable listed `groups.context`. Neither owner commit has it. Fable missed `groups.discard`, `groups.replicate` and `groups.replica_state`.
- Fable said whether a dashboard serves `groups.*` itself or forwards it "has to be probed live". Source settles it. `bf0203a` always serves rooms itself. `b200f5bc` and `f0d9488` forward to a ready gateway for the profile and serve the rest themselves (`tui_gateway/methods_groups_forward.py:147`).
- The brief, the combined idea and Fable say "the bots you @mention answer". An owner message with no mention goes to every member (`gateway/hosted_room_discussion.py:761` to `:767`). A mention narrows it.
- All three treat `@user` as a server feature that raises "Needs you". The server does nothing with it. Hermes desktop matches the text on the client (`group-chat.ts:1784`).
- None says rooms have no push events. The app must poll `groups.state` and `groups.log`, as Hermes desktop does every 2 seconds.
- None says a room approval takes only `once` or `deny`, or that it appears only in `groups.state`.
- None says `groups.capabilities` writes a secret file on its first call.
- Grok's version is a handoff through kanban cards and A2A. It names no `groups.*` method.
- The app's own `docs/research/hermes-gateway-api.md:663` says bots talking to each other "isn't a client feature". For bots on the same server that holds. For bots on different connections the client is the courier (`tui_gateway/methods_bot_relay.py:1` to `:7`).
- The combined idea's member limit of two to six holds (`gateway/hosted_room_discussion.py:28`, `:29`).

### On the owner's server

On `bf0203a` and `f0d9488` the app can list, create, read, send to, rename, stop, retry and disband rooms of the owner's own profiles. It can answer their approvals with `groups.approve`, and add a member from another server with `groups.peer.*`. The feature must hide these:

- Room purpose, notes and lead routing (`groups.context`). Neither owner commit has it.
- Files in a room on `bf0203a` (`groups.attachment.*`). `f0d9488` has them.
- A member from another server, unless that server has `room_link_url` set and its profile has approvals on. `groups.peer.invite` on that server says which.
- `groups.discard` on `bf0203a`.

A `bf0203a` server also has no `hosted_rooms.discussion` setting. Its rooms always stop at 3 rounds and 10 messages.

The probe that changes nothing is `groups.state {room_id: "__hermes_chat_probe__"}`. A room error (4114) means Hermes has rooms. "Method not found" means it doesn't. The worker already made the room store at startup, so this read adds nothing. Then, when the owner opens Rooms for the first time, call `groups.capabilities` once. It gives `methods`, which tells `bf0203a` and `f0d9488` apart, and `driver`, which says whether rooms will run. That call can write `.room-link-grant-secret` the first time on a server where no client has called it. Say so in the ADR. Under the ground rules, the owner should agree to that one write.

### What Hermes would need

The first PR needs no Hermes change. These changes would make the feature better. File them as issues.

- A push event when a room changes, such as `groups.changed {room_id, latest_seq}` from the change watcher, so the app needn't poll every 2 seconds.
- A `groups.capabilities` that never writes, or a separate read-only `groups.probe` answering `{protocol_version, methods, driver}`.
- A pending room approval written to the room log, as `room.approval_requested {member_id, task_id, execution_generation, request_id, approval}` and `room.approval_resolved`, so it survives a worker restart and the app can read it from `groups.log`.
- A server-side mark for a member message that asks the owner, such as `mentions_user: true` on `message.member`, so "Needs you" doesn't depend on each client's text match.

### Open questions

- On `bf0203a`, both the dashboard and a messaging gateway may run a room worker on the same `shared-state.db` (`hermes_cli/web_server_app.py:88`, `gateway/run_startup.py:875`). Source shows leases on driver tasks, but doesn't settle that a room created through the dashboard is driven exactly once. Check on a throwaway `bf0203a` with both running. Create a room, send one message, and count `message.member` events per member.
- Whether the hidden `Group: <room_id>` member sessions appear in `session.active_list`, and so in the app's Inbox and bot activity. Check on a throwaway Hermes. Start a room turn and read `session.active_list`.
- Whether a peer route outlives its 24-hour grant without the app. Source shows the home server refreshing grants (`tui_gateway/hosted_room_peer_http.py:591`). Check on two throwaway servers with a short `ttl_seconds`.
- Whether `groups.approve` for a peer member works when the other server's approvals are `smart`. Check on two throwaway servers.

## Talk to the gateway directly

The feature asks Hermes for two things. It needs an address the app can sign in to whose `/api/ws` speaks the canonical session protocol, and a canonical verb for each of the 58 JSON-RPC methods the app sends. ADR 0174 and `src/hermes/canonicalVerbs.ts` already map those methods, checked at `f0d94882`. This section re-checks that map at `b200f5bc` and `bf0203a` and reports what moved.

The short answer is that the map holds at `b200f5bc` and `f0d9488`, and the owner's `bf0203a` server can't serve the feature at all. `f0d9488` is the commit ADR 0174 checked, and `b200f5bc` is one day newer. The protocol's files are byte-identical between them except for one new config key. `bf0203a` has the same canonical handlers, but it has no Webapp, so no address the app signs in to speaks the canonical protocol.

Line numbers are at `b200f5bc` unless a row says otherwise. The survey TSV has the line at each commit. For a method the canonical socket hands to the legacy handler (`canonicalVerbs.ts` route `fallback`), the row cites the legacy handler, because that is what answers. For a method the canonical socket refuses, the row is named `old → new` and cites the canonical verb that replaces it.

| Item | At `b200f5bc` | `bf0203a` | `f0d9488` | Gate | Added in |
|---|---|---|---|---|---|
| `client.capabilities` | `tui_gateway/methods_voice.py:522` | Yes, differs | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.21` (2026-09-21) |
| `gateway.capabilities` | `tui_gateway/methods_voice.py:514` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `gateway.ping` | `tui_gateway/ws.py:695` | Yes, same | Yes, same | None | `v2026.8.27` (2026-08-27) |
| `gateway.ready session_authority` | `tui_gateway/ws.py:647` | Yes, same | Yes, same | The socket has a session authority | `v0.22.3` (2026-10-21) |
| `session.create` | `gateway/session_controls.py:218` | Yes, same | Yes, same | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `session.resume` | `gateway/session_controls.py:233` | Yes, differs | Yes, same | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `prompt.submit` | `gateway/session_controls.py:234` | Yes, same | Yes, same | Canonical socket; session attached by this connection | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `session.interrupt` | `gateway/session_controls.py:237` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.events.since` | `gateway/session_controls.py:237` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.close` → `session.detach` | `gateway/session_controls.py:233` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.title` → `session.mutate rename` | `hermes_state_mutations.py:49` | Yes, same | Yes, same | Canonical socket; expected_revision | `v0.22.3` (2026-10-21) |
| `session.cwd.set` → `session.mutate workspace` | `hermes_state_mutations.py:28` | Yes, same | Yes, same | Canonical socket; expected_generation; not mid-turn | `v0.22.3` (2026-10-21) |
| `session.branch` → `session.mutate branch` | `hermes_state_mutations.py:18` | Yes, same | Yes, same | Canonical socket; expected_generation | `v0.22.3` (2026-10-21) |
| `session.undo` → `session.mutate rewind` | `hermes_state_mutations.py:44` | Yes, same | Yes, same | Canonical socket; expected_generation | `v0.22.3` (2026-10-21) |
| `session.compress` → `session.mutate compress` | `hermes_state_mutations.py:38` | Yes, same | Yes, same | Canonical socket; expected_generation | `v0.22.3` (2026-10-21) |
| `session.status` → `session.info` | `gateway/session_controls.py:222` | Yes, differs | Yes, same | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `session.list` | `gateway/session_controls.py:222` | Yes, same | Yes, same | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `session.active_list` | `gateway/session_controls.py:267` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.context_breakdown` | `gateway/session_tui_ops.py:33` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `approval.respond` | `gateway/session_controls.py:238` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `approval.received` | `gateway/session_ancillary.py:29` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `clarify.lock` | `gateway/session_controls.py:273` | Yes, same | Yes, same | Canonical socket; batch clarify only | `v0.22.3` (2026-10-21) |
| `request.answer` | `tui_gateway/methods_prompt.py:1296` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.14` (2026-09-14) |
| `image.attach_bytes` | `gateway/session_controls.py:259` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `image.detach` | `tui_gateway/methods_prompt.py:1140` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `file.attach` | `gateway/session_ancillary.py:32` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `model.options` | `gateway/session_config.py:13` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `config.get` | `gateway/session_config.py:12` | Yes, differs | Yes, differs | Canonical socket | `v0.22.3` (2026-10-21) |
| `config.set` | `gateway/session_tui_config.py:26` | Yes, differs | Yes, differs | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `config.set model` → `session.mutate model` | `hermes_state_mutations.py:13` | Yes, same | Yes, same | Canonical socket; expected_generation | `v0.22.3` (2026-10-21) |
| `profiles.list` | `gateway/session_controls.py:350` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `profiles.get_asset` | `tui_gateway/methods_profiles.py:450` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `llm.oneshot` | `gateway/session_llm_oneshot.py:37` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `commands.catalog` | `gateway/session_controls.py:219` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `command.dispatch` | `gateway/session_controls.py:221` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `command.dispatch /steer` → `session.steer` | `gateway/session_busy_controls.py:13` | Yes, same | Yes, same | Canonical socket; a running turn | `v0.22.3` (2026-10-21) |
| `slash.exec` | `gateway/session_controls.py:221` | Yes, same | Yes, same | Canonical socket | `v2026.9.7` (2026-09-07), in another file until `v0.22.3` |
| `prompt.btw` | `gateway/session_tui_side.py:28` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `tools.show` | `gateway/session_ancillary.py:32` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `subagent.list` | `gateway/session_ancillary.py:27` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `subagent.tail` | `gateway/session_ancillary.py:27` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `subagent.steer` | `gateway/session_ancillary.py:34` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `subagent.interrupt` | `gateway/session_ancillary.py:35` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `subagent.roster` | `tui_gateway/methods_subagents.py:114` | No | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v0.22.6` (2026-11-02) |
| `projects.list` | `tui_gateway/methods_projects.py:81` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `projects.create` | `tui_gateway/methods_projects.py:91` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `projects.update` | `tui_gateway/methods_projects.py:72` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `projects.delete` | `tui_gateway/methods_projects.py:111` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.7.1` (2026-07-01), in another file until `v2026.9.7` |
| `projects.add_folder` | `tui_gateway/methods_projects.py:75` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `projects.remove_folder` | `tui_gateway/methods_projects.py:77` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `projects.membership.list` | Not in any tree | No | No | None | Not in Hermes |
| `projects.membership.apply` | Not in any tree | No | No | None | Not in Hermes |
| `learning.frames` | `tui_gateway/methods_tools.py:1332` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `learning.detail` | `tui_gateway/methods_tools.py:1357` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `learning.edit` | `tui_gateway/methods_tools.py:1357` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `learning.delete` | `tui_gateway/methods_tools.py:1357` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.7` (2026-09-07) |
| `display.status` | `tui_gateway/methods_display.py:50` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.24` (2026-09-24) |
| `display.start` | `tui_gateway/methods_display.py:81` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.24` (2026-09-24) |
| `display.observe` | `tui_gateway/methods_display.py:149` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.24` (2026-09-24) |
| `display.lease.acquire` | `tui_gateway/methods_display.py:239` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.24` (2026-09-24) |
| `display.lease.release` | `tui_gateway/methods_display.py:256` | Yes, same | Yes, same | Canonical socket, legacy fallback (interactive grant) | `v2026.9.24` (2026-09-24) |
| `session.mutate` | `gateway/session_controls.py:223` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `clarify.respond` | `gateway/session_controls.py:238` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `prompt.receipt` | `gateway/session_controls.py:235` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `prompt.cancel` | `gateway/session_controls.py:235` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `prompt.steer_queued` | `gateway/session_queued_controls.py:34` | Yes, same | Yes, same | Canonical socket; a running turn | `v0.22.3` (2026-10-21) |
| `prompt.replace_queued` | `gateway/session_queued_controls.py:35` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `prompt.resolve_unknown` | `gateway/session_controls.py:236` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `runtime.describe` | `gateway/session_controls.py:218` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `admission dedupe on submission_id` | `hermes_state_runtime.py:159` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `approval.request` | `gateway/session_pending_controls.py:38` | Yes, same | Yes, same | Canonical socket; attached viewer | `v0.22.3` (2026-10-21) |
| `clarify.request` | `gateway/session_pending_controls.py:51` | Yes, same | Yes, same | Canonical socket; attached viewer | `v0.22.3` (2026-10-21) |
| `approval.settled / clarify.settled` | `gateway/session_pending_controls.py:63` | Yes, same | Yes, same | Canonical socket; attached viewer | `v0.22.3` (2026-10-21) |
| `session.info event` | `gateway/session_authority.py:479` | Yes, same | Yes, same | Canonical socket; attached viewer | `v0.22.3` (2026-10-21) |
| `session event envelope` | `tui_gateway/contracts/canonical_sessions.py:301` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.automation` | `gateway/session_controls.py:269` | Yes, differs | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.export` | `gateway/session_tui_ops.py:26` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `session.stats` | `gateway/session_controls.py:265` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `cron.status` | `gateway/session_controls.py:228` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `cron.cancel` | `gateway/session_controls.py:229` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `command.observe` | `gateway/session_controls.py:220` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `rollback.session_diff` | `gateway/session_tui_ops.py:32` | Yes, same | Yes, same | Canonical socket | `v0.22.3` (2026-10-21) |
| `PATCH /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:930` | Yes, same | Yes, same | Dashboard sign-in; request_id + expected_revision | `v2026.6.5` (2026-06-05), in another file until `v2026.7.30` |
| `DELETE /api/sessions/{session_id}` | `hermes_cli/web_routers/sessions.py:850` | Yes, same | Yes, same | Dashboard sign-in; request_id + expected_revision | `v2026.4.13` (2026-04-13), in another file until `v2026.7.30` |
| `webapp.enabled` | `hermes_cli/config_defaults.py:986` | No | Yes, same | Gateway home config.yaml; hermes gateway run | `v0.22.6` (2026-11-02) |
| `Webapp listener plan` | `gateway/webapp_listener.py:200` | No | Yes, same | Webapp.enabled true | `v0.22.6` (2026-11-02) |

### Answers to the open questions

**1. Which commit the ADR checked, and what moved.** ADR 0174 and `canonicalVerbs.ts:5` say `f0d94882`, which is the `f0d9488` tree. Every row of the map is the same at `b200f5bc`. The files that carry the protocol are byte-identical between the two: `tui_gateway/ws.py`, `tui_gateway/ws_legacy_fallback.py`, `gateway/session_controls.py`, `tui_gateway/contracts/canonical.py`, `tui_gateway/contracts/canonical_sessions.py`, `hermes_state_runtime.py` and `hermes_state_mutations.py`. The only change a client can see is a new `daybreak` key for `config.get` and `config.set` (`gateway/session_config.py:101`, `gateway/session_tui_config.py:193`). Every source line ADR 0174 cites still points at the same code at `b200f5bc`.

At `bf0203a` these rows no longer match what the ADR or `canonicalVerbs.ts` says:

- `session.resume` ignores `omit_messages` and its snapshot has no `open_requests` (`bf0203a` `gateway/session_controls.py:617`). `b200f5bc` honours both (`:671`, `:703`).
- `session.events.since` answers without `open_requests` (`bf0203a` `:688`, `b200f5bc` `:751`).
- `session.info`, the replacement for `session.status`, has `browser_backend_notice` and no `usage` (`bf0203a` `tui_gateway/contracts/canonical.py:172`, `b200f5bc` `:174`).
- The seven refused rows answer `unknown method: <name>` (`bf0203a` `gateway/session_controls.py:311`). `canonicalVerbs.ts` expects the longer wording that adds "not available on this Hermes backend" (`b200f5bc` `tui_gateway/contracts/registry.py:58`). The live test would fail those rows on the message alone.
- `subagent.roster` is not in `bf0203a` on either protocol. The survey searched the whole tree for `"subagent.roster"`.
- `client.capabilities` has no `canonical_clarify_batch` (`b200f5bc` `tui_gateway/methods_voice.py:541`), and `runtime.describe` lists no `clarify-batch-v1` (`bf0203a` `gateway/session_controls.py:501`, `b200f5bc` `:548`).
- A resend with a changed payload is refused `admission_conflict` with no `field` (`bf0203a` `hermes_state_runtime.py:153`). The ADR tells a duplicate apart by `field: request_id`, which arrives only from `b200f5bc` and `f0d9488` (`hermes_state_runtime.py:38`, `:159`).
- `prompt.cancel` leaves a started message running (`bf0203a` `tui_gateway/contracts/canonical.py:65`). At `b200f5bc` it stops it in the same call (`gateway/session_controls.py:883`).

Two rows of the map say less than the source does, at all three commits. `session.branch` becomes `session.mutate` `branch` with `{title?, through_message_id?}`, and `through_message_id` is a stored row id, "never a visible-message count" (`hermes_state_mutations.py:58`). The app sends a count (`src/hermes/transport.ts:2467`), so the adapter has to turn the count into a row id. `session.undo` becomes `rewind` with `target_message_id`, also a row id (`hermes_state_mutations.py:44`).

The ADR also lists the dashboard's REST session edits as a canonical difference. They aren't. `PATCH` and `DELETE` on `/api/sessions/{session_id}` go through `_mutate_session_request`, which refuses an edit with no `request_id` and `expected_revision` before it looks for a session authority (`hermes_cli/web_server_sessions.py:287`). A standalone dashboard refuses it the same way, at all three commits (`bf0203a` `:273`). The app already sends both on every edit (`src/hermes/transport.ts:4963`, `:4985`). The adapter needs nothing new for them.

**2. Which process speaks it, and how `gateway.ready` says so.** At all three commits `handle_ws` adds `session_authority: true` to `gateway.ready` when the socket has a session authority (`tui_gateway/ws.py:647`, `bf0203a` `:552`). The app reads that flag (`src/hermes/capabilities.ts:565`). Only the gateway's own listener sets an authority (`gateway/run_api.py:97`, `bf0203a` `:70`). A standalone `hermes dashboard` or `hermes serve` has none, so it is legacy at all three (`hermes_cli/web_routers/chat_ws.py:665`).

What changed is which gateway listener the app can reach.

- At `b200f5bc` and `f0d9488`, `webapp.enabled` in the gateway home's config moves the gateway's listener to `webapp.host` and `webapp.port`, `127.0.0.1:9120` by default, and serves the dashboard there (`gateway/webapp_listener.py:1`, `gateway/run_runtime.py:584`, `hermes_cli/config_defaults.py:986`). A wildcard bind is behind the dashboard sign-in. This is the address ADR 0174 signed in to.
- At `bf0203a` there is no Webapp. `gateway/webapp_listener.py` doesn't exist, and no `webapp` config key is defined. The survey searched the tree for `webapp.enabled`, `"webapp"` and `def listener_plan`. The gateway starts its listener on 127.0.0.1 with a port the system picks (`gateway/run_runtime.py:499`, `gateway/run_api.py:138`). That listener never publishes the dashboard's session token (`gateway/run_api.py:67`), and native clients sign in with tickets from the gateway's control socket (`gateway/run_api.py:341`). The app's password sign-in has no canonical address to reach on this server.

`docs/compatibility.md` "Chats and the session protocol" reads `f0d94882` correctly. It should add that a `bf0203a` gateway has no Webapp address.

**3. The research's claims, checked in source.**

- *A queued message goes to the server at once and runs with the app closed.* True of Hermes's queue at all three commits. `prompt.submit` with `queued: true` writes a row to `session_admissions` and answers with its receipt (`hermes_state_runtime.py:171`). A session whose last viewer leaves stays open until its queue is empty (`gateway/session_viewer_close.py:7`, `:34`). The developer guide says the same, that closing every viewer "leaves the execution and its pending approval alive" (`website/docs/developer-guide/gateway-local-sessions.md:31`). Hermes holds at most 32 queued messages per chat and then refuses `queue_full` (`hermes_state_runtime.py:127`). There is no reorder verb (`gateway/session_queued_controls.py:4`). ADR 0174 step 4 keeps the app's own queue (ADR open question 3), so the plan as written doesn't deliver this until the app's queue moves onto Hermes's.
- *Every send gets a receipt, so "may have been sent" goes away.* Mostly. Every `prompt.submit` answers an admission whose status is `queued`, `started`, `unknown` or `terminal` (`tui_gateway/contracts/canonical.py:35`). A lost answer is resent with the same `submission_id` and payload, and Hermes returns the admission it already made (`hermes_state_runtime.py:157`). But `unknown` remains. It is a turn whose outcome the owner lost, for example across a gateway crash, and the chat's queue waits behind it until someone discards it with `prompt.resolve_unknown` (`gateway/session_controls.py:897`, comment at `hermes_state_runtime.py:165`). The map has no row for `prompt.resolve_unknown`. The app still needs an "outcome unknown" state with a Discard button.
- *A chat running in Telegram or a cron job is the same live session.* Partly shown in source. `session.resume` on a messaging chat attaches to the chat its platform turns stream to (`gateway/session_controls.py:647`). A viewer's typed text in a messaging chat is admitted as a turn (`gateway/session_controls.py:795`). Approval and Clarify prompts are session events, so every attached viewer gets them (`gateway/session_pending_controls.py:38`, `:51`). A cron run is an ordinary admission in the same ledger (`gateway/session_cron.py:4`). Source doesn't settle whether the app's password sign-in may read a Telegram chat, or whether a cron run's chat shows in `session.list` with `scope: live`. See Open questions.

**4. What ADR 0174 lists as refused or shaped differently, and what `b200f5bc` offers instead.** All 14 are the same at `f0d9488`.

| App method | Canonical answer | What `b200f5bc` offers |
|---|---|---|
| `session.close` | `-32601` | `session.detach {session_id, subscription_id, end_reason?}` (`gateway/session_controls.py:714`) |
| `session.status` | `-32601` | `session.info {session_id}` (`tui_gateway/contracts/canonical.py:206`) |
| `session.title` | `-32601` | `session.mutate` `rename` `{title}` (`hermes_state_mutations.py:49`) |
| `session.cwd.set` | `-32601` | `session.mutate` `workspace` `{cwd}`, refused mid-turn (`hermes_state_mutations.py:28`) |
| `session.branch` | `-32601` | `session.mutate` `branch` `{title?, through_message_id?}` (`hermes_state_mutations.py:18`) |
| `session.undo` | `-32601` | `session.mutate` `rewind` `{target_message_id}` (`hermes_state_mutations.py:44`) |
| `session.compress` | `-32601` | `session.mutate` `compress` `{focus?, partial?, keep_last?}` (`hermes_state_mutations.py:38`) |
| `prompt.submit` | `4001 invalid_params` without `submission_id` | The same verb with `submission_id` or `input_id` (`gateway/session_controls.py:822`) |
| `session.interrupt` | `stale_generation` | The same verb with `execution_generation` (`tui_gateway/contracts/canonical_sessions.py:265`) |
| `approval.respond` | `invalid_params` on `request_id` | `{session_id, execution_generation, prompt_id, choice}` (`gateway/session_controls.py:925`), and `clarify.respond` with `answer` (`:931`) |
| `session.resume` | `invalid_params` on `inline_images` | The same verb without it, with `omit_messages` if the app pages history (`tui_gateway/contracts/canonical_sessions.py:70`) |
| `session.create` | `invalid_params` on `messages`, `reasoning_effort`, `fast` | `reasoning` and `service_tier` (`tui_gateway/contracts/canonical_sessions.py:21`). No way to seed hidden messages |
| `config.set` `model` | `use_session_mutation_model` | `session.mutate` `model` `{model, provider?, confirm?, reasoning?}` (`hermes_state_mutations.py:13`) |
| `command.dispatch` `/steer` | `unsupported_command` | `session.steer {session_id, execution_generation, text}` (`gateway/session_busy_controls.py:13`) |

Every `session.mutate` takes `request_id` and `expected_revision`, and most operations also take `expected_generation` (`tui_gateway/contracts/canonical.py:82`). A conflict carries the fresh revision and generation, so one retry needs no re-read (`gateway/session_controls.py:845`).

**5. How `tools/canonical-gateway.py` starts a real gateway.** It takes an IPv4 `127.x.x.x` other than `127.0.0.1` and refuses anything else, because Hermes turns the sign-in gate off on that one literal (`tools/canonical-gateway.py:58`). It makes a new, empty Hermes home under `~/.cache/hermes-canonical-runs/`, refuses the owner's `~/.hermes`, and writes a `config.yaml` with the stub model, `approvals.mode: manual` and `webapp.enabled: true` (`:196`, `:204`). It then replaces `gateway.webapp_listener.listener_plan` so the listener binds the given address and serves a one-line page, and runs `hermes gateway run --force` in-process (`:214`, `:229`). The script names no Hermes commit. It needs whatever Hermes its Python imports to have `gateway.webapp_listener.listener_plan(home)` returning `(host, port, mount, reason)`. `b200f5bc` and `f0d9488` have it with that shape (`gateway/webapp_listener.py:200`). `bf0203a` doesn't have the module, so the script stops at the import. `canonicalVerbs.ts:5` records the answers from `f0d94882`.

**6. Anything newer at `b200f5bc` that changes the plan.** Nothing. There is no new required param, renamed verb or handshake step between `f0d9488` and `b200f5bc`. `execution_generation` was already required at `f0d9488`, and the map has it. The only other changes in the protocol's files are tool progress kept per session for rooms (`gateway/session_events.py:33`) and a `groups.context` verb for rooms (`gateway/session_group_controls.py:20`). Neither touches a row.

**7. Whether Hermes says the legacy protocol will be removed.** Not found. The survey searched every `.py` and `.md` file in `b200f5bc` for "deprecat", "sunset", "will be removed", "to be removed" and "retire" near "legacy", "dispatch", "canonical" or "ws". No source or doc in the tree gives a removal or a schedule. The nearest lines are a comment that a standalone dashboard's "owner cutover is a follow-up" (`hermes_cli/web_server_sessions.py:112`, same at all three), and a legacy `hermes serve` handing one typed prompt to the gateway when the gateway owns the chat (`tui_gateway/owner_forward.py:1`). The Desktop's own protocol notes say the canonical side "exposes a narrower RPC set than the full Desktop application" (`apps/desktop/docs/canonical-gateway-protocol.md`, "Cutover limits"). "Hermes plans to move everyone to this protocol" is a reading of the follow-up comment, not a plan Hermes states.

### Where the research was wrong or incomplete

- All three versions mark Hermes support "ready". That holds at `f0d9488` and `b200f5bc`. It does not hold on the owner's `bf0203a`, which has no Webapp and so no canonical address the app can sign in to (`gateway/run_runtime.py:499`).
- The combined idea says a send "can never be doubled" and "may have been sent" goes away. Doubling is ruled out by `submission_id` (`hermes_state_runtime.py:157`). An `unknown` admission remains, and only `prompt.resolve_unknown` clears it (`gateway/session_controls.py:897`).
- The combined and Fable versions say a queued message runs with the app closed. Hermes's queue does (`gateway/session_viewer_close.py:7`), but ADR 0174 step 4 keeps the app's queue, so the plan delivers it only once the app's queue moves.
- Fable, quoting ADR 0174, says the dashboard's REST session edits are refused on the canonical side. The same fence applies to a standalone dashboard at all three commits (`hermes_cli/web_server_sessions.py:287`), and the app already meets it (`src/hermes/transport.ts:4963`).
- Fable says it is unclear whether a client can list, edit or reorder what Hermes has queued. Source settles it. Pending messages come in the resume snapshot and `session.info` events with their allowed `controls` (`tui_gateway/contracts/canonical_sessions.py:91`). `prompt.replace_queued` edits one by putting the edit at the back, and `prompt.steer_queued` hands one to the running reply (`gateway/session_queued_controls.py:34`, `:35`). Hermes has no verb to reorder the queue, which is one queue per chat (`gateway/session_queued_controls.py:4`).
- Fable's extra verbs all exist at all three commits: `session.automation`, `session.export`, `session.stats`, `cron.status`, `cron.cancel`, `command.observe` and `rollback.session_diff`. `session.automation` differs at `bf0203a`, which lacks the heartbeat calls.
- Fable places adapter work in `src-tauri/src/transport.rs`. ADR 0174 decides that Rust doesn't change, and source agrees. The Webapp listener uses the same dashboard sign-in (`gateway/webapp_listener.py:6`).
- None of the research says that `session.branch` and `session.undo` need stored row ids instead of the app's count (`hermes_state_mutations.py:58`), that `session.create` takes a `request_id` for a safe retry (`tui_gateway/contracts/canonical_sessions.py:22`, `website/docs/developer-guide/gateway-local-sessions.md:25`), or that `prompt.resolve_unknown` is needed. The map lacks all three.

### On the owner's server

Nothing in this feature works on `bf0203a`. Its gateway has the canonical handlers, but the only listener that speaks them is on 127.0.0.1 with a random port and ticket sign-in, so the app has nowhere to point. The feature must stay hidden there, and the existing refusal (`ProtocolMismatchError`) already does that. A standalone dashboard keeps speaking the legacy protocol on `bf0203a`, so the owner's current setup keeps working.

On `f0d9488` the owner could turn on `webapp.enabled` and sign in to the gateway's address, which is exactly what ADR 0174 tested. The adapter would then work as the map says.

The probe is the one the app already has. `gateway.ready` either carries `session_authority` or it doesn't (`tui_gateway/ws.py:647`), and `facts.protocol` holds the answer (`src/hermes/capabilities.ts:797`). Once the canonical side is connected, `runtime.describe` tells the adapter what the owner offers. It answers with `capabilities` such as `durable-admission-v1` and `clarify-batch-v1`, and with the sources and parameters `session.create` takes (`gateway/session_controls.py:547`). It changes nothing.

### What Hermes would need

None for the adapter at `b200f5bc` or `f0d9488`. These would close the gaps ADR 0174 leaves open. File them as issues.

- A way to seed hidden messages when a chat is created. Either the canonical `session.create` accepts `messages: [{role, content, display_kind: "hidden"}]`, or `prompt.submit {session_id, submission_id, text, display_kind: "hidden", run: false}` stores a message without starting a turn and answers its admission. Project instructions and Referenced chats need it (ADR 0174 open question 1).
- A `created_source` the app can set, for example `session.create {…, created_source: "hermes-chat"}`, so its chats aren't filed as Hermes Desktop's (ADR 0174 open question 2).
- `prompt.receipt {session_id, submission_id}` returning the admission, so a client that lost the answer doesn't have to resend the whole payload to learn it.

### Open questions

- Whether a password-signed dashboard identity may `session.resume` a Telegram or Discord chat and answer its Approvals. Source shows the attach path (`gateway/session_controls.py:647`) but not the grant for a messaging chat. Check on a throwaway gateway with a stub messaging platform. Start a turn from the platform side, resume it from the app's identity, and answer an Approval.
- Whether a cron run's chat shows in `session.list` with `scope: live` while it runs. Check on a throwaway gateway with a one-minute cron job.
- Whether the admission dedupe holds across a reconnect. It keys on the principal (`hermes_state_runtime.py:156`), and source doesn't show that a password sign-in gets the same principal each time. Check by dropping the socket after a `prompt.submit`, reconnecting and resending the same `submission_id`.
