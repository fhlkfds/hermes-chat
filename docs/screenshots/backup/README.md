# Backup and restore screenshots (issue #75, ADR 0033)

Captured on 2026-11-04 from the running Tauri debug build of this branch (`tauri build --debug --no-bundle`,
WebKitGTK) on an Xvfb display, 1280 × 820, driven with xdotool. These are framebuffer captures; image 5 stacks crops of
six captures, and nothing else was composited or retouched. The scripts are in `setup/`.

The app was signed in by URL to a **real Hermes dashboard**: Hermes at `bf0203a` (`git archive`), started with a
throwaway `HOME`/`HERMES_HOME` under `/tmp`, a throwaway basic-auth login, bound to `127.0.0.2:19751`, with two
profiles (`default`, `work`) and synthetic chats seeded with Hermes's own `SessionDB` (`setup/seed.py`). No model ran.
Each "computer" was the same binary with its own `XDG_DATA_HOME` and D-Bus session, so it had no keyring: the password
was typed again after each restart, and the keyring warning at sign-in comes from that.

**Computer A** (`/tmp/hc75/A`). Through the UI: a New chat draft and a draft in "NAS disk usage" (`default`), a draft in
"Quarterly report outline" (`work`), the tag "Storage" on "NAS disk usage", the template "Port check", and the Ocean
theme. Then Export.

1. `1-export.png`: Export backup. Counts per category, what each holds, the personal data it holds and the two
   connections and profiles it names, and what is never in a backup. Saving gave a 4,764-byte zip, mode 0600, of nine
   stored entries (`manifest.json` and one file per category). The password `fixture-pass-123` isn't in it.

**Bad archives**, opened from Restore on computer A, made from that zip by `python3 zipfile`:

5. `5-refused-archives.png`, top to bottom: a byte flipped inside `drafts.json` (zip CRC), `drafts.json` edited and
   re-zipped (SHA-256 against the manifest), schema 2 (newer), an entry `../../.bashrc.json` (traversal), a 200 MB
   entry deflated to 200 KB (refused as compressed before anything is read; the per-entry 16 MB limit is covered by
   `backup.rs`'s tests), and the first 2,500 bytes only (cut short). Each said nothing was restored, and the app stayed
   as it was. These were taken before the last change, which drops the "Couldn't read it:" before the archive side's
   own message.

**Computer B** (`/tmp/hc75/B`), a fresh data folder: Setup, sign-in, a New chat draft typed first ("Typed on the new
computer first"), then the app's data folder made read-only (`chmod 555`, with `backups/` writable) to make a real
write failure.

2. `2-restore-preview.png`: the preview. File, when it was made, schema 1 with every checksum matched, the connection
   it goes to, both places mapped on their own (identical connection, profiles the server lists), and per category what
   happens. Settings is set to Replace; Drafts merges, so its one conflict (the New chat draft) keeps this computer's.
3. `3-restore-report-partial.png`: the report. Settings, Templates and Drafts restored; Tags failed (`tags.json` couldn't
   be written in the read-only folder), and no `tags.json` was written. The recovery backup held B's own draft. Read
   from the webview's storage afterwards: B's New chat draft kept, the two other drafts under their own profiles, the
   Ocean appearance and the template.
4. `4-restore-report-retry.png`: after making the folder writable and restarting, the same backup again: only Tags
   restored, the rest unchanged. Reload went back to the sign-in screen with the restored theme; after signing in,
   "NAS disk usage" had its restored draft in the composer (not sent) and the "Storage" tag in its menu. Settings still
   shows one conflict: the sticky model pick, which names the profile it was picked in (`work` on A, `default` on B).

Observed once: after the partial restore, Reload, with the folder made writable again just before, opened first-run
Setup with the default theme, though the webview's storage on disk held everything. A restart read it all, and the
next Reload, with the folder left writable, worked. It looked like WebKit's own storage not recovering from the folder
being read-only mid-session, which only this test did; it isn't explained further.

Not exercised live: queued messages, project membership and defaults, and branch origins (the dashboard had no model,
so nothing could queue or branch); a backup from another connection; restoring while a reply runs. Those are covered
by `src/hermes/backup.test.ts` and `src/ui/backup.test.tsx`.
