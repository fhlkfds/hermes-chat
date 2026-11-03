# Server files: editing screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK, `tauri build --debug
--no-bundle`) on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched. The setup is
the one in `../server-files-download/README.md`: a real Hermes dashboard from the deployed `bf0203a` checkout with a
throwaway home and login, its files root locked to a folder of synthetic files. The file edited is a synthetic
`notes/deploy.conf`. The "other client" is a `sed -i` on the server's copy, run while the editor was open.

1. `1-diff-preview.png`: Review changes, from the file as opened to the edit. After Save, `diff` of the server
   file before and after showed exactly these two lines.
2. `2-remote-change.png`: `port` changed on the server while the editor changed `level`. Save found another
   revision, wrote nothing (the server file was byte-identical to the other client's copy after), kept the edit, and
   shows what changed on the server.
3. `3-merged-review.png`: after Merge, the review shows only the owner's change on top of the server's version.
   After Save, the server file had both `port = 9090` and `level = debug`.
4. `4-conflict-markers.png`: both sides changed `workers`. Merge keeps both between markers, and the note says
   to settle them before saving.
5. `5-discard-asks.png`: Cancel with unsaved changes asks first. Discard left the server's file as it was.
6. `6-saved.png`: saved and read back. The preview and listing show the file as Hermes has it now.

Images 1 to 5 come from this branch before its last commit, which reopens the preview from the listing read after a
save, so image 6's Modified time is current. The editor itself didn't change.
