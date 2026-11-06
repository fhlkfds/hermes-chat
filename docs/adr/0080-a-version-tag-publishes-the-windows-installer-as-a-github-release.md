# A version tag publishes the Windows installer as a GitHub release

ADR 0069 built the Windows installer only as a workflow artifact, which expires and needs a GitHub sign-in to download. The owner asked for it on the repo's Releases page. The first one, `v0.1.0`, was published by hand from the `windows-installer` run of the commit `main` had then.

## Decisions

- **Pushing a `v<version>` tag publishes.** `windows.yml` also runs on `v*` tags. After the `nsis` job builds the installer, a `release` job attaches it to the tag's GitHub release, creating the release if the tag has none. It is the only job in the repo with `contents: write`, and the workflow's default is `contents: read`.
- **The tag must match the built version.** `tauri build` names the installer from `tauri.conf.json`'s version, and `scripts/release/windows-release.sh` refuses a tag that doesn't match it, so a release always holds the build of the version it names. This is docs/releases.md's rule that every release bumps the version and is tagged `v<version>`.
- **Stable asset names.** The installer is renamed `hermes-chat_<version>_x64-setup.exe` (no spaces, which GitHub would rewrite) and gets a `.sha256` beside it.
- **Rerunning replaces, never duplicates.** A release that already exists keeps its notes and gets its two assets replaced (`--clobber`). A tag with a prerelease part (`v0.3.0-beta.1`) makes a prerelease.
- **The script is tested without GitHub.** `scripts/release/windows-release.test.sh` runs it against a stand-in `gh` in CI's `frontend` job and before every publish.

## Known limits

- The installer is still unsigned (ADR 0069), so SmartScreen warns.
- A Windows copy doesn't update itself. The owner runs a newer installer.
- These releases carry no `latest.json`, so the AppImage updater endpoint (`releases/latest/download/latest.json`, ADR 0075) finds nothing on them. No released build turns the updater on yet. When AppImage releases start, their publishing step must attach to the same tagged release, so the newest release carries both.
- The publish path itself (a real tag push) wasn't run before merge. The script was checked against the stand-in `gh`, and the workflow with actionlint.
