# Hermes Chat

A personal desktop chat client for one remote Hermes Agent server. Chats that need attention sit at the top; finished ones are settled out of the way.

## Language

**Chat**:
One Hermes conversation as this app shows it, with its full message history.
_Avoid_: session (Hermes's word for the same thing; keep it for server-side talk), conversation, thread

**Active**:
The state of a chat the owner is currently working in. Active chats are listed first. A chat becomes Active when the owner starts it in this app, or when the owner sends a message in it from this app.
_Avoid_: open, live, current

**Settled**:
The state of a chat the owner has put out of the way. Settled chats sit in a collapsed section below the Active ones. Only the owner settles a chat; nothing settles on its own. A new message from another platform leaves a Settled chat where it is.
_Avoid_: archived, done, closed

**Settle** / **Unsettle**:
The owner's manual actions that move a chat from Active to Settled, and back.

**Archived**:
A chat the owner has hidden in every Hermes client without deleting it. Its history stays on the server, and so does whether it is Active or Settled. Archived chats show only in the archived view, or in a search the owner asks to include them. A chat archived in another Hermes client is Archived here too.
_Avoid_: hidden, settled, deleted

**Archive** / **Restore**:
The owner's actions that make a chat Archived, and bring it back to the list, Active or Settled as it was. A chat with a reply running can't be archived or restored. The app says it worked only once Hermes, read back, has the chat that way.
_Avoid_: unarchive, hide, remove

**Delete**:
The owner's action that removes a chat from Hermes for good, in every Hermes client. Unlike settling, it can't be undone, so the app asks first. A chat with a reply running can't be deleted.
_Avoid_: remove, archive

**Rename**:
The owner's action that changes a chat's title, in every Hermes client. If the chat was renamed or edited elsewhere since the owner started, nothing is overwritten: the app shows the newer title and the owner chooses whether to save again.
_Avoid_: retitle

**Unread**:
A chat with something new in it since the owner last opened it, in this app or any other Hermes client. It shows a dot, and so does the collapsed Settled header when a Settled chat is unread. The chat on screen never shows the dot.
_Avoid_: new, unseen

**Source**:
The platform a chat was started on: this app, Telegram, Discord, the command line, or the official Hermes desktop app. A chat's source never changes, even after the owner replies from this app. Chats whose source is this app show no source icon.
_Avoid_: origin, platform (as an attribute of a chat)

**Imported chat**:
A chat whose source is anything other than this app. Imported chats start Settled.

**Profile**:
A separate Hermes agent setup on the server, with its own chats. The app shows one profile's chats at a time. The profile switcher shows which other profiles have Unread chats, checked every two minutes, so it can lag behind.
_Avoid_: account, workspace, agent (as a name for a profile)

**Attachment**:
A local file the owner sends with a message: an image Hermes looks at, or any other file Hermes can read. Hermes takes images up to 25 MB and other files up to 256 MB.
_Avoid_: upload, file (when the attachment is meant)

**Draft**:
The text the owner has typed in a chat's composer and not sent. Each chat keeps its own draft, and so does the New chat pane, separately for each connection and profile. A draft is still there after switching chats or restarting the app. Sending empties it, and if Hermes doesn't take the message, its text comes back. If the connection drops before Hermes confirms it got the message, Hermes may already be running it, so its text is held beside the composer instead, and only the owner sends it again or dismisses it. Attachments aren't kept in a draft.
_Avoid_: unsent message, saved message

**Approval**:
Hermes asking the owner before it runs a command it counts as dangerous. It shows as a card in the chat, and the reply waits until the owner approves or denies it, Hermes stops waiting, or the reply is stopped.
_Avoid_: permission, confirmation, prompt

**Saved copy**:
The transcript of a chat the owner opened lately, kept on this computer so it can be read while Hermes can't be reached, even after a restart. It shows with a note saying when it was saved, until the chat loads from Hermes again. Each connection and profile keeps its own, without the password, and a copy never holds Approvals or errors. The least recently saved copies are deleted first once they pass the storage limit, deleting a chat deletes its copy, and Clear local cache deletes them all.
_Avoid_: cache (for one chat's copy), offline mode

**Unsecure**:
The warning on a connection whose traffic between this app and the server isn't encrypted.
_Avoid_: insecure (the app's label is "Unsecure"), unsafe

## Relationships

- Every **Chat** is either **Active** or **Settled**, never both. An **Archived** chat keeps that state for when it is restored.
- Every **Chat** has exactly one **Source**.
- Every **Chat** belongs to exactly one **Profile**; Active and Settled are kept per profile.
- An **Imported chat** becomes **Active** only when the owner sends a message in it from this app.

## Flagged ambiguities

- **Settled** vs **Archived**: they are different things. Archiving sets Hermes's own "archived" flag and hides a chat in every Hermes client; settling is this app's view of the owner's attention, stored as the "pinned" flag. Neither touches the other (ADR 0005).
- **Imported chat** vs pulling older history: the list holds the past month's chats until the owner pulls older history in Settings, after which it holds all of the profile's chats. Pulled chats come in Settled unless pinned, but they are Imported chats only if their Source isn't this app.
- **Draft** vs the New chat pane: the code also calls the pane for a chat not started yet "the draft". In this glossary a Draft is only the composer's unsent text.
- **Source** vs the `source` field on a Hermes session: the app derives a chat's Source from that field, but the field has more values than the app shows. `hermes-chat` and `gui` count as this app, and `cli` and `tui` as the command line. `cron` chats aren't listed, and any other value (for example `api_server`, `webhook`) shows as "another Hermes platform".
