# Repository Git runs a fixed helper over the owner's own ssh, with structured requests

The Repository screen (#66) reviews, and later stages and commits, pushes and opens pull requests for, a Git checkout on the Hermes server. Every Git operation runs on the server, in the folder the screen shows, never in a checkout on this computer. It goes through the owner's own `ssh`, as the Terminal does (ADR 0022). ssh runs one constant remote command: `python3 -I -c` with a helper program built into the app (`src-tauri/src/repo_git_helper.py`). The request travels on ssh's stdin as one JSON object. The helper builds `git` (and, for pull requests, `gh`) argument lists itself and runs them without a shell. The answer comes back as one JSON object on stdout.

So nothing the owner types, and nothing in a file name, a commit message or a pull request body, is ever read by a shell on either machine. The webview can ask only for the operations Rust's `repo_git::Request` names. There's no "run this command" request.

## Why not the dashboard's own Git routes

Hermes at `f0d9488` (deployed, read over SSH on 2026-11-03) has Git routes for the official desktop app's review pane: `hermes_cli/web_routers/git.py` over `hermes_cli/web_git.py`. They cover status, per-file diffs, stage and unstage of a whole file, commit, push, `gh pr create` and a PR list. They're the obvious contract, but they can't meet this feature's requirements:

- **Hooks are bypassed.** Every call runs with `noninteractive_git_env()` (`hermes_cli/_subprocess_compat.py`), which pins `core.hooksPath=/dev/null` and sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to `/dev/null`. A commit through `POST /api/git/review/commit` never runs `pre-commit` or `commit-msg`. The issue says hooks must never be bypassed implicitly.
- **The server's credentials aren't used.** The same environment blanks `credential.helper` and the global config. On this server, HTTPS pushes authenticate through `gh auth git-credential`, configured in `~/.gitconfig`, so `POST /api/git/review/push` can't push. The issue says to use the existing server-side credentials.
- **A commit can include files the owner didn't pick.** `review_commit` runs `git add -A` when nothing is staged, and nothing checks that the index is still the one reviewed.
- **Pull requests can't be edited.** `review_create_pr` runs `gh pr create --fill`, with no title, body or base, and pushes first, swallowing a failed push.
- **No hunks, no context, no old paths.** Diffs are fixed at three lines of context. There's no partial staging. Status drops a rename's old path, so a staged rename lists only its new path, and the deletion it carries isn't listed.
- `review/stage` passes the file to `git add` as a pathspec, so a file called `*.ts` would stage every TypeScript file. With no file at all, it stages everything.

The Repository screen uses none of these routes. A Hermes that changed them to run with hooks and the owner's config, took literal paths, refused `add -A`, and took expected HEAD and index values, would be a better contract than ssh. That is the backend design this decision records as missing:

- `POST /api/git/review/commit {path, message, expectHead, expectIndex}` runs `git commit -F -` with the owner's config and hooks. It refuses (409) when HEAD or the index changed or nothing is staged, and returns the hook output and the new commit.
- `POST /api/git/review/stage|unstage {path, files[], expectIndex}` takes literal paths.
- A `POST /api/git/review/apply {path, patch, reverse, expectIndex}` route stages hunks.
- `POST /api/git/review/create-pr {path, base, head, title, body}` never pushes.

## Considered options

- **The dashboard Git routes.** Rejected, as above.
- **Hermes's terminal tool, in a chat.** Rejected, as for the Terminal (ADR 0022): it runs as the agent, through Approvals, in a chat's history.
- **ssh with a quoted command line per operation** (`ssh host git -C '<path>' add -- '<file>'`). ssh hands its command line to the remote login shell, so every value would depend on quoting being right for whatever shell the owner has. Rejected for the constant command plus JSON on stdin.
- **A Rust SSH library.** Rejected, as for the tunnel: the system `ssh` brings the owner's config, agent, keys and known hosts.
- **Run Git on this computer.** Never: the repository is the server's.

## Consequences

- **What it needs on the server:** OpenSSH that the sign-in's key can reach without a prompt, `python3` 3.8 or newer, and `git` 2.13 or newer (porcelain v2 status with branch headers), all on the PATH a non-interactive ssh gets. Pull requests need `gh` signed in there (stage 3). A server without `python3` reports `unsupported` and says so.
- **Target.** By default the screen uses the Terminal's target, else the sign-in's SSH target. For a URL sign-in, which has neither, the owner types one, and it's kept on this computer (`hermes-chat.repo-target`). The screen trusts the owner that the target is the Hermes server.
- **No prompts.** ssh runs with `BatchMode=yes`, `-T` and `ClearAllForwardings=yes`. A key with a passphrase needs the agent. An unknown host key fails as `ssh-host-key`, and the screen says to accept it once in the Terminal. Host key checking is left to the owner's config, unlike the tunnel's `accept-new`.
- **It works while Hermes is away.** The screen needs ssh, not the dashboard connection.
- **It is the SSH user's Git.** The SSH user's `~/.gitconfig`, hooks and credential helpers apply, exactly as when the owner runs `git` over ssh by hand. The dashboard's `HERMES_DASHBOARD_FILES_ROOT` lock and credential denylist (ADR 0012) don't apply, as they don't to the Terminal. It can do nothing the owner's own `ssh` can't.
- **Reading changes nothing.** Status and diffs run with `GIT_OPTIONAL_LOCKS=0`, so a read doesn't refresh the index under an agent working in the same checkout. Every path goes to Git with `--literal-pathspecs`, so `*.ts` names one file.
- **Stage 1 (read-only).** The screen shows the top folder of the checkout that holds the folder typed, the branch or detached HEAD, its upstream with ahead and behind as of the last fetch, and any merge, rebase, cherry-pick, revert or bisect in progress. Files are listed as Conflicts, Staged, Changed (not staged) and Untracked, with a staged rename's old path, line counts, and binary and submodule marks. A file's diff is asked for one side at a time (staged, unstaged, untracked as all added, or a conflict's combined diff with the index stages Git holds), with 0, 3, 10 or 25 lines of context, or the whole file. Notices cover binary files, renames, copies, new and deleted files, mode changes, submodules, conflicts, and diffs over 2 MiB, which are cut. Up to 5,000 files are listed; more are counted as cut.
- **Errors are told apart** by kind: ssh's `ssh-auth`, `ssh-host-key`, `ssh-unreachable` and `ssh`; `unsupported`, `timeout` and `bad-reply` from the server; and `bad-path`, `not-found`, `not-repo`, `stale`, `git` and `internal` from the repository. Each shows ssh's or Git's own words beside a hint.
- **A late answer can't replace the current one.** Each status and diff read is numbered. An answer for an earlier folder, target or file is dropped.
- **Stored on this computer:** the folder opened last and the five most recent (`hermes-chat.repo-path`, `hermes-chat.repo-recent`), and the target (`hermes-chat.repo-target`), in webview local storage. No file contents, diffs or Git output are kept.
- **Each operation is a new ssh connection,** usually under a second on a LAN. Each request waits at most 60 s.
- **Verification limits.** The helper is tested by running the exact remote command through `sh -c` against real repositories (`src-tauri/tests/repo_git.rs`). ssh itself is exercised only by hand against the real server.
