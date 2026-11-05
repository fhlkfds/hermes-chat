# A release is rehearsed in CI with a throwaway key and never published there

PR #61 gave the app Tauri's updater for a standalone AppImage, with nothing to feed it: no key, no release, no endpoint. Issue #103 asked for the pipeline that would produce a signed release and the tests that show the app's verifier refuses a bad one, without publishing anything or creating a production secret. `docs/releases.md` is the procedure. This ADR records the rules behind it.

## The release config is a separate file merged at build time

`src-tauri/tauri.release.conf.json` holds the AppImage bundle, `createUpdaterArtifacts`, the endpoint, `requireSignedVersion` and the public key. `tauri.conf.json` keeps `bundle.active` off and has no `plugins.updater`. So `npm run app`, the PKGBUILD and every other build stay without the updater, and only a build that names the release config can update itself. Its `pubkey` stays empty until the owner makes the production key. A build with an empty key is refused by `dry-run.sh` rather than shipped unable to verify.

## The workflow rehearses and never publishes

`release-dry-run` builds, signs, stages, verifies and uploads the result as a workflow artifact. It has `contents: read` only, so it couldn't create a tag or release if it tried. It runs on pull requests that change it, so the PR that changes the pipeline proves it. A manual run can sign with the production secret, but still only uploads an artifact. Publishing is a separate step the owner adds and authorizes.

The default is a throwaway key made inside the job. It never leaves the runner's temporary folder, its lines are masked in the log, and the CLI reads it by path. The staged folder is checked for the key before upload.

## The app's own verifier is what the tests run

The verification tests drive `tauri-plugin-updater` with a manifest and AppImage served from `127.0.0.1`, through the same `check` and `download_and_install` the app's Install button calls. No checksum or minisign call of our own stands in for it. The signatures are fixed in the test file, made with throwaway keys that were deleted, so the tests need no key at run time. `scripts/release/verify.sh` uses minisign only to check a staged folder before upload, and is tested against broken folders in the same workflow. It also checks the AppImage's ELF architecture against the target `latest.json` lists it under, because the updater doesn't: a signed AppImage for another architecture would install and then not start.

`requireSignedVersion` is on, because the manifest isn't signed. Without it a manifest could pair a new version number with an older genuine AppImage.

## A package owns the AppImage, not the binary inside it

The app asks pacman about `$APPIMAGE` when it runs from one, and about the binary otherwise. Before, an AppImage was taken as standalone without asking, so a package that shipped the release AppImage would have had its file replaced by the updater. Now any copy whose file a package owns is reported as the package's. `update_check` and the install ask pacman again, not the answer from launch, and refuse if a package owns the AppImage by then. Settings then shows the existing message for a package other than `hermes-chat-git`: update it with the package manager.

## One key, rotated by a bridge release

Tauri's updater trusts one public key per build. Rotation goes through a release signed with the old key that carries the new key and a new endpoint file name. Old copies keep reading the old file, which keeps pointing at the bridge. A lost key can't be recovered through the updater, and owners download the new AppImage by hand.

## Rejected

- **Publishing from the dry-run workflow behind a flag.** One wrong input would publish. A separate, later step keeps "rehearse" and "release" apart.
- **The production key as an environment variable for the build.** Tauri's CLI accepts a path, which keeps the key's contents out of every process environment a tool might print.
- **A beta channel now.** It needs a second endpoint built into beta builds and a decision about who gets it. One stable channel is enough until there is a first release.
