# The Screen adds a browser, a terminal and a text editor itself

> **Accepted.** The table of apps and the setup are in `src/hermes/screenApps.ts`, the note in `src/ui/Screen.tsx`, the Hermes calls in `src/hermes/transport.ts` (`ScreenApi.installBrowser`, `findPrograms`, `resetDock`, `stop`), and the install over ssh in `src-tauri/src/screen_apps.rs` with its script `screen_apps.sh`. It partly supersedes ADR 0039 and ADR 0078.

The owner opens the Screen tab (Hermes's Bot Desktop, ADR 0039) and wants a web browser, a terminal and a text editor in its dock, with nothing to install by hand. On most servers the browser and the editor were missing, and the app only showed a command to copy for the browser (ADR 0078). Every Hermes fact below was read in its source at `bf0203a`, the owner's server.

- Hermes's launcher writes the dock once, when `<HERMES_HOME>/bot-desktop/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml` doesn't exist, with a launcher only for each program on the PATH then: `xfce4-terminal`, Hermes's own Chromium, `thunar` and `mousepad` (`tools/bot_desktop/launcher.sh`). A dock written before an app was installed never shows it.
- Hermes's desktop install includes `xfce4-terminal` but never `mousepad` or a browser. On Linux Hermes runs only pm's Chromium (`hermes_cli/browser_runtime.py`). `hermes pm install chromium` needs no root, and pm's store serves every profile.
- `cli.exec {argv, timeout}` runs `hermes <argv>` and answers `{blocked, hint?, code, output}`, for up to 600 s. `shell.exec {command}` runs a command as the Hermes user for up to 30 s, and refuses one its danger check flags. `display.stop` refuses while a person holds the screen, unless `force` is sent.

## Decisions

- **One table of the three apps.** `SCREEN_APPS` names each one, and how it is installed: `pm` for the browser, `system` with its program for the terminal (`xfce4-terminal`) and the editor (`mousepad`). The note's words and the check come from the table. A test checks that `screen_apps.sh` installs exactly the table's system programs.
- **It runs by itself, once per profile and connection.** The first time the tab is shown on a screen that is Hermes's own (not in the terminal's sandbox, which brings its own browser), supported and installed, the app checks and installs what is missing with no click. The browser is missing when `browserOf` says so. The terminal and the editor are checked with one `shell.exec` of `command -v xfce4-terminal; command -v mousepad`. Debian's `sh` (dash) answers `command -v` only for the first name it is given, so each program gets its own. A Hermes without `shell.exec` skips those two without a word. The browser and the system apps install at the same time.
- **Hermes installs the browser.** `cli.exec {argv: ["pm", "install", "chromium"], timeout: 600}`, then `display.status` again: the browser is added once Hermes finds it. The app waits 660 s for that answer, longer than the run Hermes allows. If it fails, the note about no browser shows as before, with the reason first, and its command to copy and Check again.
- **The owner's own ssh installs the terminal and the editor.** They need root, and no Hermes route installs `mousepad`. The app runs one fixed script, `screen_apps.sh`, through ssh to the Terminal's target, as the Repository screen reaches the server (ADR 0110). The script picks apt-get, dnf or pacman, runs the install as root if ssh signs in as root, through `sudo -n` if sudo needs no password, and otherwise exits 10. The note then asks for the sudo password in a masked field. The password goes on ssh's stdin, which `sudo -S` reads. It is never an argument, never logged and never kept. The field is cleared as the install starts. A wrong password asks again. The script is constant and has no single quote, so the remote command is `exec sh -c '<script>' highwing-screen-apps <ask|password>`, one line.
- **Rust names how it ended.** Installed, needs a password, wrong password, no package manager, no sudo, failed (with the package manager's last lines), or an error before the script's end was known (ssh's own failure, in the Repository screen's words, or 15 minutes with no answer). The webview turns each into its sentence.
- **No SSH target, a command to paste.** The same script, as one line under `sudo sh -c`, read from the same file, so the two can't drift. Check again counts what the owner installed since as added.
- **The dock is written again only while the screen is stopped.** After something is added, the app deletes the dock's layout file with `shell.exec rm -f -- '<file>'`, and the screen's next start writes it with the new apps. The file is found from `display.status`'s `profile_key`, the profile's resolved Hermes home, so no extra `cli.exec` asks for it. A running screen's Xfce could write the old file back as it stops, so a running screen is left alone. The note offers Restart the screen: `display.stop` (never forced), delete the file, `display.start`. The app never restarts it on its own, since the agent may be in the middle of something there.

## Considered options

- **An Install button for each app.** Rejected: the owner asked for the apps to be there. A password is the only thing the app asks for, and only when sudo needs one.
- **Hermes's `display.install`.** Rejected: its package list has no `mousepad` and no browser, and it needs the masked `display.install.sudo` request answered.
- **`hermes -p <profile> config path` for the dock's folder.** Not needed: `display.status` already carries the same folder as `profile_key`.
- **Restarting a running screen to refresh the dock.** Rejected: it would stop whatever the agent is doing on it.

## Supersedes

- **ADR 0039, in part.** Its decision "Not installed means a command, not an install button" still holds for the Bot Desktop's own packages. Its reason, that the app doesn't answer a masked sudo request, no longer holds for the apps this ADR adds: the app now asks for a sudo password itself, for its own ssh.
- **ADR 0078, in part.** On the Screen tab the fix for no browser is now installing pm's Chromium, and the command to copy is the fallback when that fails. Its considered option "An Install Chromium button. Not built." is built, with no button: `cli.exec` is the route it said was missing. Settings → Diagnostics keeps its Bot Desktop section and its command.

## Consequences

- The app now runs commands on the server through Hermes (`shell.exec`, `cli.exec`) as well as through ssh. Each one is fixed in the app; only the dock file's path comes from Hermes.
- `thunar` isn't installed. The dock shows Files only where it already is.
- The canonical session protocol's `shell.exec` runs only for a local session's composer, so an adapter for it (ADR 0174) would need another way to check and delete on the server.
- What is added is reported, not checked again after the package manager says it installed it.
