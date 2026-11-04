# Repository screen screenshots (stage 1: read-only review)

Captured on 2026-11-03 from the running Tauri debug build (WebKitGTK) on an Xvfb display. These are framebuffer captures of the 1280 × 820 window (`7-narrow.png` is the window at 760 × 820, cropped to it). They aren't mockups, and nothing was composited or retouched.

The chat list comes from a stand-in dashboard with synthetic chats (`docs/screenshots/slash-commands/bridge.ts`), signed in by URL, so the screen asked for an SSH target. Everything in the Repository screen is real. The app ran the system `ssh` to the real Hermes server (`liam@hermes`), which ran the helper against two synthetic repositories made for this in `~/hc-repo-demo` on that server:

- `weather-api`: branch `feature/login`, one commit ahead of its upstream (a bare repository beside it), a staged rename, `src/auth.ts` with one change staged and another not, a changed binary file, and an untracked file.
- `conflict`: a merge stopped on a conflict in `config.yml`.

The screenshots:

- `1-repository.png`: the top folder, branch, upstream with ahead and behind, HEAD, and the files grouped as Staged, Changed (not staged) and Untracked, with the rename's old path, line counts and the binary mark.
- `2-staged-diff.png` and `3-unstaged-diff.png`: the same file's staged change and its unstaged change, each shown on its own.
- `4-binary.png`: a binary file's notice.
- `5-rename.png`: a staged rename, with both paths and Git's similarity.
- `6-conflict.png`: a merge in progress, and the conflicted file's combined diff with its markers and the versions Git holds.
- `7-narrow.png`: a narrow window: the diff goes under the list.
- `8-ssh-error.png`: a target that doesn't resolve. ssh's own message is shown under the app's.

Also checked by hand in the same build, not pictured: changing the context to none and to the whole file, Refresh, and the screen opening the last folder again when reopened.

## Stage 2: staging and committing

Captured the same way, later on 2026-11-03, against the same `weather-api` repository on the real server. Every write, commit and refusal below really happened there, and was checked afterwards with `git log`, `git show` and `git status` over ssh. The repository has a real `pre-commit` hook, Git's own whitespace check (`git diff --cached --check`), which prints a line first.

- `9-hunks.png`: `src/auth.ts` with two unstaged hunks, each with its own Stage hunk button. The first hunk (a comment with trailing spaces) was staged on its own; the server's index then held only that hunk.
- `10-commit-preview.png`: Review commit… before the second commit: the branch, the commit it goes on top of, the author, the hook that will run, the message exactly as it will be committed, the paired rename, and the whole staged diff.
- `11-commit-preview-binary.png`: a preview with a binary file and a new file.
- `12-hook-refused.png`: committing the hunk with trailing spaces. The `pre-commit` hook refused it, and its own output is shown. HEAD on the server didn't move, and the staged changes were still staged.
- `13-unstage-hunk.png` and `14-hunk-unstaged.png`: with no context lines, the staged diff splits into two hunks. Unstaging the first takes only it out of the index, back to Changed.
- `15-stale-commit.png`: a concurrent agent, simulated by `git add src/version.ts` in another ssh session, staged a file after the preview was read. Commit was refused as stale, nothing was committed, and Preview again then listed both files. The extra file was unstaged before committing.
- `16-committed.png`: a commit after the hook passed: the new commit, the hook that ran, and what Git and the hook printed. On the server, `git log` showed it on top of the commit the preview named, with the message verbatim and only the previewed file.

Not pictured: **Suggest a message** was exercised only against the stand-in dashboard, whose `llm.oneshot` answers with fixed text. So no screenshot shows a suggestion, and none came from a real model.

## Stage 3: push and pull requests

Captured the same way on 2026-11-03, against `~/hc-repo-demo/sandbox` on the real server. Its `origin` is a private GitHub repository made for this, [`l0cky12/hermes-chat-git-sandbox`](https://github.com/l0cky12/hermes-chat-git-sandbox), with a two-job CI workflow. Pushes used the server's own Git credentials (its `gh auth git-credential` helper), and pull requests used the server's `gh` sign-in. Nothing in this app holds a GitHub credential.

- `17-push-card.png`: after a commit made in the screen, the Push card shows the remote and its URL, the local and remote branch (new upstream), and the commit to push. The pull request form below already has the commit's subject as its title.
- `18-push-dialog.png` and `19-pushed.png`: Push shows the repository, remote, URL, the exact commit and the branch it goes to (new on the remote), then pushes. GitHub's answer is shown as Git printed it, and the remote was asked afterwards: `git ls-remote` on the server gave the same commit, and the branch now tracks `origin/feature/session-ttl`.
- `20-pr-api-failure.png`: creating the pull request into `old-release`, a remote-tracking branch this checkout remembered but GitHub doesn't have (set up with `git update-ref` to stand for a branch deleted on GitHub). GitHub refused, its own words are shown, the form kept everything, and nothing was pushed again: creating a pull request never pushes.
- `21-pr-form.png` and `22-pr-created.png`: the same form into `main`, then the created pull request, [#1](https://github.com/l0cky12/hermes-chat-git-sandbox/pull/1), with the title, description and base written in the form (checked with `gh pr list` on the server).
- `23-pr-status.png`: Refresh status a minute later: both CI checks passed, mergeable, no review yet, with links to each check's run.
- `24-push-rejected.png`: another clone pushed a commit to the branch first, then a new commit made here was pushed. GitHub rejected it (`[rejected] (fetch first)`), nothing was forced, and the remote still had the other commit afterwards.
- `25-existing-pr.png`: after a restart, the pull request already open for the branch is found and shown with its status, in place of the form. Its head is the other clone's commit.

Also checked, not pictured: a push to a GitHub repository the server's credentials can't reach was reported as `auth`, with GitHub's own `Repository not found` (run through the helper over ssh from a throwaway clone). Escape and Enter work in both dialogs, and focus moves to the dialog's button once Git finishes.
