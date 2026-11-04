# Memory: Restore previous version (#70 step 5)

Captured on 2026-11-04 from the running Tauri debug application (WebKitGTK, `tauri build --debug --no-bundle` of
`1ac002e`), on an Xvfb display. These are framebuffer captures (`import -window root`), not browser mockups, and nothing
was composited or retouched. The editor-focus change that came after (`Restore` moves focus to the editor) isn't
visible in a still image.

The app was signed in by URL to a **throwaway Hermes dashboard** (`127.0.0.2:9471`), started from a `git archive` of
the deployed `f0d9488` checkout, with its own `HOME` and `HERMES_HOME` under `/tmp/hc70`, a synthetic password, and
only synthetic memory. Every entry shown is made up. Reads, saves and the conflict are real answers from Hermes's own
`learning.*` code over `/api/ws`. The "other client" in image 6 is a direct write to the throwaway `MEMORY.md`, as the
agent's memory tool would make.

1. `1-saved-restore-offered.png`: an entry saved and read back; Restore previous version is now offered.
2. `2-restore-asks-over-unsaved-edit.png`: Restore pressed with an unsaved edit open asks first ("Keep editing" has
   focus). The tooltip names when the save it undoes was made.
3. `3-restored-in-editor.png`: after Discard edit, the text the save replaced is in the editor, unsaved; nothing has
   changed on the server.
4. `4-restore-saved.png`: Save put it back, read back from Hermes. The server's `MEMORY.md` was checked on disk, and
   Hermes's own `MemoryStore().load_from_disk()` (what a new session's prompt is built from) showed the restored text.
5. `5-duplicate-refused.png`: an entry edited to another entry's exact words: Save is disabled and the editor says why
   (Codex review round 1).
6. `6-restore-conflict-kept.png`: Restore again, then another writer changed the entry before Save. Nothing was
   written, the other writer's text stayed on the server, and the restored text is kept to copy or place.
7. `7-narrow-window.png`: the window at its narrowest (about 760 px) after a save; the action row wraps.
