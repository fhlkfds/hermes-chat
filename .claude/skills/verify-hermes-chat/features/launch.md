# Launch on the saved chats

With a saved password and a chat list saved from an earlier run, the app opens straight on that list, and on the last chat's Saved copy, with the status "Connecting…", and goes live once the server answers. If the server turns the saved password down, the sign-in screen asks, with the error and the saved password filled in. With nothing saved, launch shows "Signing in…" until it is connected (ADR 0089).

## Sub-features

- `launch-slow`: over a slow server the list shows about 1 s after launch, before any answer, then turns Connected by itself.
- `launch-wrong-password`: a saved password the server now turns down shows the list briefly, then Sign in with "Wrong username or password.", and no further sign-in tries.
- `launch-no-saved-chats`: a first launch for a connection shows "Signing in…" until connected.

## How to get to it (user POV)

- Relaunch the app after signing in once, with the password saved in the system keyring.

## Driving it with wd.mjs

Preconditions:

- `HV_DELAY_MS=3000 $S/hv up`, so every `/api/` answer takes 3 s, then `. $HV_RUN/state.env`.
- **A keyring on the private bus.** The bus has none, so a relaunch would never have a saved password. Before `wd.mjs open`, run `mkdir -m 700 -p $HV_RUN/runtime`, then `printf throwaway | env -i PATH=/usr/bin:/bin DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" HOME=$HV_RUN/home XDG_DATA_HOME=$HV_RUN/data XDG_RUNTIME_DIR=$HV_RUN/runtime gnome-keyring-daemon --unlock --components=secrets --daemonize`. The unlock password must not be empty, or no `login` collection is made and the app's save fails. Note its PID (`pgrep -x gnome-keyring-d`, then check `/proc/<pid>/environ` holds `$HV_RUN`); `hv down` doesn't stop it.
- Sign in by [sign-in.md](sign-in.md) (each step waits 3 s for the stand-in, so give `wait` 60000). No keyring warning shows. Then `$S/wd.mjs click button Settled` and `$S/wd.mjs click .row-open[data-chat=backup]`, so a chat and its Saved copy are there to reopen.

- **Slow launch.** Run `$S/wd.mjs close`, `$S/wd.mjs open`, then `$S/wd.mjs wait '[aria-label^="Connecting"]' '' 15000` and `$S/wd.mjs shot 01-connecting`. The four chats and the backup chat's Saved copy show, with "Connecting to Hermes, so newer messages may be missing until it loads." Then `$S/wd.mjs wait '[aria-label^="Connected"]' '' 60000` and `$S/wd.mjs shot 02-connected`: the Saved copy note is gone. `bridge.log` shows `GET /api/status`, then the sign-in and `ws-ticket` 3 s later.
- **Wrong saved password.** `$S/wd.mjs close`. Stop the stand-in by its PID, then start a copy that wants another password on the same port: `sed 's/"verify-pass"/"changed-on-server"/' $HV_RUN/bridge.mjs > $HV_RUN/bridge-changed.mjs` and `HV_DELAY_MS=3000 setsid node $HV_RUN/bridge-changed.mjs $BRIDGE_PORT $EVIDENCE/server-state.json > $EVIDENCE/bridge-changed.log 2>&1 &`, and put its PID in `$HV_RUN/state.env` as `BRIDGE_PID`. Then `$S/wd.mjs open`, `$S/wd.mjs wait '[aria-label^="Connecting"]' '' 15000`, `$S/wd.mjs shot 03-wrong-connecting`, `$S/wd.mjs wait '[role=alert]' 'turned down' 30000` and `$S/wd.mjs shot 04-sign-in`. `bridge-changed.log` shows one `POST /auth/password-login` and none after it.

## Gotchas

- `wait button Connect` also matches the "Connecting…" status button. Wait for the alert instead.
- `wait <css> <ms>` reads the number as text: pass `''` for the text first.
- After `hv build` mid-run, `hv doctor` fails its build check, which compares with the revision `hv up` recorded. The new binary is still the one `wd.mjs open` starts.
- `launch-no-saved-chats` is covered by unit tests (`offline.test.ts`), not here: a fresh run has no saved chats but no saved password either, so it opens on Setup.
