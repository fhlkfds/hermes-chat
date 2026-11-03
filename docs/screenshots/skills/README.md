# Skills screenshots

Captured on 2026-11-03 from the running Tauri debug application (WebKitGTK, `tauri build --debug --no-bundle`) on an
Xvfb display, at the app's 1280 × 820 window. These are framebuffer captures, not browser mockups, and nothing was
composited or retouched. They come from this branch's working tree before its first commit. The changes after them don't
alter what the images show. One puts a full stop after Hermes's quoted reason in an error, so image 7's message now
reads "Internal Server Error. Your edit is still here." The others are the review's fixes: stricter front matter name
checks, platform lists matched by declared names, element ids, and the conflict actions turned off while a save runs.

The app was signed in by URL (`http://127.0.0.2:9369`) to a **throwaway Hermes dashboard**. It was run on the Hermes
server from the deployed checkout (`f0d9488`: the checkout moved from `bf0203a` to it during this work, and the skill
routes are the same in both), with its own `HERMES_HOME` and `HOME` under `/tmp/hc69`, a scrubbed environment, and a
synthetic password. The `spare` profile was made for this. It holds two synthetic local skills (`release-notes`, with a
`references/` and a `templates/` file, and `spare-brief`), and a shared folder, `/tmp/hc69/shared-skills`, named in its
`skills.external_dirs`, with a synthetic `house-style`. The 39 Built in skills are the ones Hermes itself copies into a
new profile. The real dashboard, its profiles and its skills were not used. Every list, read, save, refusal and switch
shown is a real answer from Hermes's own routes. `api-check.log` has the curl checks and the files on disk after each
step.

1. `1-skills-list.png`: the `spare` profile's skills, Local first, with source, scope (the shared one marked) and
   switches. `spare-brief` was just turned back on and read back. The server's `config.yaml` then had
   `skills.disabled: []`, and before that `[spare-brief]` (see the log).
2. `2-editor-unsaved.png`: `release-notes` open, with its path on the server, scope, source and state, and an unsaved
   edit. The front matter's unknown `x-fixture` field and its comment are there as the file has them, and they were
   still there after saving.
3. `3-validation-error.png`: the closing `---` deleted. The editor says what to fix and keeps the edit, and Save is off.
   (Hermes's own check refuses the same, `400 Frontmatter must include 'description' field.` for another case, in the
   log.)
4. `4-missing-file.png`: the body now names `templates/changelog.md`, which the skill's folder doesn't have. Save
   checked through `GET /api/files` and wrote nothing (`references/style.md` was found). The owner can fix the path or
   choose Save with missing files.
5. `5-conflict-both-versions.png`: while the edit was open, another client saved the skill through
   `PUT /api/skills/content` (curl, in the log). Save found the change before writing, wrote nothing, and shows the
   server's version beside the edit. Merge into my edit then combined both, and Save wrote it. The file on disk had the
   other client's `version: 1.1.0` and line, and the edit's new line.
6. `6-restore-previous.png`: Restore previous version put back the text that save replaced, as an unsaved edit. The
   tooltip is the button's, under the pointer.
7. `7-denied-write.png`: the shared skill's folder made read-only on the server. Hermes's write failed with an unhandled
   500 (`PermissionError` in its log). The read-back found the file unchanged, so the app says the save failed and keeps
   the edit.
8. `8-disconnected.png`: the throwaway dashboard stopped with the edit open. Save and Reload are off and the edit stays.
   The app reconnected by itself when the dashboard came back, with the edit intact, and Save then wrote it.

Not shown from the real server: a lost answer settled by reading back, and an identity clash between two skills. Both
are covered by `src/hermes/skills.test.ts`. The sidebar's 503 is the throwaway `spare` profile having no session store;
it isn't part of this change.
