# Memory editor screenshots

Captured on 2026-11-02 from the running Tauri debug application (WebKitGTK, built with `tauri build --debug --no-bundle`)
on an Xvfb display, at the app's 1280 × 820 window. These are framebuffer captures, not browser mockups, and nothing was
composited or retouched.

Images 4 and 5 were captured from a build of `134755a`, after the independent review's fixes; the others from a build
of `ef8f7ed`. The review's later changes don't alter what those other images show (they concern kept edits, lost
answers, navigation while a save runs, and a removal overlapping a Reload). All nine predate merging `main` (`5d0748f`),
so the rail in them lacks main's Server files and Scheduled jobs buttons; the Memory screen itself is unchanged.

The app was signed in by URL (`http://127.0.0.1:19331`, an SSH port-forward) to a **throwaway Hermes dashboard** run from
the deployed `bf0203a` checkout on the Hermes server, with its own `HOME` under `/tmp`, a synthetic password, and only
synthetic memory in two profiles (`default` and `research`). Every memory entry shown is made up. The real dashboard
and its profiles' memory were not used. Reads, saves, conflicts and refusals are real answers from Hermes's own
`learning.*` code over `/api/ws`; the "server" a second client wrote through is the same throwaway dashboard.

1. `1-memory-list.png`: Settings → Memory, naming the server, profile and file; both memory files and the entries.
2. `2-editing-unsaved.png`: an entry open with an unsaved edit.
3. `3-saved.png`: after Save, read back from Hermes. The server's `MEMORY.md` was checked on disk afterwards.
4. `4-conflict.png`: a second client changed the entry through `learning.edit` while it was open; Save found the
   conflict before writing, wrote nothing, and kept the edit.
5. `5-recovered-saved.png`: the kept edit put in the changed entry, merged with the newer text by hand, and saved.
6. `6-failed-save.png`: Hermes refused an edit over MEMORY.md's 2,200-character limit; the edit stays.
   (xdotool dropped a few typed characters at the end of the long text; the refusal is Hermes's own.)
7. `7-leave-guard.png`: New chat pressed with an unsaved edit open.
8. `8-disconnected.png`: the SSH forward killed with an edit open: Save and Reload are disabled and the edit stays.
   The app reconnected by itself when the forward came back, with the edit intact.
9. `9-other-profile.png`: the `research` profile, which `learning.*` can't reach. The sidebar's 503 is the throwaway
   server's: that profile has no session store there. It isn't part of this change.
