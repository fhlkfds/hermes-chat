# A version tag also publishes a .deb beside the Windows installer

> **Accepted.** The build is the `deb` job in `.github/workflows/installers.yml`, the publish step `scripts/release/attach-release.sh` (tested by `attach-release.test.sh`), the package's settings `bundle.linux.deb` in `src-tauri/tauri.conf.json`, and the Settings text for a .deb install in `src/hermes/updates.ts`. It partly supersedes ADR 0080, whose workflow and script names no longer hold.

Since ADR 0080, a `v<version>` tag published only the Windows installer. The owner wants each release page to carry a Linux package as well, starting with v0.1.5, so someone on Debian or Ubuntu can install Highwing without building it. The AUR package (`hermes-chat-git`) builds from source and covers Arch only. AGENTS.md asks that a change adding a bundle format also add the step that attaches it to the tagged release.

## Decisions

- **One workflow builds every installer and one job attaches them all.** `windows.yml` (workflow `windows-installer`) is renamed `installers.yml` (workflow `installers`), since it is no longer Windows-only. Its jobs keep their ids, `rust` and `nsis`, and gain `deb`. The `release` job needs all three and attaches both files in one call. Two workflows each attaching on the same tag would race to create the release, and whichever won would write notes that name only its own file.
- **The .deb is built on Ubuntu 24.04 with `tauri build --bundles deb`.** The binary links against the glibc and WebKitGTK of the system it was built on, so the oldest system it runs on is the one it's built on: Ubuntu 24.04, Debian 13 and newer. 24.04 is the image the release dry run already builds the AppImage on. `bundle.active` stays false in `tauri.conf.json`: `--bundles` turns bundling on for the one format named, as it already did for `nsis`.
- **The job proves the package installs.** It installs the .deb on the runner with `apt-get install ./<file>` and fails when `ldd` finds a library the binary can't load. Pull requests that touch the app or the workflow run the job too, so a change that breaks the .deb shows before a tag does.
- **One attach script, one row per file.** `scripts/release/attach-release.sh <tag> <installer folder> <.deb folder>` replaces `windows-release.sh`. For each file it takes the folder, the end of the name `tauri build` gives it, which proves it was built as the tag's version (`_<version>_x64-setup.exe`, `_<version>_amd64.deb`), and the name it's published under, without spaces (`hermes-chat_<version>_x64-setup.exe`, `hermes-chat_<version>_amd64.deb`). Each folder must hold exactly one such file. Every file is checked before `gh` is called, so a bad .deb never leaves a release holding only the installer. Each file gets a `.sha256`. A new release's notes say how to install both. A release that exists keeps its notes and gets all four assets replaced (`--clobber`).
- **The package keeps the names ADR 0176 keeps.** The command is `/usr/bin/hermes-chat` and the icons are `hermes-chat` in hicolor, as in the AUR package. The launcher is the AUR package's `packaging/aur/hermes-chat.desktop`, used as Tauri's desktop template (`bundle.linux.deb.desktopTemplate`). So it has the same generic name, comment and keywords, the `hermes-chat://` link handler with `%u` (ADR 0037), and `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Tauri's own launcher had none of these and no category.
- **Tauri names the package and the launcher file after `productName`.** The package is `highwing` and the launcher `Highwing.desktop`. Tauri 2 has no setting for either. Overriding `productName` for the build would rename the app where Tauri shows its name. Neither name existed before, so nothing depends on it.
- **The package's Depends are what Tauri infers.** They are `libwebkit2gtk-4.1-0`, `libgtk-3-0` and `libayatana-appindicator3-1` (the tray). It recommends `openssh-client`, for sign-in through an SSH tunnel, and `desktop-file-utils`, whose trigger registers the link handler. `bundle.shortDescription` and `longDescription` fill its Description, which was `(none)`.
- **The package carries every icon the AUR package does.** Tauri installs only the bundle icons (32, 128 and 512 px, and a 256 px icon in a folder named `256x256@2` that icon themes don't read). `bundle.linux.deb.files` adds the hinted 16 to 64 px icons (ADR 0176), 256 px, the scalable icon and the symbolic icon.

## Considered options

- **A second workflow for Linux packages.** It would race the Windows workflow to create the release on every tag, and neither's notes would cover both files.
- **Uploading the .deb from its own job straight to the release.** The same race, inside one workflow.
- **Building on Debian 13 or Ubuntu 26.04.** The package would refuse to install on Ubuntu 24.04 LTS, which many Ubuntu desktops still run.
- **Building on Ubuntu 22.04.** It has `libwebkit2gtk-4.1` too, so the package would also install on Ubuntu 22.04 and Debian 12. Nobody has asked for those, and it is a one-line change to the job's `runs-on` if someone does.
- **An `.rpm` and the AppImage too.** Not asked for. The AppImage waits on the update key (ADR 0075). Each needs its own row in the attach script and its own job.

## Consequences

- A tag now waits for the `deb` job as well as the Windows ones, a few minutes more.
- A .deb install doesn't update itself. `tauri build` marks the binary's bundle type as `deb`, so `update_install_kind` reports `installer: "deb"`, and Settings → Launch, tray & updates says to install a newer .deb with apt. Before this it told a .deb install to pull and build again, as for a source build.
- The publish path itself (a real tag push) wasn't run before merge. The attach script was run against the stand-in `gh` with a real .deb built on Debian 13, and the workflow was checked with actionlint.
