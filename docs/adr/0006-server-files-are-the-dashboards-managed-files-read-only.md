# Server files are the dashboard's managed files, read-only

The file browser lists and reads the machine the Hermes dashboard runs on through the dashboard's managed-files routes, `GET /api/files` and `GET /api/files/read`, and nothing else. They are the routes the official web dashboard's Files tab uses, and they say who may read what: the server lists as its own OS user, can lock browsing to one folder (`HERMES_DASHBOARD_FILES_ROOT`), and never lists or reads credential files. The app shows those refusals as they come, and adds no rules of its own on top. It opens from the rail, as an app-level action (ADR 0001), and takes the chat pane's place, as Settings does.

## Considered options

- **The agent fs routes (`/api/fs/list`, `/api/fs/read-text`).** `read-text` would give a truncated preview of a big text file, which `/api/files/read` can't. Rejected: they follow a profile's SSH workspace when it has one, so they may read a different machine from the one they list, and `/api/fs/list` has no sizes or times and hides folders such as `node_modules`.
- **Reading over the SSH connection the app already has.** Rejected: it would bypass the server's root lock and credential denylist, and it doesn't exist for a direct URL sign-in.
- **Browse this computer when the server can't.** Rejected: Server files are only ever the server's. A server without the routes says so.

## Consequences

- Read-only for now. The write routes (upload, mkdir, delete) exist on the server, but the Rust relay never sends POST, and refuses anything but GET to `api/files` and `api/fs`.
- A preview reads the whole file, so text over 1 MiB and images over 10 MiB aren't previewed. The size from the listing decides before reading, and `hermes_get_limited` refuses an answer that grew past it.
- Folders aren't paged by the server, so a big folder comes whole; the browser shows 500 entries at a time and filters by name.
- Links are shown as the server lists them: by their target. Opening a linked folder opens its target, and the trail shows the target's path.
- The browser needs a connection. While Hermes is away, the folder last listed stays on screen, marked with when it was listed, and is listed again on reconnect.
