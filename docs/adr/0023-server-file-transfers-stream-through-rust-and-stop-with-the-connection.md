# Server file transfers stream through Rust and stop with the connection

The Server files screen (ADR 0012) downloads a Server file through the dashboard's managed-files route `GET /api/files/download`, the one the official web dashboard's Files tab uses. Rust does the whole transfer: it opens the native Save dialog, streams the answer to disk one network chunk at a time, and reports progress to the webview. The webview never names a local path and never holds the file's bytes.

## Decisions

- **Where it goes.** The owner picks the destination in the native Save dialog. The GTK dialog asks before replacing a file that is already there (rfd's `gtk_file_chooser_set_do_overwrite_confirmation`), which is the overwrite confirmation. Closing the dialog reads and writes nothing.
- **Nothing half-written.** The bytes go to a hidden `.<name>.<pid>-<n>.part` beside the destination. It replaces the destination with a rename, only once every byte the server announced (`Content-Length`) has arrived and been synced. Cancel, a broken connection, a short answer, a full disk, or any write error removes the part file. The file already at the destination stays as it was.
- **Cancel.** Each transfer is a Tokio task, registered under the webview's id before it does anything, its Save dialog included. Cancel aborts it. The part file's writes, sync and rename are synchronous, and every `.await` in a download is on the network. So an abort never leaves a file operation running on its own. Once the rename has happened, the download reports that it finished, never that it stopped. The part file is created with `create_new` under a fresh name, and only a part file the download created itself is ever removed. A registry entry is removed only by the run that added it.
- **Never another server's files.** Every transfer is stopped when the connection is closed (sign-out) or replaced (a reconnect, or a profile switch, which opens a new connection). Each stop also advances a counter. A download notes the counter when it's asked for, and once its Save dialog closes, it goes on only if the counter hasn't moved, using that connection. So a connection replaced while the dialog was open stops it, and it can't carry on against, or write into, another server's files. Managed files are the dashboard host's, the same for every profile, so a profile never changes what a transfer reads.
- **Refusals come from the server.** It sends what its OS user may read, up to 100 MiB (`_MANAGED_FILE_MAX_BYTES`), inside a locked root, and never a credential file. The app refuses a file over 100 MiB only from its listed size, before asking anything. The server's own 403, 404 and 413 answers are shown in the browser's words.
- **The relay stays read-only.** The generic REST relay still refuses anything but GET to `api/files` and `api/fs`. The download has its own Rust command, which sends only `GET api/files/download?path=`, with the path as a query value.

## Considered options

- **Read the file in the webview with `GET /api/files/read` and save it from there.** Rejected. That route sends the whole file as one base64 data URL, about 4/3 of its size, so a 100 MiB file would need hundreds of MiB in the webview. There's no progress, and Cancel couldn't stop it.
- **`GET /api/fs/download`.** Rejected, as ADR 0012 rejects the agent fs routes: they follow a profile's SSH workspace, so they may read a different machine from the one the screen lists.
- **Our own overwrite question after the Save dialog.** Rejected. The GTK dialog already asks, so it would ask twice.

## Consequences

- One transfer reads at most one network chunk into memory at a time. Progress is reported at most every 100 ms, and a progress message that arrives after the outcome is ignored. The final byte count comes with the outcome.
- Disk writes run on the async runtime's thread, one network chunk at a time. That's a small stall per chunk, accepted so that Cancel can't race a file operation.
- A file that changes on the server while it downloads comes as the server streams it. Hermes has no snapshot or checksum for it.
- A reconnect after a dropped connection also stops a download under way. The owner starts it again.
- A download's destination is the owner's choice, so the app writes outside its own folders only there, and only after the dialog.
