# Worktrees screenshots (#82)

Captured on 2026-11-04 from the running Tauri debug build of this branch (`tauri build --debug --no-bundle`, WebKitGTK) on an Xvfb display, 1280 × 820, driven with xdotool. `17-narrow.png` is the window at 760 × 820, cropped to it. These are framebuffer captures, not mockups. Nothing was composited or retouched.

Everything in them is synthetic, and every action really ran:

- **Hermes**: a real `hermes dashboard` from the deployed checkout (Hermes 0.22.6, `f0d9488`), with a throwaway `HOME` and `HERMES_HOME` under `/tmp/hc82/run` and a throwaway basic-auth login, bound to `127.0.0.2:19482` (`setup/dash.sh`). The app signed in to it by URL. Its model is a loopback stub that answers every completion with one fixed synthetic reply (`setup/llm.py`). No real model, chat or file was used, and the owner's `~/.hermes` wasn't opened.
- **The server's Git**: the Repository screen's helper ran over real `ssh`, through a throwaway `sshd` on `127.0.0.1:22822`, as the same user on this machine, with its own host key and client key. The app's `ssh` was the system one, reached through a wrapper on `PATH` that adds only `-F /tmp/hc82/ssh/config` (`setup/start-app.sh`). That is the one difference from a real server; every argument the app passes is unchanged.
- **The repositories**: `/tmp/hc82/srv/weather-api`, with a bare `origin`, an existing branch `feature/forecast-cache`, a `.worktreeinclude`, ignored `.env`, `node_modules/` and `config/local.toml`, and a dirty checkout (an edited `README.md` and an untracked `scratch.md`). `/tmp/hc82/srv/field-notes` has no worktrees (`setup/repo.sh`).

Each result below was checked on the "server" afterwards with `git worktree list`, `git for-each-ref`, the record in `.git/hermes-chat/worktrees.json`, and Hermes's `state.db`.

1. `1-empty.png`: a repository with no worktrees from Hermes Chat. The heading counts only those; the repository's own checkout is under Other worktrees.
2. `2-preview.png`: **New worktree…** → Preview for a new branch `docs/readme-units` from `main`. The exact folder (`…/weather-api.worktrees/docs-readme-units`), the branch (new, not tracking anything), the commit and subject it starts at, and the setup steps from `.worktreeinclude`. `config/defaults.toml` is skipped because Git tracks it. The open checkout's uncommitted changes are named, and they stay there.
3. `3-setup-failed.png`: making `fix/timeout` with the source `.env` made unreadable (`chmod 000`) first. The worktree was made, and Git's output is shown. The first step failed with the server's own `Permission denied`, the steps after it waited, and **Retry** and **Open** are offered. On the server: the worktree existed on `fix/timeout` at `1f592bd`, locked `hermes-chat <id>`, with no upstream, and the record had `.env: failed`, the others `pending`.
4. `4-setup-retried.png`: after `chmod 600`, **Retry** ran the failed step and the two after it. The link's step says Git lists it as untracked, because `.gitignore` has `node_modules/`.
5. `5-new-chat-in-worktree.png`: **Start chat here**. The New chat pane says the chat works in the worktree's folder, and why.
6. `6-chat-shows-worktree.png`: the chat after its first message, with the worktree's branch and folder above it. Hermes's `state.db` had the session's `cwd` as the worktree, and the record named the chat (its connection and profile, id and first message).
7. `7-list.png`: the agent's work simulated in the worktree (a commit, an edit, an untracked file). The card shows the changes, the commit no remote has, the setup, and the chat.
8. `8-remove-blocked-by-chat.png`: **Remove…** while the chat is recorded, and Hermes has it working in the folder. Both block. The preview still lists the files that would be kept, the unpushed commit that stays on the branch, and the ignored files that would be deleted.
9. `9-quiet-chat-still-blocks.png`: after **Detach** (the record then had no chats) and settling the chat, Hermes still has a chat working in that folder, so removal stays blocked. A quiet chat doesn't make the worktree disposable.
10. `10-remove-preview.png`: after archiving the chat, it's listed as archived and no longer blocks.
11. `11-removed.png`: **Keep changes and remove**. On the server: the folder was gone, `refs/hermes-chat/recovery/<id>/<time>` held `src/retry.ts`, `NOTES.md` and the `node_modules` link as one commit whose parent was the branch's unpushed commit, `fix/timeout` was still at that commit, and the source checkout's `node_modules` (the link's target) was untouched.
12. `12-removed-list.png`: the Removed list, with the recovery ref and the kept branch, and **Restore** and **Forget**.
13. `13-existing-branch-preview.png`: Existing branch `feature/forecast-cache`, checked out as it is.
14. `14-create-answer-lost.png`: the preview was read, then the `sshd` was stopped and **Create worktree** pressed. ssh couldn't reach the server, so the screen couldn't ask whether anything was made, and says so. Nothing is sent again on its own.
15. `15-created-after-try-again.png`: the `sshd` started again, then **Try again**, which sent the same request with the same id. The server then had exactly one `docs/readme-units` worktree and one record for it.
16. `16-protected.png`: **Protect**, then **Remove…**: blocked until unprotected.
17. `17-narrow.png`: a 760-pixel window. The cards' facts and buttons wrap, and nothing is cut off.
18. `18-restored.png`: `fix/timeout` removed again and **Restored**. On the server, the worktree was back on `fix/timeout` at its commit, with `src/retry.ts` changed and `NOTES.md` untracked, and locked again. Its setup shows 0 of 3 done: the ignored copies were deleted with the folder, so the steps are to run again.
19. `19-setup-after-restore.png`: **Run setup** copied `.env` and `config/local.toml` again. The link the kept changes brought back was already there and was left alone.
20. `20-ssh-unreachable.png`: a mistyped SSH target (`h`). ssh's own message is shown under the app's.

Shots 3 to 12 were taken with the first build of this branch. Before shots 1, 2 and 13 to 20, these were changed: the heading's count (it counted the repository's own checkout too, so `7-list.png` says 2 for one managed worktree), the empty list's wording (`12-removed-list.png` still says "yet"), the dirty-checkout note's wording, the lost-answer button (Try again, unless a create is known to have stopped part way), restore marking done setup steps to run again, and **Run setup** / **Retry setup** on a card running the steps when the dialog opens. Before that last fix, the dialog opened and ran nothing, which this run found.

Not pictured, covered by tests: a stale preview refused (`src-tauri/tests/worktrees.rs`, `src/ui/worktrees.test.tsx`), a chat attached by another task after the preview stopping the removal, another tool's lock, a checked-out submodule, an operation in progress, a record from a newer app, the panel's unsupported state, and an older read's late answer being dropped.
