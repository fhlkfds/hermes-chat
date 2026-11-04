# Worktrees screenshots (#82, ADR 0041)

Captured on 2026-11-04 from the running Tauri debug build (WebKitGTK, frontend built in) on an Xvfb display with openbox. They're framebuffer captures of the 1280 × 820 window, or the 760-pixel window for `18` and `19`. They aren't mockups, and nothing was composited or retouched.

The chat list comes from a stand-in dashboard with synthetic chats (`bridge.ts` here, the tests' `FakeHermes`), signed in by URL. That stand-in answered `session.create`, `GET /api/fs/list` and `GET /api/sessions?cwd_prefix=`. Everything in the Repository screen is real. The app ran the system `ssh` to the real Hermes server (`liam@hermes`, Hermes `f0d9488`, git 2.47.3, Python 3.13.5), which ran the helper against a synthetic repository made for this, `~/hc-repo-demo/wt-demo/forecast`, with a bare remote beside it. Each result was checked afterwards with plain Git over ssh.

1. `1-empty.png`: the Worktrees view of a repository with only its main checkout. The checkout has a changed file and an untracked file.
2. `2-preview.png`: New worktree on a new branch `feature/hourly` from `main`. The preview shows:
   - the folder beside the repository and the base commit;
   - that the source checkout's changes stay there;
   - the two `.worktreeinclude` entries setup will copy and link;
   - that setup commands aren't run.
3. `3-created.png`: the streamed progress log. Afterwards on the server:
   - `git worktree list` showed it locked as `hermes-chat: managed worktree …`;
   - `.env` was copied and `node_modules` was a link to the main checkout's;
   - the main checkout's own changes were untouched;
   - `.git/hermes-chat/worktrees.json` said `ready`.
4. `4-new-chat-in-worktree.png`: Start a chat in it. The New chat pane shows the worktree as the chat's folder, chosen for this chat, and its branch, with Don't start it there.
5. `5-chat-shows-its-branch.png`: the chat, started with `cwd` set to the worktree, shows its branch in its header. The record on the server then had the chat attached, with its profile and connection.
6. `6-list-chat-attached.png`: the list, opened from that header label. The chat is named by its title, and Remove is disabled: "Chats work in it: detach them first".
7. `7-existing-branch-preview.png`: New worktree on the existing branch `release/2026.11`. A third `.worktreeinclude` entry, `secrets.local`, was made unreadable on the server.
8. `8-setup-failed.png`: the worktree is made, setup fails on that entry, and the worktree is kept with Open and Start a chat in it. This was captured again after the review fixes, with a third worktree, `feature/radar`.
9. `9-list-retry-setup.png`: the list shows Setup failed, the log, and Retry setup.
10. `10-setup-retried.png`: after `chmod 600` on the server, Retry setup finished it. The copied file shows as untracked, because `.gitignore` doesn't ignore it.
11. `11-detach-confirm.png`: a second ssh session made a commit and changed and added files in the worktree, standing in for the agent. The counts update, and Detach says the chat keeps working in the folder.
12. `12-remove-preview.png`: Remove's preview lists:
    - both changed files, which will be kept;
    - the commit no remote has, which stays on `feature/hourly`;
    - `.env`, which is ignored and goes with the folder;
    - a quiet chat that another Hermes app started in the folder, which needs the owner's tick.
13. `13-removed.png`: removed. On the server:
    - the folder and Git's entry were gone, and `feature/hourly` still had its commit;
    - `refs/hermes-chat/kept/…` held `NOTES.md` and the `src/forecast.ts` edit on top of it;
    - the main checkout's `node_modules`, which setup had linked to, was untouched.
14. `14-kept-changes.png`: the kept changes, with Restore in a new worktree.
15. `15-protected.png`: Protect on a worktree: Remove is disabled, and the list says why.
16. `16-removed-result-stays.png`: removing the release worktree, 15 seconds after it finished. Before the review fix (Codex round 1, finding 8), the app drawing again re-read the preview and replaced this result with "no record of that worktree". That happened in this same session, with the earlier build.
17. `17-restore-preview.png`: Restore in a new worktree: the base is the kept ref, with its subject.
18. `18-narrow-dialog.png` and `19-narrow-list.png`: a 760-pixel window. `19` is from the build before the last wording fix, so it still says "1 file that weren't committed".

Not pictured:

- The unsupported state (Git older than 2.36) and a Hermes that can't be asked about chats: the server has Git 2.47, so these are covered only by `src/ui/worktrees.test.tsx`.
- A dropped connection during creation: covered by killing the helper in `src-tauri/tests/repo_worktree.rs`, and by a fake in the UI tests. ssh wasn't cut by hand.
- The chat ran on the stand-in, so no model did any work in the worktree. The agent's work was simulated with Git over ssh.

The demo repository and the `feature/radar` worktree are left on the server, in `~/hc-repo-demo/wt-demo`.
