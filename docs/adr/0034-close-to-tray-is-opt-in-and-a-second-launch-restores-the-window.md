# Close to tray is opt-in, and a second launch restores the window

Issue #77 asks for a tray icon so the window can be hidden without losing quick access, and for closing to be explicit. Until now closing the window quit the app, and launching it again started a second copy with its own webview storage (ADR 0017).

## Decisions

- **One tray icon, made by Tauri's tray API** (`tray.rs`), drawn by libayatana-appindicator. Its menu has Show/Hide Hermes Chat, New chat, Open Inbox and Quit Hermes Chat. The app runs nothing else: no daemon, no second process. Quitting ends everything, including replies the app was following; Hermes keeps running them on the server, as it did before.
- **Close to tray is off by default.** With it off, closing the window quits, as before. With it on, closing hides the window, but only while the desktop shows the icon. If nothing shows tray icons, closing quits even with the setting on, and Settings says why. A window can't disappear with no way back.
- **The app checks for a tray every two seconds.** It looks for a StatusNotifierItem host on the session bus (KDE Plasma, Xfce, waybar, GNOME with the AppIndicator extension), or on X11 for an owner of the XEmbed `_NET_SYSTEM_TRAY_S<n>` selection (i3bar, stalonetray). If the tray goes away while the window is hidden (the panel crashed or restarted), the window comes back within about four seconds. The tray counts as gone only after two checks in a row find none, and a check that doesn't answer in time (a busy main thread or session bus) decides nothing, so one slow check can't bring the window back by mistake. libayatana re-registers the icon when the tray returns.
- **Quit always exits.** It never hides the window. With an unsaved edit open (memory, a skill, a Server file, an Artifact or a persona), Quit brings the window forward and closes it through the same question closing the window asks. Discard exits. Without an unsaved edit it exits at once.
- **A second launch restores the first window.** The app already owns the session bus name `net.l0cky12.HermesChat` for the desktop screenshot shortcut (`remote.rs`). It now also answers `Show`. `hermes-chat` with no arguments calls `Show` and exits if a Hermes Chat answers; otherwise it starts. An update's restart sets `HERMES_CHAT_RESTARTED`, so the new copy doesn't hand itself to the copy exiting.
- **The tray's New chat and Open Inbox act like the app's own.** New chat asks first about an unsaved edit, as the New chat button does. While a modal dialog is open, such as a Server file being edited or a question, both only bring the window forward, since the app's shortcuts also stop at a modal; the owner sees the dialog and decides.
- **Restoring keeps everything on screen as it was.** Hiding doesn't unmount anything, so drafts, the open chats, replies streaming in, queued messages and Approvals are all still there. Focus goes back where it was, or to the active pane's composer.
- **What stops when the window hides:** Dictation drops its recording and closes the microphone, as Cancel does, and sends nothing to Hermes. Read aloud stops and lets go of its audio. Nothing listens or plays behind a hidden window.
- **A hidden window shows no chat.** While hidden, the panes don't count as on screen, so a reply arriving in the open chat leaves it Unread, and it reaches the Inbox.
- **The tray says how many Inbox entries need the owner**, as a count in Open Inbox (`Open Inbox (3)`) and a dot on the icon. It never shows a chat's title or text, since the tray is visible to anyone looking at the screen.
- **The setting is per computer.** It is kept in `window.json` in the app's config folder (`$XDG_CONFIG_HOME/net.l0cky12.hermes-chat/`), written to a temporary file and renamed, then read back. A missing or unreadable file means off.

## Considered options

- **Close to tray on by default**: the issue rules it out. A window that vanishes on close, on a desktop with no tray, looks like a crash.
- **`tauri-plugin-single-instance`**: a second D-Bus name and another dependency, when the app already owns one for the screenshot shortcut.
- **Deciding the close in the webview**: a hung webview could then never close or hide. Rust decides, and the webview's close guards ask nothing when they find the window already hidden.
- **Keeping a Dictation recording while hidden**: the microphone would stay open with no window showing it. Stopping and transcribing would send audio the owner never confirmed.

## Gaps

- Two copies can still run if the second starts before the first has taken the bus name, which is a moment at startup, or when there is no session bus. ADR 0017's locked project-defaults file still keeps their saves apart.
- On GNOME without the AppIndicator extension there is no tray. The window stays a normal window and Settings says so.
- libayatana-appindicator on Linux reports no clicks on the icon itself, only menu picks, so a left click opens the menu rather than toggling the window.
