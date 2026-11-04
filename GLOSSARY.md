# Hermes Chat

A personal desktop chat client for one remote Hermes Agent server. Chats that need attention sit at the top; finished ones are settled out of the way.

## Language

**Chat**:
One Hermes conversation as this app shows it, with its full message history.
_Avoid_: session (Hermes's word for the same thing; keep it for server-side talk), conversation, thread

**Active**:
The state of a chat the owner is currently working in: any chat that isn't Settled. The list doesn't label it. An Active chat shows at the top of the list when it needs the owner or is done, in Working while Hermes replies in it, and in Snoozed while it is snoozed (ADR 0036). A chat becomes Active when the owner starts it in this app, or when the owner sends a message in it from this app.
_Avoid_: open, live, current

**Settled**:
The state of a chat the owner has put out of the way. Settled chats sit in a collapsed drawer at the foot of the list. Only the owner settles a chat; nothing settles on its own. A new message from another platform leaves a Settled chat where it is.
_Avoid_: archived, done, closed

**Settle** / **Unsettle**:
The owner's manual actions that move a chat from Active to Settled, and back. Both are the same icon-only button, named when hovered. Settling a snoozed chat forgets the snooze.

**Working**:
Where the list shows an Active chat while Hermes is writing a reply in it and isn't waiting on the owner. Nobody puts a chat there: it moves there when a reply starts, and back to the top once Hermes asks the owner something (an Approval) or the reply ends. A Settled or snoozed chat stays where it is while Hermes works in it.
_Avoid_: running (fine in conversation), busy, in progress

**Snoozed**:
An Active chat the owner has put out of the way until a time they chose. It sits in a collapsed section under Working, soonest to wake first, and shows when it wakes. When that time comes it goes back to the top of the list, as new as when it woke. Snoozes are kept on this computer only, for each connection and profile; Hermes and other Hermes clients don't see them (ADR 0036).
_Avoid_: hidden, deferred, reminder

**Snooze** / **Unsnooze**:
The owner's actions, from a chat's right-click menu, that snooze an Active chat (for 1 hour, 3 hours, until tomorrow at 9, until next Monday at 9, or for a duration or until a date and time the owner picks) and wake it early. Sending a message in a snoozed chat from this app wakes it. A new message from another platform doesn't. Settled chats can't be snoozed.
_Avoid_: remind me, defer

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

**Backup**:
A zip file of what Hermes Chat keeps on this computer, saved where the owner picks: settings and templates, and for each connection and profile, drafts, queued messages, project membership and defaults, tags and Saved filters, and branch origins. It never holds a password or other credential, the sign-in, or anything Hermes keeps on the server. **Restore a backup** checks all of it first, previews it, maps each of its connections and profiles to a profile here (only an identical one on its own), and writes each category by the owner's choice, Merge or Replace, after saving a recovery backup. Nothing restored is sent: queued messages come back paused (ADR 0038).
_Avoid_: export (that is one chat as Markdown), sync, restore (alone: that brings back an Archived chat), snapshot

**Rename**:
The owner's action that changes a chat's title, in every Hermes client. If the chat was renamed or edited elsewhere since the owner started, nothing is overwritten: the app shows the newer title and the owner chooses whether to save again.
_Avoid_: retitle

**Regenerate title**:
The owner's action that asks Hermes for a new title made from the chat's last five messages, then saves it as a Rename does. Asking adds nothing to the chat. If Hermes gives no usable title, the old one stays and the row says why. The title comes from the profile's Text generation model, which Hermes keeps and Settings → Model sets. If Hermes has no sign-in or key for that model's provider, the row says so, says how to fix it, and offers the setting. The app never tries another provider on its own.
_Avoid_: auto-title (Hermes's own titling of a new chat), retitle

**Unread**:
A chat with something new in it since the owner last opened it, in this app or any other Hermes client. It shows a dot, and so does the collapsed Settled header when a Settled chat is unread. A chat visible on screen never shows the dot. With two panes, both visible chats stay read; a pane hidden by the narrow-window switcher or Settings does not mark its chat read.
_Avoid_: new, unseen

**Source**:
The platform a chat was started on: this app, Telegram, Discord, the command line, the official Hermes desktop app, or a transcript file (an Imported transcript). A chat's source never changes, even after the owner replies from this app. Chats whose source is this app show no source icon.
_Avoid_: origin, platform (as an attribute of a chat)

**Imported chat**:
A chat whose source is anything other than this app. Imported chats start Settled.

**Imported transcript**:
A chat brought into Hermes from an export file with Import transcripts: a Hermes Chat Markdown export, or a Hermes session export (JSONL). Its Source is a transcript file (`import` in Hermes), in every Hermes client. It starts Settled and is read-only here: Hermes has its words, not everything the original chat had, so the owner starts a new chat to carry on. It is known by an id taken from the file, the session's own id or one made from the file's SHA-256, so the same file imported again adds nothing (ADR 0031).
_Avoid_: restored chat, backup, upload

**Import** (of transcripts):
Reading an export file the owner picks, checking all of it, showing what it holds and what won't come in, and only then having Hermes write its chats, all or none. Chats Hermes already has are skipped. It counts as imported once Hermes, read back, has each chat.
_Avoid_: restore, sync, upload

**Profile**:
A separate Hermes agent setup on the server, with its own chats. The app shows one profile's chats at a time. The profile switcher shows which other profiles have Unread chats, checked every two minutes, so it can lag behind.
Switching profile happens in place, with the same sign-in: the list shows what this computer saved for the profile, says it is connecting and loading, and is remembered for the next launch only once its chats load. If they can't, it says why and offers to try again or go back. Each profile keeps its own drafts, Saved copies and Model pick, and nothing that arrives for the profile left shows in the new one. If a reply is running or an Approval waiting, the switcher asks first. Hermes keeps the reply going, and the Approval waits until Hermes stops waiting; switching back brings both back.
_Avoid_: account, workspace, agent (as a name for a profile), connection (the sign-in, which covers every profile)

**Project**:
A named group of chats and of folders on the server, in one profile. Hermes keeps the project, its name and its folders, so other Hermes clients show it too. Which chats are in it is kept by Hermes when it has a membership store, so every computer shows the same, and on this computer only when it doesn't, which is every Hermes today (ADR 0033). Picking a project in the list shows only its chats; a chat started meanwhile goes in it. A chat can be in several projects, or none. Deleting a project keeps its chats in Hermes and its folders on the server.
_Avoid_: workspace, group, folder (for the project itself)

**Tag**:
A label the owner puts on chats, in one profile. A chat can have several tags, or none. The owner creates, renames and deletes tags; a renamed tag stays on its chats. No two tags in a profile share a name, whatever its case. Tags are kept on this computer only, for each connection and profile; Hermes and other Hermes clients don't see them (ADR 0026).
_Avoid_: label (in the app), category, folder, project

**Chat filter**:
What the search palette narrows the profile's chats by: words, Tags, Source, model, when the chat was last active, and whether it is Active, Settled or Archived. A chat must match every part. Hermes searches the words and lists the chats; the rest is checked on what Hermes answered, and the results say when more chats may match. Applying a filter changes no chat (ADR 0026).
_Avoid_: query, view

**Saved filter**:
A Chat filter the owner named, listed in its own section of the chat list and opened again from there. It is a search, not a group: unlike a Project, it puts no chat anywhere. Kept on this computer only, for each connection and profile (ADR 0026).
_Avoid_: smart folder, saved search (fine in conversation), view

**Membership** (of a project):
Which chats are in which project, one link per chat and project. Kept by Hermes when it answers `projects.membership.*`, and on this computer when it doesn't. Moving this computer's membership to Hermes shows a preview first and keeps a recovery copy. A change Hermes hasn't confirmed yet is **waiting to sync**. A change that another computer contradicted after this one last synced is a **conflict**: Hermes's version is shown until the owner keeps theirs or Hermes's (ADR 0033).
_Avoid_: sync conflict (for a change that is only waiting), assignment

**Folder** (of a project):
A path on the server that a project refers to, shown with the connection it is on. Hermes Chat adds only a folder that is already there, and never creates, moves or deletes one. A folder in a git repository shows its branch, and the repository's other worktrees that already exist can be added as folders too; Hermes Chat never creates a worktree.
_Avoid_: directory, workspace, repo (unless it is one)

**Project defaults**:
What a project gives the chats started while the list shows it: instructions, a model with its reasoning effort, and a working folder on the server. A new chat takes each from what the owner chose for it, then the project's default, then the profile's own, and its New chat pane says which. They are kept on this computer only, for each connection and profile; Hermes has nowhere to keep them. Saving them changes only chats started afterwards. A chat starts only in a folder that is on the server and that Hermes says it took; the instructions go in once, as a hidden message the model reads and no Hermes client shows. Apply the project's defaults asks first, and can change a started chat's model and folder, never its instructions (ADR 0017).
_Avoid_: project settings (the project screen also renames and deletes), workspace, system prompt (the instructions aren't one)

**Attachment**:
A local file the owner sends with a message: an image Hermes looks at, or any other file Hermes can read. Hermes takes images up to 25 MB and other files up to 256 MB.
_Avoid_: upload, file (when the attachment is meant)

**Screenshot**:
An image of a region or window of the owner's screen, taken from the composer by a shortcut or the camera button, and staged as an Attachment. It stays on this computer until the message is sent. Composer captures are deleted when removed or left behind; a failed or uncertain message keeps its Screenshot for Retry until confirmed, reconciled or dismissed.
_Avoid_: screen capture, snapshot

**Global shortcut**:
A key the owner sets in Settings that brings Hermes Chat's one window forward from any app, with the cursor in the selected pane's composer, and optionally hides it when it's already in front. It's registered the way the desktop allows: grabbed on X11, asked of the desktop portal on Wayland, or bound by the owner in the desktop to `hermes-chat --show` or `--toggle` where neither is possible. Settings shows what registered, never only what was chosen (ADR 0033).
_Avoid_: hotkey (fine in conversation), summon key, screenshot shortcut (that one works only inside the app, unless bound to `--screenshot`)

**Branch**:
A new chat that starts with another chat's history up to one message, made from that message with Branch from here. Hermes copies the history and keeps which chat the branch came from, so every Hermes client has it. Hermes copies what the owner and Hermes said, and Hermes's reasoning, but not tool outputs. A file a copied message refers to stays where it is on the server, for the branch to read while it's there. The chat it came from stays as it was. A branch has its own Draft and Queued messages, and what the owner sends goes to it alone. It is Active, runs on its parent's model in its parent's folder, and takes Hermes's name for it (the parent's title with a number) unless the owner gives one. Its top says where it came from. Which message that was is kept on this computer only. A branch can't be made while a reply is running or an Approval waits. Branching never undoes anything Hermes did on the server (ADR 0027).
_Avoid_: fork, copy, clone, thread

**Version** (of a turn):
Another take on one turn of a chat, made with Edit under the owner's message or Regenerate under the turn's last reply. Each version is a Branch made through the owner's message. Hermes takes back the branch's copy of the message, then the message goes again in the branch: the owner's new words for Edit, the same words for Regenerate. The chat it was asked from keeps its message, its answer and everything after. Under the turn's last reply, a switcher shows which version this chat is (2 / 3), whether it is the Original, Edited or Regenerated, and the model and settings it ran on, and opens the others. A turn is numbered by the owner's messages before it, so it is the same in a chat and its branches. Which turn a version is of is kept on this computer only. A message sent with an image can't be sent again, so it has no versions (ADR 0035).
_Avoid_: variant (in the UI), alternative, retry, rerun

**Draft**:
The text the owner has typed in a chat's composer and not sent. Each chat keeps its own draft, and so does the New chat pane, separately for each connection and profile. A draft is still there after switching chats or restarting the app. Sending or queuing it empties it. A message Hermes doesn't take becomes a Failed message, not a draft again. Only when a new chat can't be started does the text come back into the composer. Attachments aren't kept in a draft.
_Avoid_: unsent message, saved message

**Queued message**:
A message the owner lined up while Hermes replied, to go after the reply. Each chat has its own queue, and both panes of a chat show it. The owner can edit, reorder and remove queued messages, and pause and resume the queue. Hermes Chat sends them one at a time, each once the previous reply has ended and nothing in the chat waits on the owner. It sends them only while it is open, connected and showing their profile. The queue pauses on its own after a reply that was stopped, failed, or asked for an Approval. It also pauses when a queued message doesn't go, when the connection drops, and when the queue is loaded again after a restart or a profile switch. A queued message that goes becomes an outgoing message, and if Hermes doesn't take it, a Failed message. Queued messages and their attachments are kept on this computer, for each connection, profile and chat, never on the server (ADR 0018).
_Avoid_: pending message, scheduled message, Hermes's queue (Hermes's own queue holds messages sent while a turn runs; this app doesn't use it as the queue)

**Slash command**:
A command the owner types at the start of the composer, after a "/", picked from the menu that opens there or typed in full. Each is either an action of this app or a command Hermes runs for the chat, and says which. Only the commands in the app's list run; any other text starting with "/" is sent as an ordinary message. Picking from the menu only fills the command in; Enter then runs it. A command that can't run says why and keeps the text. Deleting asks first, as it does in the chat list (ADR 0015).
_Avoid_: quick command (Hermes's word for commands defined in its config), shortcut, macro

**Template**:
A message the owner reuses, kept in a library on this computer: a name, an optional description, the message with blanks to fill in (`{host}`, `{port=22}`, `{notes...?}`), and optionally the one project it is offered in. Filling one in shows the whole message as it will be; Insert puts it in the composer and never sends. With a draft already there, the owner chooses to replace it or add after it, and Cancel leaves it alone. Templates are data: nothing in one runs (ADR 0028).
_Avoid_: snippet, macro, prompt (for the template itself), quick command (Hermes's own)

**Dictation**:
Speaking a message instead of typing it. The microphone is open only between the owner starting a recording and pressing Done or cancelling. Hermes turns the recording into text with the profile's speech-to-text provider, and the text goes into the composer after anything already typed, for the owner to edit and send. Nothing reaches the chat until the owner sends it. Cancelling, or opening another chat, drops the recording. A recording Hermes couldn't transcribe is held in memory until the owner tries again or discards it. Recordings are never saved on this computer.
_Avoid_: voice message, voice mode (Hermes's own hands-free voice chat), speech input

**Read aloud**:
The owner's action that has Hermes speak one reply with the profile's text-to-speech provider, played on this computer. One reply plays at a time, and opening another chat stops it. The audio isn't saved.
_Avoid_: TTS, playback, voice mode

**Close to tray**:
The owner's setting that has closing the window hide it in the tray instead of quitting. It is off unless the owner turns it on, and works only while the desktop shows the tray icon; otherwise closing quits. A hidden window keeps its chats, drafts and replies coming in, but drops a Dictation recording and stops Read aloud, and the chat it shows doesn't count as on screen, so new replies leave it Unread. The tray menu, the global shortcut, or launching Hermes Chat again brings back the same window. Quit in the tray menu always exits. The setting is kept on this computer (ADR 0034).
_Avoid_: minimize to tray, background mode, run in background

**Failed message**:
A message sent from this app that Hermes didn't take, or may not have. Either the connection dropped, or the app closed, before Hermes confirmed it. It stays in its chat with its words and files, says why, and offers Retry, Edit and Dismiss. Retry sends the same words and files again as a new message. Edit takes the words back into the composer. Nothing sends it again on its own. For one Hermes may have, the chat's history is read back once Hermes is connected. If the history has it, the message shows from the history. If not, it is marked failed (ADR 0006). Failed messages are kept on this computer, and Clear local cache keeps them.
_Avoid_: undelivered, pending, unsent message

**Stopped**:
A reply the owner, or another Hermes client, interrupted before it finished. The reply keeps what it had said and is labelled Stopped. The message it answered was sent, so it isn't a Failed message.
_Avoid_: cancelled, failed

**Approval**:
Hermes asking the owner before it runs a command it counts as dangerous. It shows as a card in the chat, and the reply waits until the owner approves or denies it, Hermes stops waiting, or the reply is stopped. The card offers only the answers Hermes offers: once, for the rest of the chat, always, or deny. The two broader grants ask the owner to confirm first.
_Avoid_: permission, confirmation, prompt

**Toolset**:
A named group of tools Hermes can offer the model, such as Web Search or Terminal. Which toolsets are on is a setting of the profile, kept by Hermes on the server: the list new chats in the profile start with, in every Hermes client, unless the server pins its own or the profile's coding focus mode picks one in a code workspace. A change reaches chats Hermes starts, or opens again, afterwards. A chat Hermes already has open, and a reply running in it, keeps the tools it started with, on its next turns too. Settings → Toolsets says a change is saved only once Hermes reads it back that way. It also shows, apart from the profile's setting, what the open chat has, as Hermes reads it for that chat. The profile's list is **inherited** while the profile hasn't saved one of its own: it is Hermes's default. A toolset is **forced off** when `agent.disabled_toolsets` turns it off on every platform, whatever the list says. A toolset being on doesn't let Hermes run anything it would otherwise ask about: Approvals and YOLO decide that.
_Avoid_: tool permissions, capabilities, plugins (a plugin can bring a toolset, but isn't one)

**Inbox**:
The list, opened from the rail, of what needs the owner or has finished in any profile on the server: a reply running, an Approval waiting, a failure or Failed message, or a chat with something new. Each entry names its profile and chat, says when, and opens the chat in its profile. Nothing is answered, retried or sent from it. Dismissing an entry takes it out of the inbox only, on this computer: the chat stays Unread, Active or Settled, and Archived or not, as it was. An entry shows again only for something newer. Running work in other profiles shows only for chats the dashboard itself runs (ADR 0019).
_Avoid_: notifications, activity, feed

**Chat link**:
A `hermes-chat://` link that opens one chat in its profile, made with Copy chat link. It holds only ids: a random reference this computer made for the connection, the profile's name and the chat's id, never an address or sign-in. Opening one checks everything first (the connection is the one signed in, Hermes is connected, the server has the profile and the profile has the chat), then switches profile if it must, asking first as the switcher does, and opens the chat. If a check fails, nothing on screen changes and a notice says why. A link only ever opens a chat: it never sends, runs, answers or signs in to anything. It opens on the computer it was copied on; one from elsewhere opens only when the owner says it is for the connection signed in (ADR 0037).
_Avoid_: deep link (fine in conversation), share link (nothing is shared with anyone), URL (for the link itself)

**Logs**:
The screen, opened from the rail, that shows one source at a time: this app's own diagnostics (connection changes, failures it showed, uncaught errors), or one of the profile's Hermes logs (agent, errors, gateway, MCP servers). Following reads a Hermes log's last 500 lines every 2 seconds while it is on screen. Notes in the list mark where reading stopped and started again, and where lines may be missing. Pausing keeps the view still while reading carries on. Every line is redacted before the app keeps it. Nothing is kept after Logs closes, except this app's diagnostics, which last until the app quits (ADR 0033).
_Avoid_: console, debug log, activity

**Support bundle**:
One text file, saved where the owner picks, with every line kept of the sources they tick on the Logs screen. Before saving it shows what goes in, how many of each kind of secret were redacted, and that redaction can miss a secret written another way. It is never uploaded (ADR 0033).
_Avoid_: debug report, debug share (Hermes's own, which uploads to a paste service)

**Saved copy**:
The transcript of a chat the owner opened lately, kept on this computer so it can be read while Hermes can't be reached, even after a restart. It shows with a note saying when it was saved, until the chat loads from Hermes again. Each connection and profile keeps its own, without the password. A copy never holds Approvals, errors or Failed messages. The least recently saved copies are deleted first once they pass the storage limit, deleting a chat deletes its copy, and Clear local cache deletes them all.
_Avoid_: cache (for one chat's copy), offline mode

**Model pick**:
The model, reasoning effort and fast mode the composer starts new chats on. It is sticky: it stays after starting a chat, switching chats or restarting the app, and is kept on this computer only. It never changes the profile's default model in Hermes. Picking with a chat on screen switches that chat alone, and becomes the pick for new chats. Switching profile starts again from that profile's own model.
_Avoid_: default model (that is the profile's, in Hermes), current model

**Memory**:
What Hermes remembers about the owner and their work between chats, for one profile. Hermes keeps it on the server in two files: its own notes, and what it knows about the owner. Each is a list of entries. The agent adds, changes and removes entries during chats; the owner can change or remove one in Settings → Memory, which saves to the server and reads it back. Hermes reads memory into a chat when the chat starts, so an edit reaches chats started after it. Only the profile the Hermes dashboard runs as can be edited from this app. What a save from here replaced can be put back with Restore previous version until sign-out or quit, while the entry still holds what was saved; it's kept in the app's memory only (ADR 0040).
_Avoid_: notes, knowledge, context (for memory), cache (a Saved copy is not memory)

**Skill**:
Instructions Hermes can load for a kind of task: a folder on the server holding a SKILL.md, whose front matter gives the skill's name and description, and sometimes other files the skill names. The agent sees each skill's name and description in every chat, and loads the rest when it needs it. A skill is the profile's own, in its skills folder, or shared, in a folder the profile's config names that other profiles may use too. Settings → Skills turns one on or off for the profile and edits its SKILL.md, saying either worked only once Hermes, read back, has it so (ADR 0030). An edit reaches the agent's next load of the skill in any chat; turning one off keeps it out of new chats and refused in all of them.
_Avoid_: plugin, tool, toolset (a toolset is a group of tools, not instructions), command (a skill can also be run as a slash command in other Hermes clients, but isn't one here)

**Reasoning effort**:
How hard the model thinks before it answers: Off, Low, Medium, High, Extra high or Max. The pill beside the model picker shows it and changes it, and is hidden for a model without reasoning.
_Avoid_: thinking level

**Favorite model**:
A model the owner starred in the model picker. Favorites are listed first, and are kept on this computer even when Hermes no longer offers the model.
_Avoid_: pinned model (pinning is how Hermes stores Active, ADR 0002)

**Setup**:
The steps that connect Hermes Chat to a Hermes server: the server, the dashboard sign-in, then optionally a Provider key. Setup tests the connection before it keeps anything, and says what to fix when the test fails. It opens by itself only on a computer with nothing set up, and again from Settings or the sign-in screen. Cancelling it leaves the connection as it was.
_Avoid_: onboarding (fine in conversation, not in the app), wizard, first-run (that's only when setup opens by itself)

**Provider key**:
A model provider's API key that the owner gives Hermes through Setup. The provider checks it first. Hermes keeps it in the profile's `.env` on the server, and Hermes Chat never stores it.
_Avoid_: token, secret, credential (too broad)
**Usage**:
The tokens a chat's model calls took in and gave out: input, cache read and written, output and its reasoning, and how many calls. A chat's usage is Hermes's own total for every call in it, from any client and across model changes. A reply's usage is shown only for a reply this app watched from start to finish, and is kept as long as its Saved copy.
_Avoid_: tokens (alone, for the whole breakdown), stats

**Cost**:
What a chat's usage cost, only as Hermes recorded it: reported by the provider, estimated, at least an estimate, included in a subscription, or unknown. It counts only the calls Hermes could price. The app keeps no prices of its own, and shows no cost per reply.
_Avoid_: price, spend, bill (except for a cost the provider reported)

**Usage analytics**:
The rail's Usage screen: the Usage and Cost Hermes stored for each chat started in a period, added up across chats, models, where chats started, projects, profiles and days. A chat counts in the period it started in, with all its usage so far, and a compressed chat counts once. The total cost says how much of the usage Hermes priced and is never a bill. Hermes's own sums sit beside it for a period ending now, with its helper tasks and subagent runs, which no chat carries. Nothing is kept on this computer; Export CSV saves the chats counted where the owner picks (ADR 0026).
_Avoid_: dashboard, stats, report, billing

**Context window**:
What the model reads on each call in a chat: Hermes's instructions, the tool descriptions, instruction files, memory, and the conversation, up to the model's limit. The status bar's meter shows how full it is, and its **context inspector** shows what fills it, as Hermes measures and estimates it. Hermes's total is labelled Exact (the provider's count), Partly estimated, or Estimated; its split by category is always its estimate (ADR 0025).
_Avoid_: context (alone, for memory), prompt, tokens (for the window)

**Compaction**:
Hermes swapping a chat's older messages for one summary that the model reads in their place, when the window fills or when the owner asks with **Compact now**. Every message stays in the chat and in Hermes, but the model no longer reads the ones taken out word for word. The context inspector lists the compactions Hermes stored, with the summary it kept. Compact now asks first, and is offered only between replies on a Hermes that can compact.
_Avoid_: compression (Hermes's word, fine in server-side talk), summary (that is what a compaction leaves), truncation

**Side panel**:
The resizable panel beside the chat, with four tabs: Preview, Terminal, Files and Screen. It opens from the chat's header, and at a tab from the rail, a link or a tool call. In a window too narrow for both, it covers the chat until the owner goes back to it. Closing it, or going to another tab, leaves what runs in it running (ADR 0039).
_Avoid_: drawer, sidebar (that is the chat list), inspector

**Preview**:
The Side panel's tab that shows a web page, a Server file, a Local file or a tool call's output. It opens from a link in a reply or from an opened tool call. What it shows can't reach the app, the sign-in or this computer's other files (ADR 0007). A web page whose site refuses to be shown inside other apps gets a note and Open in your browser instead (ADR 0011).
_Avoid_: preview pane (its name before the Side panel), viewer, artifact (the official desktop app's word)

**Server file**:
A file on the Hermes server, by its full path there. Hermes reads it, and Hermes may refuse, for example a file with credentials. Paths in tool calls are Server files, since that is where Hermes runs its tools.
_Avoid_: remote file

**Local file**:
A file on this computer that the owner picked to preview in the Open dialog. Hermes Chat reads it, and it isn't sent to Hermes.
_Avoid_: attachment (that is a file sent with a message)

**Extra request header**:
A header name and value the owner adds to a URL connection, for a gateway in front of the dashboard such as Cloudflare Access. Hermes Chat sends it with every request to that dashboard and never to another site. Its value is kept in the system keyring and never shown in Settings (ADR 0006).
_Avoid_: custom header, gateway token

**Server files** (the Files tab):
The Side panel's browser for the Server files on the machine the Hermes dashboard runs on. It lists folders through the dashboard's managed files, as the server's own user can open them, the same for every profile, and never shows credential files such as `.env`. The server may limit it to one folder. Nothing on this computer is shown there. A file can be downloaded from it, a file the owner picks can be uploaded into the folder on screen, and a text file can be edited; nothing else on the server can be changed from it (ADR 0012, ADR 0023, ADR 0024).
_Avoid_: remote files, file manager, workspace (Hermes's word for a session's working folder)

**Download** (of a Server file):
Saving a copy of one Server file on this computer, where the owner picks in the Save dialog, which asks before replacing a file. It shows the server path, where it goes, and how far it got, and Cancel stops it. Until every byte has arrived, nothing takes the place of the file already there. It stops if the connection closes or changes (ADR 0025).
_Avoid_: export (that is a chat saved as Markdown), save

**Upload** (to the server):
Sending one file the owner picked on this computer into the folder Server files shows. Before anything is sent, it shows where the file goes. If the name is taken, the owner chooses to keep both or replace. Hermes is asked not to replace a file unless the owner chose that; it checks just before writing, not at the same moment. It counts as uploaded once the folder, listed again, has the file at the size sent. Credential files such as `.env` are never uploaded over (ADR 0025).
_Avoid_: attach, attachment (that is a file sent with a message), sync

**Edit** (of a Server file):
Changing a text file on the server from Server files, and saving it back. Save shows the changes first, and writes only if the server still has the version the edit started from. It counts as saved once Hermes, read back, has the edit. If the file changed on the server, nothing is written, and both versions stay: the owner merges them, takes the server's, or saves theirs as a copy (ADR 0024).
_Avoid_: patch, sync, overwrite

**Repository**:
The rail's screen for a Git checkout on the Hermes server: its folder, branch, upstream, and changed files with their diffs. It reads through the owner's own ssh, the Terminal's target or the sign-in's, not through the dashboard, so it works while Hermes is away. Git runs there as the SSH user, with that user's config, hooks and credentials (ADR 0034).
_Avoid_: repo (in the interface), project (a Project is Hermes's group of chats and folders), workspace

**Staged** / **Not staged** / **Untracked**:
Where a change in the Repository screen is. Staged changes are in Git's index, what the next commit would hold. Not staged changes are in the working tree only. An Untracked file isn't in Git yet. One file can have changes in both of the first two, and the screen shows each side's diff on its own.
_Avoid_: cached, added (for staged), dirty, unversioned

**Commit preview**:
What the Repository screen shows before it commits: every staged file, the whole staged diff, the message exactly as it will be committed, the author, the branch and the commit it goes on top of, and the hooks that will run. Commit happens only if the repository still has exactly that, on the same branch; otherwise nothing is committed and the preview is read again.
_Avoid_: dry run, summary

**Push** / **Create pull request**:
The Repository screen's two separate ways to publish a branch. Push sends the commit shown to the remote branch shown, with the server's own credentials, and never forces. Create pull request asks GitHub, through `gh` on the server, for a pull request from a branch the remote already has. It never pushes. Each goes only where it showed: if the branch, its commit, the remote's URL or its GitHub repository changed meanwhile, it's refused and nothing is sent.
_Avoid_: publish (for either one alone), sync, ship

**Terminal**:
The Side panel's tab with the owner's own shells: one on the Hermes server, through their ssh to the sign-in's SSH target or one typed for it, and one on this computer, their login shell. ssh asks there for anything it needs, such as a passphrase or a new host key. Each session runs on while the other is shown or the panel is closed, and the rail shows it; signing out ends both. They are the owner's shells, not Hermes's: nothing typed there reaches a chat, an Approval or the agent (ADR 0022, ADR 0039).
_Avoid_: console, shell (for the tab), Hermes's terminal tool (the agent's, which runs in a chat)

**Screen**:
The Side panel's view of Hermes's Bot Desktop for the profile shown: a desktop on the server where the agent's computer use and its browser run. The owner watches it, and can Take over and Hand back. Hermes starts, stops and keeps it, one per profile; this computer only shows it (ADR 0039).
_Avoid_: remote desktop, VNC, browser (for the whole screen), computer use (that is the agent's tool)

**Take over** / **Hand back**:
The owner's actions that make their keys and pointer drive the Screen, and give it back to the agent. While the owner holds it, Hermes's computer use waits. Another viewer taking over puts the owner back to watching; leaving the Screen hands back.
_Avoid_: control, lease (Hermes's word, fine in server-side talk), takeover (as a verb)

**Output**:
A Server file that one of Hermes's tools reported writing in a chat: `write_file`, a file `patch` created, `text_to_speech` audio or an `image_generate` image. It is known by its path, the tool call that made it, and that call's chat. A path a reply or another tool only mentions isn't an Output. The same path written twice is two Outputs, two versions, and only the newest is what the path holds now. The owner can also add a Server file to Outputs by its path. Outputs shows them for the open chat, the project the list shows, or every chat in the profile, and says when a file was last found at its path. This computer keeps only their paths and where they came from (ADR 0016).
_Avoid_: artifact for an Output in general (the official desktop app's word, which also counts mentioned paths and links; here an **Artifact** is an Output open to edit), attachment, generated file (in the app's text)

**Artifact**:
An Output that is a text file, open to edit in the Preview beside the chat. It is one path on one machine (where the profile's tools run, or the dashboard's own), opened in one connection and profile. Its draft stays in this app's memory, apart from the file, until Save. Save writes only if the server still has the version the edit started from, and counts as saved once Hermes, read back, has it. "Ask Hermes to edit" gets a **proposal**: Hermes's new text for the selection, made against the editor's exact text, which the owner reviews and applies to the editor, never straight to the file. The versions a save replaced stay recoverable until the app quits or the owner signs out (ADR 0029).
_Avoid_: document (any file), canvas, patch (for the proposal before it's applied)

**Unsecure**:
The warning on a connection whose traffic between this app and the server isn't encrypted.
_Avoid_: insecure (the app's label is "Unsecure"), unsafe

**Persona**:
A profile's SOUL.md on the Hermes server: who Hermes is and how it speaks in that profile's chats. Settings → Persona edits the shown profile's file as plain text. A Save writes only if Hermes still has what the edit started from, and the app says it saved only once Hermes, read back, has it. If the file changed elsewhere, nothing is written until the owner chooses. Chats started afterwards use the new persona; a chat under way keeps the one it started with. Hermes needs no restart, and the app never restarts it. An edit not saved stays on this computer, per connection and profile, and the last five versions that saves from here replaced are kept to put back.
_Avoid_: soul, personality (Hermes's `/personality` presets are another thing), system prompt

**Scheduled job**:
A Hermes cron job in one profile: a prompt Hermes runs at the times its schedule sets, delivering the reply where the job says. Hermes keeps the job on the server and its gateway runs it there, so it runs while Hermes Chat is closed. The Scheduled jobs screen lists the profile's jobs with their schedule, time zone, next run and last result, and creates, edits, pauses, resumes, runs and deletes them through Hermes. A change shows only once Hermes, read back, has it. Deleting a job, or running it now, asks first (ADR 0013).
_Avoid_: cron (Hermes's name, fine in server-side talk), task, automation, reminder

**Automation**:
A Hermes webhook route in one profile: when GitHub sends an event to it, Hermes checks the event's signature, filters it, and starts a task with a prompt made from the event. Hermes keeps the route and runs the task on the server, so it works while Hermes Chat is closed. The Automations screen sets routes up, previews what an example event would do, and shows what became of the events that arrived (ADR 0036).
_Avoid_: webhook (fine for the transport), trigger, hook, scheduled job (that runs on a clock, not on an event)

**Delivery**:
One event a provider sent to an Automation, identified by the provider's delivery id. Its state says what Hermes did with it: received, filtered out, waiting to coalesce, replaced by a later event, queued, running, completed or failed. A request whose signature, size or timing didn't check out isn't a delivery: it is only counted. A copy of a delivery, or its signed body sent again under a new id, is counted on it and never runs again.
_Avoid_: event (the provider's word for what's inside), request, hit

**Run now**:
The owner's action that has Hermes run a Scheduled job at once, on the server, as its schedule would: a real run with the job's real delivery. Hermes answers when the run has finished, and resumes the job if it was paused.
_Avoid_: trigger, test run

**Pane**:
One view of a chat, its transcript and composer. The app can show two side by side. The focused pane is the one the
chat list, Search and keyboard shortcuts target. This focus does not change whether a chat is Active or Settled.
Two panes of one chat share its Draft, Queued messages and running reply; each has its own scroll, Find and pending
Attachments.

**Update**:
A newer version of Hermes Chat itself. For the packaged app, the owner installs it with pacman, and the app never replaces pacman's files. For a standalone build made with an update key, the app installs it, after checking its signature. Either way the new version runs only after the owner restarts the app, and drafts and unsent messages are kept across the restart.
_Avoid_: upgrade (pacman's word, for the package step only)

## Relationships

- Every **Chat** is either **Active** or **Settled**, never both. An **Archived** chat keeps that state for when it is restored.
- An **Active** chat shows in one place in the list: **Snoozed** if it is snoozed, **Working** if Hermes is replying in it, otherwise at the top.
- Every **Chat** has exactly one **Source**.
- Every **Chat** belongs to exactly one **Profile**; Active and Settled are kept per profile.
- An **Imported chat** becomes **Active** only when the owner sends a message in it from this app.
- An **Imported transcript** is an **Imported chat** that stays **Settled** until the owner unsettles it: nothing can be sent in it from this app.
- A **Branch** has exactly one parent chat, in the same **Profile**; a chat can have any number of branches.
- Every **Screen** belongs to exactly one **Profile**; switching profile shows the other profile's.
- Every **Version** of a turn is a **Branch**; a turn's versions share one root chat, whose own answer is the Original.
- Every **Project** belongs to exactly one **Profile**. A **Chat** can be in any number of its profile's projects, or none; being in one doesn't change whether it is **Active**, **Settled**, **Archived** or **Unread**.

## Flagged ambiguities

- **Screen** vs a web page in the **Preview**: both can show a site, but the Screen's browser runs on the server and is the agent's, with its sign-ins; the Preview loads the page on this computer, isolated from the app, and is the owner's alone.
- **Artifact** vs **Edit** (of a Server file): both edit a text file's text with the same checked save, but an Artifact is an Output, edited beside the chat on the machine its tool wrote it on, with Hermes's proposed edits and kept versions. A Server file edit is made in the Files tab and only reaches the dashboard's machine.
- **Output** vs a path in a reply: Outputs counts only what a tool's own result says it wrote. A reply that says "saved to /srv/x.pdf", or a `terminal` command that creates a file, makes no Output, though the owner can add that file by its path.
- **Settled** vs **Archived**: they are different things. Archiving sets Hermes's own "archived" flag and hides a chat in every Hermes client; settling is this app's view of the owner's attention, stored as the "pinned" flag. Neither touches the other (ADR 0005).
- **Queued message** vs **Draft** vs **Failed message**: a Draft hasn't been sent or queued; a Queued message waits in the chat's queue to be sent by this app; a Failed message was sent, and Hermes didn't take it or may not have. A queued message that goes leaves the queue, and becomes a Failed message only if Hermes doesn't take it.
- **Imported chat** vs pulling older history: the list holds the past month's chats until the owner pulls older history in Settings, after which it holds all of the profile's chats. Pulled chats come in Settled unless pinned, but they are Imported chats only if their Source isn't this app.
- **Imported chat** vs **Imported transcript**: an Imported chat is any chat started outside this app, which the owner can carry on here. An Imported transcript was made from an export file, has the Source `import`, and is read-only here.
- **Restore** (an Archived chat) vs **Restore a backup**: the first is Hermes's, for one chat; the second writes this computer's own data from a Backup file, and changes nothing on the server.
- **Import** vs **Export** and **Upload**: Export saves one chat as a file on this computer; Import makes chats in Hermes from such a file; Upload puts a file on the server's disk, not in a chat.
- **Draft** vs the New chat pane: the code also calls the pane for a chat not started yet "the draft". In this glossary a Draft is only the composer's unsent text.
- **Toolset** vs **Approval** and YOLO: a toolset decides which tools the model is offered at all; an Approval, and YOLO, decide whether a command Hermes counts as dangerous runs without asking. Turning a toolset on or off changes neither. Speech-to-text is listed among the toolsets because Hermes lists it there, but it has no tools: its switch is the profile's `stt.enabled`, which Dictation uses.
- **Dictation** and **Read aloud** vs Hermes's voice mode: Hermes's `/voice` mode (`voice.record`, `voice.tts` over the socket) records with the server's own microphone and speaks through the server's speakers. This app never uses it. Dictation records on this computer, and both use the server only to transcribe and to make the audio.
- **Automation** vs **Scheduled job**: both start Hermes tasks on the server, an automation when an event arrives, a scheduled job at set times. A route can also start a scheduled job on each event (`cron_job`); Hermes Chat shows such a route but doesn't set it up. An automation's tasks are `webhook` sessions, listed among the chats as from another Hermes platform.
- **Retry** (of a Delivery) vs **Retry** (of a Failed message): retrying a delivery has Hermes run the stored event again as a new task on the server, through the automation's rules as they are now; it never undoes what the failed attempt did.
- **Scheduled job** vs its runs: each run of an agent job is a Hermes session with source `cron`. The chat list leaves those out; the job's runs show on the Scheduled jobs screen.
- **Branch** vs Hermes's other children of a session: Hermes also gives `parent_session_id` to a chat it compressed onto a new session, and to subagent and tool sessions. Only one made with Branch from here is shown as a Branch, with where it came from. Hermes stores a branch made here with source `tui`, because of how the legacy resume records the live session; the app shows it as this app's chat (ADR 0027).
- **Edit** (of a message) vs **Edit** of a Failed message vs **Edit** of a Server file: Edit under a message Hermes has makes a Version in a new branch and never changes the chat. Edit on a Failed message takes its words back into the composer. Edit of a Server file changes that file. **Regenerate** (a reply) makes a Version too; **Regenerate title** only renames the chat.
- **Source** vs the `source` field on a Hermes session: the app derives a chat's Source from that field, but the field has more values than the app shows. `gui` (what this app stamps on chats it starts) and `hermes-chat` (what it stamped before; Hermes won't edit those) count as this app, and `cli` and `tui` as the command line. `cron` chats aren't listed, and any other value (for example `api_server`, `webhook`) shows as "another Hermes platform".
- **Context window** vs **Usage**: the window is what the model reads on one call, now. Usage, cache reads included, adds up over every call in the chat, so a chat's cache reads can far exceed its window. The context inspector shows the cache as billing, apart from the window's size.
- **Memory** vs a **Saved copy** and the local cache: memory is the agent's, on the server, and changes what Hermes knows. Saved copies and drafts are this computer's copies of chats and change nothing in Hermes. Memory vs a memory *provider*: a profile may also use an external provider (such as Honcho) whose memories live with that provider; Settings → Memory names it but doesn't show or edit what it stores.
- The project the list shows vs Hermes's *active* project: Hermes keeps one active project per profile for its own CLI and the official desktop app (`projects.set_active`). Picking a project in this app's list never changes it; the pick is kept on this computer.
- **Persona** vs Hermes's personalities: `/personality` and `agent.personalities` in Hermes's config are named presets laid over a chat's prompt. Settings → Persona edits only the profile's `SOUL.md`. It never sets or changes a personality.
- **Project** vs a chat's working folder: Hermes also groups chats by the folder each one runs in (`cwd`). This app doesn't: a chat is in a project only when the owner put it there, or started it while the list showed the project. Putting a chat in a project doesn't change the folder it runs in. Only a project's default folder, or Apply the project's defaults, sets the folder a chat runs in, so other clients may then group that chat by it.
