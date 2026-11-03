# Artifact editor screenshots (issue #80, ADR 0029)

Captured on 2026-11-03 from the running Tauri debug build of this branch (`tauri build --debug --no-bundle`, WebKitGTK)
on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched.

The app was signed in by URL to a **real Hermes dashboard**: the deployed `bf0203a` (exported with `git archive`),
started for this check with a throwaway `HOME`/`HERMES_HOME` under `/tmp`, a throwaway basic-auth login, bound to
`127.0.0.2:19480`. Its model was a **local stub**: a small OpenAI-compatible server on `127.0.0.2:19481`, configured as
the profile's custom endpoint, that answers deterministically. Hermes itself ran for real against it: the chat's agent
called Hermes's real `write_file` and `read_file` tools on the file, and "Ask Hermes to edit" went through Hermes's
real `llm.oneshot` (with the chat's runtime session lending its model). The file and every text are synthetic. The
keyring warning at sign-in came from the isolated D-Bus session; nothing was stored.

The file is `/tmp/hc80/work/launch-plan.md`, which Hermes wrote with `write_file` in the chat "Beta launch plan". It
was opened from Outputs → Edit, then the app went back to the chat, so the editor is in the preview pane beside it.
Hashes are `sha256sum` of the file on the server, checked after each step.

1. `1-editor.png`: two manual edits (a fourth step and the owner's role). The header says which file, where it is
   (where the profile's tools run), which version the edit is based on (`94d212cf`) and that it isn't saved. The
   server file was still `94d212cf…`.
2. `2-patch-preview.png`: the Goal sentence selected (168 characters) and "Make it plain and say when" asked. Hermes's
   proposal is shown as a diff against the exact text the editor held when asked (version `94d212cf` with the unsaved
   changes), changing only the selection. Nothing changed in the editor or on the server.
3. `3-saved.png`: after Apply to the editor → Review changes → Save. The header's version is the file's SHA-256 read
   back from the server (`594b6d45…` here, equal to `sha256sum` of the server file). Taken last, after the other
   images, on the final build, which goes back to Edit after a save. The first save in the session (Hermes's
   sentence plus the two manual edits) gave `b56d6789…`, also checked with `sha256sum`.
4. `4-conflict.png`: a backup owner typed in the editor, while in the chat Hermes added a Risks section to the same
   file (`read_file`, then `write_file`; the server file became `8c1cd8bc…`). Save wrote nothing: the server file
   stayed `8c1cd8bc…`, the edit was kept, and the view shows what changed on the server. Merge, then Save, gave a file
   with both the Risks section and the backup owner (`9e83488d…`).
5. `5-versions.png`: Versions, kept in memory: as opened, each save, and the version found on the server. Compared
   here from "As opened" to the current text. Restoring the `b56d6789` version and saving it put the server file back
   to exactly `b56d6789…`.
6. `6-stale-patch.png`: "Upper-case it" asked for one step, then the owner kept typing (the stub took 6 s to answer).
   Apply was refused because the text had changed since the request, and nothing changed. Ask again asked for the
   same passage, and that proposal applied over the text as it now is.

Images 1, 2, 4 and 5 come from this branch before its last commit, which clears the Ask box after each request,
clears a note such as "Saved." once you type, and makes Ask again re-target the same passage. Images 3 and 6 are from
the final build. Hermes's own stale-write guard refused the chat's first `write_file` after the app's save
(`stale_write_blocked`), so the stub model was changed to read the file first, as Hermes asks.
