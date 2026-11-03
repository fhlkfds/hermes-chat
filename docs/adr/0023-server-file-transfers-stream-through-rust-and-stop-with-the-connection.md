# Server file transfers stream through Rust and stop with the connection

The Server files screen (ADR 0012) downloads a Server file through the dashboard's managed-files route `GET /api/files/download`, the one the official web dashboard's Files tab uses. Rust does the whole transfer: it opens the native Save dialog, streams the answer to disk one network chunk at a time, and reports progress to the webview. The webview never names a local path and never holds the file's bytes.

## Decisions

- **Where it goes.** The owner picks the destination in the native Save dialog. The GTK dialog asks before replacing a file that is already there (rfd's `gtk_file_chooser_set_do_overwrite_confirmation`), which is the overwrite confirmation. Closing the dialog reads and writes nothing.
- **Nothing half-written.** The bytes go to a hidden `.<name>.<pid>-<n>.part` beside the destination. It replaces the destination with a rename, only once every byte the server announced (`Content-Length`) has arrived and been synced. Cancel, a broken connection, a short answer, a full disk, or any write error removes the part file. The file already at the destination stays as it was.
- **Cancel.** Each transfer is a Tokio task, registered by the webview's id. Cancel aborts it, and the part file is removed as the task drops.
- **Never another server's files.** A transfer uses the sign-in that is current when its destination is picked, and only that one. Every transfer is stopped when the connection is closed (sign-out) or replaced (a reconnect, or a profile switch, which opens a new connection). So a transfer can't carry on against, or write into, another server's files. Managed files are the dashboard host's, the same for every profile, so a profile never changes what a transfer reads.
- **Refusals come from the server.** It sends what its OS user may read, up to 100 MiB (`_MANAGED_FILE_MAX_BYTES`), inside a locked root, and never a credential file. The app refuses a file over 100 MiB only from its listed size, before asking anything. The server's own 403, 404 and 413 answers are shown in the browser's words.
- **The relay stays read-only.** The generic REST relay still refuses anything but GET to `api/files` and `api/fs`. The download has its own Rust command, which sends only `GET api/files/download?path=`, with the path as a query value.

## Considered options

- **Read the file in the webview with `GET /api/files/read` and save it from there.** Rejected. That route sends the whole file as one base64 data URL, about 4/3 of its size, so a 100 MiB file would need hundreds of MiB in the webview. There's no progress, and Cancel couldn't stop it.
- **`GET /api/fs/download`.** Rejected, as ADR 0012 rejects the agent fs routes: they follow a profile's SSH workspace, so they may read a different machine from the one the screen lists.
- **Our own overwrite question after the Save dialog.** Rejected. The GTK dialog already asks, so it would ask twice.

## Consequences

- One transfer reads at most one network chunk into memory at a time. Progress is reported at most every 100 ms.
- A file that changes on the server while it downloads comes as the server streams it. Hermes has no snapshot or checksum for it.
- A reconnect after a dropped connection also stops a download under way. The owner starts it again.
- A download's destination is the owner's choice, so the app writes outside its own folders only there, and only after the dialog.
