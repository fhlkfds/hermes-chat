# Server file transfers stream through Rust and stop with the connection

The Server files screen (ADR 0012) downloads a Server file through the dashboard's managed-files route `GET /api/files/download`, and uploads a local file through `POST /api/files/upload-stream`. The official web dashboard's Files tab uses both. Rust does the whole transfer: it opens the native Save dialog, streams the answer to disk one network chunk at a time, and reports progress to the webview. The webview never names a local path and never holds the file's bytes.

## Decisions

- **Where it goes.** The owner picks the destination in the native Save dialog. The GTK dialog asks before replacing a file that is already there (rfd's `gtk_file_chooser_set_do_overwrite_confirmation`), which is the overwrite confirmation. Closing the dialog reads and writes nothing.
- **Nothing half-written.** The bytes go to a hidden `.<name>.<pid>-<n>.part` beside the destination. It replaces the destination with a rename, only once every byte the server announced (`Content-Length`) has arrived and been synced. Cancel, a broken connection, a short answer, a full disk, or any write error removes the part file. The file already at the destination stays as it was.
- **Cancel.** Each transfer is a Tokio task, registered under the webview's id. Cancel aborts it. The part file's writes, sync and rename are synchronous: they run in place with `block_in_place`, so a slow disk holds up only that transfer, and every `.await` in a download is on the network. So an abort never leaves a file operation running on its own. Once the rename has happened, the download reports that it finished, never that it stopped. The part file is created with `create_new` under a fresh name, and only a part file the download created itself is ever removed. A registry entry is removed only by the run that added it.
- **Never another server's files.** Every transfer is stopped when the connection is closed (sign-out) or replaced (a reconnect, or a profile switch, which opens a new connection). Each stop also advances a counter. A transfer notes the counter when it's asked for, and starts only if no stop has come since. That's checked under the same lock the stop takes, so a stop either reaches a transfer or keeps it from starting, and checked again once the connection is in hand. The Save dialog isn't part of the transfer, because the dialog plugin can't close a dialog it opened. A stop while it's open leaves it on screen, and the pick is turned down, as stopped, once the owner makes it. Managed files are the dashboard host's, the same for every profile, so a profile never changes what a transfer reads.
- **Refusals come from the server.** It sends what its OS user may read, up to 100 MiB (`_MANAGED_FILE_MAX_BYTES`), inside a locked root, and never a credential file. The app refuses a file over 100 MiB only from its listed size, before asking anything. The server's own 403, 404 and 413 answers are shown in the browser's words.
- **The relay stays read-only.** The generic REST relay still refuses anything but GET to `api/files` and `api/fs`. The download has its own Rust command, which sends only `GET api/files/download?path=`, with the path as a query value.

## Uploads

- **Only on purpose.** Upload… opens the native Open dialog, and the webview gets a token for the picked file, never its path. Before anything is sent, a dialog shows the file's name and size and the server path it goes to. Nothing reaches the server until the owner presses Upload. Browsing, opening or dropping a file never uploads one.
- **Collisions.** When the folder's listing already has the name, the dialog says so, with that file's size and time. It offers Keep both (the default: upload as `name (2).ext`, the first free name) or Replace. The upload is sent with `overwrite=false` unless the owner chose Replace, so a file that turned up after the listing makes Hermes refuse with 409, and nothing is replaced. A folder with that name is refused.
- **What Hermes guarantees.** `upload-stream` writes into a `mkstemp` temp file beside the target and `os.replace`s it in only after reading the whole upload. It removes the temp file on any failure, so the target is never half-written. FastAPI parses the whole multipart form before the route runs, so a cancelled or broken upload never reaches the target at all. The limit is 100 MiB, and the app refuses a bigger file before sending. The `overwrite=false` check runs before the stream is written, not at the rename, so a file created during the upload is still replaced (see below).
- **Read back.** Hermes's 200 says it wrote the file. Then the app lists the folder again, and the upload counts as done only when the listing has the name at the size that was sent. Otherwise it says what the listing shows.
- **Credential files.** Hermes never lists, reads or sends `.env`, `auth.json` and the rest (`_is_sensitive_path`), but its write routes don't check them. So the browser can't show that a `.env` is there, and an upload of one would overwrite it unseen. Rust refuses to upload to any such path before sending anything (`protected_server_path`, the same list). The dialog says so up front.
- **Server permissions.** Hermes writes as its OS user, inside its locked root if it has one. Its 403s are shown as they come: `File is not writable`, `Path outside managed files root`.

## Gaps in Hermes's write contract (at `bf0203a`)

These were found by reading `hermes_cli/web_routers/files.py` and probing a throwaway dashboard. The app works around them where it can, and says so where it can't. The backend design that would close each:

1. **No conditional write.** There's no revision, ETag or If-Match on `upload-stream`, and `overwrite=false` is checked before the stream is written. *Design:* take `expected_sha256` (or `if_match` with the ETag `/download` already sends) and `if_none_match=*` as form fields. Check them under a per-path lock right before `os.replace`, and answer 412 on a mismatch.
2. **Replacing resets permissions.** `mkstemp` makes the temp file `0600`, and `os.replace` gives the path that new inode, so a `0644` or `0755` file becomes `0600`. *Design:* copy `st_mode` (and the owner, when allowed) from the existing target onto the temp file before the rename, as `utils.atomic_write_text(preserve_mode=True)` does for SOUL.md. The dialog warns before Replace.
3. **Writes don't guard credential files.** *Design:* apply `_is_sensitive_path` to `upload`, `upload-stream`, `mkdir` and `DELETE`, and answer 403.
4. **Missing parents are created.** `target.parent.mkdir(parents=True)` makes folders for any path. The app only uploads into a folder it just listed, so it never asks for one. *Design:* refuse a missing parent unless the caller asks for it.

## Considered options

- **Read the file in the webview with `GET /api/files/read` and save it from there.** Rejected. That route sends the whole file as one base64 data URL, about 4/3 of its size, so a 100 MiB file would need hundreds of MiB in the webview. There's no progress, and Cancel couldn't stop it.
- **`GET /api/fs/download`.** Rejected, as ADR 0012 rejects the agent fs routes: they follow a profile's SSH workspace, so they may read a different machine from the one the screen lists.
- **Our own overwrite question after the Save dialog.** Rejected. The GTK dialog already asks, so it would ask twice.
- **`POST /api/files/upload` (a JSON data URL).** Rejected. It base64-encodes the whole file into one request, and writes with a bare `write_bytes`, which truncates the target first.
- **Replace without asking whether the name is taken.** Rejected. The listing shows the collision, and `overwrite=false` covers the window after it.

## Consequences

- One transfer reads at most one network chunk into memory at a time. Progress is reported at most every 100 ms, and a progress message that arrives after the outcome is ignored. The final byte count comes with the outcome.
- A file that changes on the server while it downloads comes as the server streams it. Hermes has no snapshot or checksum for it.
- A reconnect after a dropped connection also stops a download under way. The owner starts it again.
- A download's destination is the owner's choice, so the app writes outside its own folders only there, and only after the dialog.
- An upload reads the local file in 256 KiB chunks, and sends exactly the size it measured when it started. A file that shrank meanwhile fails the upload instead of leaving a short copy.
- Progress is the bytes handed to the connection. Hermes doesn't confirm them until it answers.
