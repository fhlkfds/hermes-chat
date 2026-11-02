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

**Delete**:
The owner's action that removes a chat from Hermes for good, in every Hermes client. Unlike settling, it can't be undone, so the app asks first. A chat with a reply running can't be deleted.
_Avoid_: remove, archive

**Pinned**:
An Active chat the owner keeps at the top of the list, in its own section above the other Active chats. Settling a Pinned chat unpins it, and pinning a Settled chat makes it Active. Pins are kept on this computer only (ADR 0005).
_Avoid_: starred, favourite

**Snoozed**:
A Settled chat the owner has put away until a set time. When the time comes it moves back to Active, at the top, and Unread. Its wake time is kept on this computer only, so it wakes once this app is running and connected (ADR 0005). Sending a message in it, or moving it to Active anywhere, ends the snooze.
_Avoid_: reminder, deferred

**Unread**:
A chat with something new in it since the owner last opened it, in this app or any other Hermes client. It shows a dot, and so does the collapsed Settled header when a Settled chat is unread. The chat on screen never shows the dot.
_Avoid_: new, unseen

**Working folder**:
The folder Hermes works in for a chat, as it stored it on the server (the session's `cwd`, else its git repository's root).
_Avoid_: path, cwd (in the UI)

**Source**:
The platform a chat was started on: this app, Telegram, Discord, the command line, or the official Hermes desktop app. A chat's source never changes, even after the owner replies from this app. Chats whose source is this app show no source icon.
_Avoid_: origin, platform (as an attribute of a chat)

**Imported chat**:
A chat whose source is anything other than this app. Imported chats start Settled.

**Profile**:
A separate Hermes agent setup on the server, with its own chats. The app shows one profile's chats at a time.
_Avoid_: account, workspace, agent (as a name for a profile)

**Attachment**:
A local file the owner sends with a message: an image Hermes looks at, or any other file Hermes can read. Hermes takes images up to 25 MB and other files up to 256 MB.
_Avoid_: upload, file (when the attachment is meant)

**Approval**:
Hermes asking the owner before it runs a command it counts as dangerous. It shows as a card in the chat, and the reply waits until the owner approves or denies it, Hermes stops waiting, or the reply is stopped.
_Avoid_: permission, confirmation, prompt

**Unsecure**:
The warning on a connection whose traffic between this app and the server isn't encrypted.
_Avoid_: insecure (the app's label is "Unsecure"), unsafe

## Relationships

- Every **Chat** is either **Active** or **Settled**, never both.
- Every **Chat** has exactly one **Source**.
- Every **Chat** belongs to exactly one **Profile**; Active and Settled are kept per profile.
- An **Imported chat** becomes **Active** only when the owner sends a message in it from this app.
- A **Pinned** chat is always **Active**; a **Snoozed** chat is always **Settled**. A chat can't be both.

## Flagged ambiguities

- **Pinned** vs Hermes's own `pinned` flag: they are different things. Hermes's flag stores whether a chat is Active (ADR 0002); this app's Pinned keeps an Active chat at the top, and Hermes doesn't store it.
- **Settled** vs Hermes's own "archived" flag: they are different things. Archiving in Hermes hides a session in every Hermes client; settling is this app's view of the owner's attention.
- **Imported chat** vs pulling older history: the list holds the past month's chats until the owner pulls older history in Settings, after which it holds all of the profile's chats. Pulled chats come in Settled unless pinned, but they are Imported chats only if their Source isn't this app.
- **Source** vs the `source` field on a Hermes session: the app derives a chat's Source from that field, but the field has more values than the app shows. `hermes-chat` and `gui` count as this app, and `cli` and `tui` as the command line. `cron` chats aren't listed, and any other value (for example `api_server`, `webhook`) shows as "another Hermes platform".
