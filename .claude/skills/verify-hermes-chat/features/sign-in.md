# Sign in

On first launch, Setup walks the owner from Welcome to a saved connection: they pick a route, test it, give the dashboard username and password, test the sign-in, and save. A wrong password is turned down with a message, and nothing is saved. Later launches open Sign in for the saved connection.

## Sub-features

- `setup-route`: the Server step tests a Web address route and reports the Hermes version it reached.
- `setup-wrong-password`: a rejected username or password shows an alert and offers Try again.
- `setup-save`: Test connection, then Save and connect, signs in and opens the main window.
- `setup-providers-skip`: the Model providers step can be skipped.
- `sign-in-again`: after a relaunch, Sign in keeps the connection and username and asks for the password.

## How to get to it (user POV)

- First launch with no saved connection: Welcome → **Get started**.
- A launch with a saved connection and no keyring password: the Sign in screen, with **Connect**, **Run setup again…**, **Remove this connection…** and **Set up a new connection…**.
- Signed in: Settings → General → Connection → **Add connection** (Setup over the main window).

## Driving it with wd.mjs

Preconditions:

- Fresh `hv up` and `wd.mjs open`. `hv doctor` is all `ok`.
- `. $HV_RUN/state.env` puts the stand-in's URL in `$DASHBOARD_URL`.

- **Welcome.** Run `$S/wd.mjs wait button "Get started"`, then `$S/wd.mjs shot 00-welcome`, then `$S/wd.mjs click button "Get started"`. The Server step shows `input "Name"`, `select "Connect through"` and `button "Next"` (disabled).
- **Pick Web address.** Run `$S/wd.mjs select select "Connect through" -- "Web address"`. A `Dashboard URL` input replaces `SSH target`.
- **Test the route.** Run `$S/wd.mjs fill input "Dashboard URL" -- $DASHBOARD_URL`, then `$S/wd.mjs click button "Test the route"`, then `$S/wd.mjs wait '[role=status]' "Reached Hermes 0.17.0"`. The Name fills in as `127.0.0.1:<port>` and **Next** is enabled.
- **Next.** Run `$S/wd.mjs click button Next`. The step shows `input "Dashboard username"`, `input "Dashboard password"` and a disabled **Test connection**.
- **Wrong password.** Run `$S/wd.mjs fill input "Dashboard username" -- verify`, `$S/wd.mjs fill input "Dashboard password" -- wrong-pass` and `$S/wd.mjs click button "Test connection"`. Then run `$S/wd.mjs wait '[role=alert]' "turned down the username or password"`. The button reads **Try again**, and `$S/hv state` shows no new session.
- **Right password.** Run `$S/wd.mjs fill input "Dashboard password" -- verify-pass` (the button goes back to **Test connection**), then `$S/wd.mjs click button "Test connection"`, then `$S/wd.mjs wait '[role=status]' "At least one route works"`. **Save and connect** appears.
- **Save.** Run `$S/wd.mjs click button "Save and connect"`, then `$S/wd.mjs wait '[role=dialog]' "Model providers"`. The main window is visible behind the dialog.
- **Skip providers.** Run `$S/wd.mjs wait .setup-ok "You're ready to chat"` (the stand-in reports Anthropic and OpenAI as ready), then `$S/wd.mjs click button Skip`, then `$S/wd.mjs gone '[role=dialog]'`, then `$S/wd.mjs shot 04-signed-in`. The rail button `Connected · http://127.0.0.1:<port>` and the list's `Settled4` are visible.
- **Sign in again.** Run `$S/wd.mjs close`, then `$S/wd.mjs open`, then `$S/wd.mjs wait button Connect`. `$S/wd.mjs value input "Dashboard username"` prints `verify`. Run `$S/wd.mjs fill input "Dashboard password" -- verify-pass`, `$S/wd.mjs click button Connect` and `$S/wd.mjs wait button "Search all chats (Ctrl+K)" 20000`.
- **Proof.** Keep the shots of the alert, the passed test, and the signed-in window. `bridge.log` shows a 401 `POST /auth/password-login` followed by a 200 one.

## Gotchas

- Editing the password after a failed test changes the submit button back from **Try again** to **Test connection**. Click the label that is on screen.
- The Model providers step loads after it appears, and a Skip clicked before that is lost (`gone '[role=dialog]'` then times out). Wait for the provider line first. Its button reads **Skip for now** when Hermes has no provider ready, and `click button Skip` matches both labels.
- On this private bus, the status "Couldn't save the password in the system keyring" is expected, and it is why every relaunch asks for the password again.
- Never use the plain hostname `hermes` as a stand-in URL. On this box it resolves to the owner's real server.
- A real dashboard bound to `127.0.0.1` passes the route test and the password check, but fails afterwards because its WebSocket ticket is refused. Bind it to `127.0.0.2` or higher.
- The SSH and Tailscale route kinds aren't covered here. They need a private `sshd` and a wrapper `ssh` on the app's `PATH`, because ssh reads the passwd home's config, not `$HOME`.
