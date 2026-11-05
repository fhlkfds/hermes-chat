# The Screen and Diagnostics say when the Bot Desktop has no browser

The agent's browser and the Bot Desktop's dock both open a headed Chrome or Chromium on the Hermes server. Without one, the owner found out only when a browser or computer-use step failed. Hermes already reports it: `display.status` carries `browser`, the path it would run for the profile asked about, or `null` (`tools/bot_desktop/runtime.py`, read at f0d94882). The app now reads it and says so in two places: a note on the Screen tab and a row in Settings → Diagnostics.

## Decisions

- **A null is "none" only on a Linux server's own screen.** Hermes sends `browser: null` also where it doesn't look: a server that isn't Linux, and a screen placed in the terminal's sandbox (`bot_desktop.placement`), whose image brings its own Chromium. A Hermes from before the field leaves it out. `browserOf` turns the wire field into one of three: found (with the path), missing, or unknown with the reason. Nothing else reads the raw field.
- **The fix is a command to copy, as for the desktop packages (ADR 0039).** Both places show `hermes pm install chromium`, Hermes's own hint (`chromium_missing_hint`), with a copy button, and the other way out: `browser.executable_path` in the profile's config. Hermes's hint can be more specific (a distribution package where pm builds none, a container image to pull), but `display.status` doesn't carry it, so the app doesn't guess.
- **Check again re-reads `display.status`.** The Screen tab's note has it, and says what Hermes found once the note goes. Diagnostics' Bot Desktop section has its own, so the features' Check again keeps its meaning.
- **Per profile.** `display.status` answers for the profile asked about, and `browser.executable_path` can differ by profile. The Screen tab is made per profile already. Diagnostics asks again when the profile changes, and drops an answer about the profile shown before.
- **The screen can still start without a browser.** The note sits above whatever the tab shows. Only the agent's browser steps need one.

## Considered options

- **An Install Chromium button.** Not built. There is no dashboard route for `pm install chromium`, so it needs either a Hermes-side change or running the command over the connection's SSH route in the Terminal. That choice is left to the owner.
- **A capability in the capability store (ADR 0044).** Rejected: the store records what routes and methods the server has, the same for every profile. Whether a browser is installed is a fact about the server's machine and the profile's config, and it changes when the owner installs one.
