These are actual screenshots of the Tauri application running in a headless Sway session on 2026-11-02. The temporary verification harness changes the frontend entry point to mount the real Main against FakeHermes and reads local files through Rust. The capture, D-Bus shortcut, composer, attachment review, settings and file cleanup use the application code. The green overlay identifies requests received by the fake server. The terminal error is synthetic test content.

1. A real slurp picker opened by `hermes-chat --screenshot`.
2. The selected region is staged locally for review; the fake server has received nothing.
3. After Send, the fake server received `image.attach_bytes` and `prompt.submit`; the staged capture file was deleted.
4. Screenshot shortcut and desktop binding instructions in Settings.

The test session also exercised window selection, in-app Ctrl+Shift+S, cancellation, shortcut conflicts, no portal, private file permissions, and startup removal of an injected stale capture. Portal capture was exercised through real xdg-desktop-portal with the wlr backend while the application environment selected the portal path. This is not evidence of running native GNOME, KDE Plasma or Hyprland. No real remote Hermes server was used for these screenshots.
