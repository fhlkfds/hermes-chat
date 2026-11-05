# An update's restart writes its drafts whole and sets aside what it can't read

PR #61 added the update workflow: Settings checks for a newer version, pacman (or, for a standalone AppImage, Tauri's updater) installs it, and **Restart now** saves every draft, outbox and queue to `restart-drafts.json` in the app data folder before restarting. The next launch puts them back before the app first renders. Issue #102 verified that on a real pacman upgrade and asked to close what was left in recovery, stale requests and D-Bus ownership. This ADR records the rules that came out of it.

## The saved copy is written whole

`app_restart` writes the snapshot to `restart-drafts.json.part` (mode 0600), flushes it, renames it over `restart-drafts.json`, then flushes the folder. If any step fails, the part file is deleted and the app doesn't restart. Before, the file was written in place, so a full disk could leave half a snapshot that the next ordinary launch took for a restart's drafts.

## A copy that can't be read is set aside, never deleted or put back

At launch, `restart_drafts_read` returns one of three answers:

- none: there was no restart, or its drafts are all back;
- the text;
- unreadable: the file is there but isn't text.

The webview then checks that the text is a snapshot `snapshotDrafts` wrote: a JSON object whose draft, outbox and queue keys have string values. If the file isn't text or the text isn't such an object (cut short, garbled), nothing in it is put back, because any part of it may be older than what storage has. It is renamed to `restart-drafts-<time>.json`, the same as when storage is too full to take the drafts. Settings says why and where it is, and the gear shows the dot. Before, such a file was deleted at launch, or, if it wasn't UTF-8, kept the app on the "couldn't finish" screen with a Try again that could never succeed.

A set-aside name that is already taken gets `-2`, `-3` and so on, because a rename would replace the earlier copy without a word. Screenshot cleanup keeps every capture a set-aside copy refers to, as before.

Only a file that can't be opened at all (its permissions, the disk) still stops the app on the "couldn't finish" screen. Trying again can work once that is fixed, and opening over it would let the copy be put back later over newer drafts.

## A restart never forwards what started the app

The restart starts the same binary again with the original arguments, less `--screenshot`, `--show`, `--toggle` and any `hermes-chat://` chat link. With any of those, `main.rs` asks the Hermes Chat that owns `net.l0cky12.HermesChat` to do it and quits. Just after a restart, the copy that owns the name is the one exiting. So a copy started from a chat link would hand the link back to it and quit, leaving no app running. The link was already opened before the restart.

## GitHub gets 20 seconds

A package check that GitHub doesn't answer (or whose answer stalls) ends after 20 seconds with "GitHub didn't answer the update check in time". Until then the store is busy. While it is busy, the check that looks for pacman's install when the window is focused doesn't run, and neither does any other check.

## What a restart says it drops

The restart section of Settings says that drafts, unsent messages and queued messages are kept in every pane and tab, and that the app opens again with one pane. A second pane and its extra tabs are never kept between launches. It names the files attached in any composer, because a draft is text only and a screenshot staged there is deleted at the next launch. Composers report what they have attached to a small registry (`stagedFiles` in `unsaved.ts`). Settings reads it while it shows the restart section.

## Verification

Issue #102's PR ran the documented upgrade from a checkout (`git pull && packaging/aur/build.sh -si`), with the real pacman and a copy of the real package database. It ran in an unprivileged user and mount namespace (`tools/arch-update/sandbox.sh`), because the system install needs root. That covered package ownership and version detection, the binary replaced under the running app, refocusing, Restart, D-Bus ownership after it, and drafts, an uncertain message and a queue in split panes. The PR lists what this did and didn't cover.
