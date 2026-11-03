# Server files: Upload screenshots

Captured on 2026-11-03 from the running Tauri debug build of this branch (WebKitGTK, `tauri build --debug
--no-bundle`) on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched. The setup is
the one in `../server-files-download/README.md`: a real Hermes dashboard from the deployed `bf0203a` checkout with a
throwaway home and login, its files root locked to a folder of synthetic files, and a throttling TCP proxy so progress
stays on screen. Files were picked in the native GTK Open dialog.

1. `1-collision.png`: a local `readme.txt` picked while the folder already has one. The dialog shows the source and
   size, the server path, the file in the way, and Keep both selected by default (the next free name).
2. `2-replace.png`: Replace chosen, with the warning that Hermes's new file won't keep the old one's permissions.
   This was closed with Escape, and nothing was sent.
3. `3-progress.png`: a 25,000,000-byte upload at 44%, with both paths and Cancel.
4. `4-cancelled-then-done.png`: the transfers list. Keep both wrote `readme (2).txt` and left the server's
   `readme.txt` as it was. Replace then wrote it, and on disk the file became `-rw-------`, the gap ADR 0023
   records. The cancelled upload left nothing in the folder or the dashboard's temp folder. The finished one's
   `sha256sum` matched the local file.
5. `5-credential-refused.png`: a local `.env` picked. It's refused before anything is sent, and the server's
   own `.env`, which Hermes doesn't list, still held its original content.

Images 3 and 4 come from the previous build of this branch, before the dialog's layout fix (a `fieldset` legend
became a labelled `radiogroup`). The transfer rows they show are unchanged.
