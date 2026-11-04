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
