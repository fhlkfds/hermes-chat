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
