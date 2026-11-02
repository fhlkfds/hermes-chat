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

**Export**:
Saving one chat as a Markdown file, in a place the owner picks in the Save dialog. The file holds only what Hermes Chat has loaded for the chat. It names attachments but never includes their contents. It also warns that the chat itself may contain sensitive information.
_Avoid_: download, backup

**Rename**:
The owner's action that changes a chat's title, in every Hermes client. If the chat was renamed or edited elsewhere since the owner started, nothing is overwritten: the app shows the newer title and the owner chooses whether to save again.
_Avoid_: retitle

**Regenerate title**:
The owner's action that asks Hermes for a new title made from the chat's last five messages, then saves it as a Rename does. Asking adds nothing to the chat. If Hermes gives no usable title, the old one stays and the row says why.
_Avoid_: auto-title (Hermes's own titling of a new chat), retitle

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
Hermes asking the owner before it runs a command it counts as dangerous. It shows as a card in the chat, and the reply waits until the owner approves or denies it, Hermes stops waiting, or the reply is stopped. The card offers only the answers Hermes offers: once, for the rest of the chat, always, or deny. The two broader grants ask the owner to confirm first.
_Avoid_: permission, confirmation, prompt

**Saved copy**:
The transcript of a chat the owner opened lately, kept on this computer so it can be read while Hermes can't be reached, even after a restart. It shows with a note saying when it was saved, until the chat loads from Hermes again. Each connection and profile keeps its own, without the password, and a copy never holds Approvals or errors. The least recently saved copies are deleted first once they pass the storage limit, deleting a chat deletes its copy, and Clear local cache deletes them all.
_Avoid_: cache (for one chat's copy), offline mode

**Model pick**:
The model, reasoning effort and fast mode the composer starts new chats on. It is sticky: it stays after starting a chat, switching chats or restarting the app, and is kept on this computer only. It never changes the profile's default model in Hermes. Picking with a chat on screen switches that chat alone, and becomes the pick for new chats. Switching profile starts again from that profile's own model.
_Avoid_: default model (that is the profile's, in Hermes), current model

**Reasoning effort**:
How hard the model thinks before it answers: Off, Low, Medium, High, Extra high or Max. The pill beside the model picker shows it and changes it, and is hidden for a model without reasoning.
_Avoid_: thinking level

**Favorite model**:
A model the owner starred in the model picker. Favorites are listed first, and are kept on this computer even when Hermes no longer offers the model.
_Avoid_: pinned model (pinning is how Hermes stores Active, ADR 0002)

**Usage**:
The tokens a chat's model calls took in and gave out: input, cache read and written, output and its reasoning, and how many calls. A chat's usage is Hermes's own total for every call in it, from any client and across model changes. A reply's usage is shown only for a reply this app watched from start to finish, and is kept as long as its Saved copy.
_Avoid_: tokens (alone, for the whole breakdown), stats

**Cost**:
What a chat's usage cost, only as Hermes recorded it: reported by the provider, estimated, at least an estimate, included in a subscription, or unknown. It counts only the calls Hermes could price. The app keeps no prices of its own, and shows no cost per reply.
_Avoid_: price, spend, bill (except for a cost the provider reported)

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
