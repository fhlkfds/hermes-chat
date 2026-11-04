# Memory is edited one entry at a time through `learning.*`, and only for the profile the dashboard runs as

Settings → Memory edits Hermes's built-in memory, `memories/MEMORY.md` and `memories/USER.md` in the profile's home on the server, with the legacy JSON-RPC calls Hermes's own TUI uses for `/journey`: `learning.frames` lists the entries, `learning.detail` reads one, `learning.edit` replaces one and `learning.delete` removes one. Each call names an entry by a digest of its text, and Hermes resolves it inside the memory tool's own file lock, so a write to an entry that changed or went since it was read is refused instead of landing on another entry. Those calls take no profile: they act on the profile the dashboard process runs as. So the screen edits memory only when that profile, `GET /api/profiles/active` → `current`, is the profile shown, and checks it again before every write. Before a write it also reads the entry again and stops with a conflict if it changed; after a write it reads every entry back and says the save happened only if the new text is there. (Research doc "Memory".)

## Considered options

- **Edit the whole file through `/api/fs/read-text` and `/api/fs/write-text`.** Rejected: the write has no precondition and doesn't take the memory tool's lock, so anything the agent wrote between the read and the write would be lost (the race Hermes fixed for Journey in #119668), and it skips the tool's size limit and drift guard. A read-compare-write in the app still leaves that window open.
- **Edit another profile's memory with `learning.*`.** Not possible: the calls refuse a `profile` param (4000), and a socket opened for another profile still reaches the dashboard's own. Naming those entries as another profile's would edit the wrong memory. Reading another profile's files through `/api/fs/read-text` was left out too, since none of them could be saved.
- **Ask the agent to change its memory in a chat.** Not an editor: the result depends on the model, and it adds a turn to a chat.
- **Keep unsaved edits on this computer.** Rejected: memory holds personal details. An edit lives only on screen, and leaving with one asks first.

## Consequences

- On the deployed server only the `default` profile's memory can be edited from the app. Other profiles show why. Hermes would need a `profile` param on `learning.*` (or a scoped REST route) for the rest.
- Entries can be changed and removed, not added: Hermes has no call for adding one. The screen says to ask Hermes in a chat.
- An entry can't be saved empty, or with a line holding only `§`, which would split it when Hermes reads the file again. Hermes's own refusals, such as the file's size limit, show as Hermes words them.
- A conflict, or a save that reads back differently, keeps the owner's text on screen to copy or to put in an entry they choose. The app never overwrites newer text without the owner choosing to.
- A save reaches chats that start after it. A running chat keeps the memory it started with until Hermes compresses its history. Saving never restarts Hermes.
- Unsaved edits are protected while Settings is open: leaving Settings, changing tab, opening a chat, switching profile, signing out, taking a screenshot or closing the window asks first, and an automatic close (a chat leaving the list) leaves Settings open. Closing the window after the question needs the `core:window:allow-destroy` permission.
- What a save replaced is kept in this app's memory for the sign-in, so it can be put back: see ADR 0040.
