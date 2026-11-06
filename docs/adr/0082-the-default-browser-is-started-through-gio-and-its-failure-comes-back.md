# The default browser is started through GIO, and its failure comes back

Issue #255. On the owner's Arch desktop (Hyprland), Open in your browser in the link menu (ADR 0079) and on the Preview's refused-page note (ADR 0011) showed nothing and no toast. The link must open in the default browser of the computer running Hermes Chat, and a failure must say why.

The app ran `xdg-open <url>`, dropped its output, and counted a process still running after 3 seconds as success. In the real app on the build box, the command was reached, `xdg-open` got the app's own environment and the exact address, and it exited 0. But on Hyprland, Sway and every desktop `xdg-open` doesn't know, it uses its generic path: it finds the default browser's `.desktop` file, runs the browser in the foreground, and then calls `exit_success` whatever the browser returned (xdg-utils 1.2.1, the version Arch ships). A browser that failed with exit 1 and an error message left the app silent. A browser that started stayed in the foreground past the 3 seconds, so its later failure was silent too.

## Decisions

- **GIO picks and starts the browser.** `gio::AppInfo::default_for_uri_scheme` reads `mimeapps.list` the way `xdg-open` does. `launch_uris_as_manager_with_fds` expands the `.desktop` file's `Exec` with the address as one argument, never through a shell, and starts the browser as this app's child (`src-tauri/src/browser.rs`). GIO and GTK already come with the app, so nothing new is installed.
- **The browser's own result is the answer.** A browser that is already running takes the address and exits 0 at once. One that fails exits non-zero, and its last line of error output goes into the message ("Helium Browser stopped with exit code 1: …"). One still running after 3 seconds has the page. A spawn error (a missing program) and having no default browser are reported as they are. The error output is read to its end, so a browser that keeps running never blocks on a full pipe.
- **GTK's launch context goes with it.** The launch runs on the main thread with the display's `GdkAppLaunchContext`, so the browser gets an X11 startup id or a Wayland activation token. The desktop decides whether to bring the browser forward.
- **Success names the browser.** The link menu toasts "Opened in Helium Browser.", and the Preview shows the same line under its header. The owner's Hyprland sends the browser's windows to another workspace without focus, so a page that did open can look like nothing happened.

## Considered options

- **Keep `xdg-open` and read its output.** Rejected: on the generic path its exit status is always 0 once a browser is found, and it waits for the browser to exit.
- **`tauri-plugin-opener` or the `open` crate.** Rejected: `open::that_detached` starts `xdg-open` and returns without its result, so a failure is still silent. `open::that` waits for `xdg-open`, which waits for the browser.
- **xdg-desktop-portal's `OpenURI`.** Rejected for now: it needs the portal service running, and its answer says only that it started something. A Flatpak build would need it.

## Consequences

- Windows is unchanged: `ShellExecuteW` still opens the page and says nothing about which browser.
- Whether the browser comes to the front is the desktop's call. Hyprland's `misc:focus_on_activate` is off by default, so there the browser's workspace doesn't change; the toast says where the page went.
