# Recover after reconnecting gives up, tell a refused password apart, and never send a message again

Reconnecting already retries a dropped connection five times (1, 2, 4, 8 and 16 seconds), then goes Offline. Before this, Offline waited for the owner, so a wrong password wasn't retried for ever. That left the app stuck after a laptop sleep or an outage longer than half a minute.

Now:

- **Offline still ends the timed retries**, but the app tries again on its own when there's a sign the network is back: the webview's `online` event, the window being focused or shown again, or the computer waking. Waking is noticed by a clock check every 10 seconds that comes more than 30 seconds late. On waking, a connection that still looks up is pinged at once, and dropped if it has gone quiet.
- **A refused password is its own state, Signed out.** Rust marks the errors where the dashboard refuses the password (`signedOut` on `hermes_connect` and `hermes_request`). The app stops at once, never retries on its own, and asks for the password over the chat. Signing in again reuses the same connection object, so the chat list, the chat on screen and its transcript stay.
- **An expired sign-in isn't a refused password.** When a REST call gets a 401, Rust signs in again with the password it signed in with and sends the call once more. Calls that hit the expiry together sign in only once. Only a password the dashboard no longer takes reaches the webview.
- **Nothing is sent again.** Reconnecting resumes chats; it never sends a message again. A message whose `prompt.submit` was cut off by the drop is marked unconfirmed. The next resume checks it against the stored history: if Hermes got it, the copy here goes, and if not, it stays with a note that it wasn't sent.

## Considered options

- **Keep retrying slowly for ever after the timed schedule.** Rejected: every try signs in to the dashboard with the password, so a server that is up but failing would be hit with password sign-ins indefinitely. The signs above cover the cases that matter (network back, owner back, computer awake), and Try again covers the rest.
- **Send the cut-off message again once reconnected.** Rejected: Hermes may already be running it, and running a turn twice can run its tools twice.
- **Send the owner to the sign-in screen on a refused password.** Rejected: it unmounts the chat on screen and drops its transcript.

## Consequences

- Rust now keeps the password in memory for the life of the connection, as the webview's pipe already did.
- A message sent with attachments and no text can't be found in the history, so it stays unconfirmed with its note.
- Launching with the saved password while the server can't be reached still shows the sign-in screen. Recovery covers a connection that was up.
