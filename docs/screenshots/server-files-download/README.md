# Server files: Download screenshots

Captured on 2026-11-03 from the running Tauri debug build (WebKitGTK, `tauri build --debug --no-bundle` of this
branch) on an Xvfb display, 1280 × 820, driven with xdotool. Nothing was composited or retouched.

The app was signed in by URL to a **real Hermes dashboard**: the deployed `bf0203a` checkout, started for this check
with a throwaway `HOME`/`HERMES_HOME` under `/tmp`, a throwaway basic-auth login, bound to `127.0.0.2:19441`, and
`HERMES_DASHBOARD_FILES_ROOT=/tmp/hcfx/demo` (a folder of synthetic files). A small TCP proxy on `127.0.0.2:19442`
slowed the transfer to about 1.5 MB/s, so its progress stays on screen; it passes bytes through unchanged. No real
files were read or written. The keyring warning at sign-in came from the isolated D-Bus session; nothing was stored.

1. `1-progress.png`: a 30,000,000-byte file downloading, with the server path, the local path the owner picked, the
   size and percentage so far, and Cancel. When it finished, `sha256sum` of the server file and the download matched.
2. `2-overwrite-confirm.png`: downloading to a file that already exists; the native Save dialog asks first.
   Cancel there left the local file as it was.
3. `3-cancelled.png`: Replace, then Cancel halfway. While it ran, `ls` showed the hidden `.big-archive.bin.<pid>-1.part`
   beside the destination. After Cancel, the part file was gone and the local file still held `OWNER-COPY`.
4. `4-interrupted.png`: the proxy killed mid-download. The download fails with the reason, and the part file is
   removed. The listing is kept and dated while the app reconnects.
