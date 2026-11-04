# Memory saves keep what they replaced, in memory, for the sign-in

ADR 0020 kept every memory text off this computer. Issue #70 also asks that the owner can put back the content from before this app last saved. Hermes keeps no history of `memories/MEMORY.md` or `USER.md`, and `learning.*` has no "previous version" call. So only this app can hold the earlier text, and only for saves it made itself.

## Decision

- **What is kept.** A save from Settings → Memory that reading back confirms records the entry's text before the save, the text it left, and when. Nothing is recorded for a refused save, a conflict, a save that read back differently, or a save whose answer was lost. In those cases the app doesn't know that its save is what the server now has.
- **Where and how long.** In the connection's client object (`Hermes.memory`), in this app's memory only. Nothing goes to webview storage, disk, diagnostics or backups (ADR 0038). There is a list per profile and file, holding the latest ten. Signing out, connecting again through setup, or quitting drops all of them. Closing and reopening Settings, switching tab, or switching profile keeps them.
- **When it's offered.** Hermes names an entry by a digest of its text, so the entry an earlier save left is identified by that text. **Restore previous version** shows on an entry that still holds exactly what a save from here left, for the profile and file shown. Once the agent or another client changes that entry, the app can't tell it is the same entry, so the button goes.
- **What Restore does.** It puts the earlier text in the editor as an unsaved edit. If an unsaved edit is already there, it asks first. Saving it then takes the ordinary path of ADR 0020: check that the profile is served and the entry unchanged, `learning.edit`, then read back. It is never last-write-wins. A restore is a save too, so it can itself be undone.
- **Removed entries can't be put back.** Hermes has no call that adds an entry. The delete question still says it can't be undone from here.

## Considered options

- **Keep the earlier text in webview storage, like Persona's `SOUL.md` versions.** Rejected for memory: it holds personal details about the owner, and ADR 0020 keeps them off disk. Persona is the agent's own instructions.
- **Server-side history.** Better, since it would cover the agent's and other clients' changes too. But Hermes has none. It would need, for example, `learning.history {id}` returning the entry's prior texts with times, or a `memories/.history/` journal written by the memory tool under its lock. That is a backend change, outside this app.
- **Match by position instead of text.** Rejected: an entry's index shifts when another entry is removed, which could offer one entry's old text on another.

## Consequences

- Recovery covers only saves made from this app during this sign-in, and only while the entry still holds what was saved.
- Nothing about memory reaches disk, as before.
