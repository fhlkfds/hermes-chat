# Tags and Saved filters are kept on this computer, and a filter checks what Hermes answered

A **Tag** is a label the owner puts on chats, several to a chat. A **Saved filter** is a named chat filter the owner opens again from the list. Hermes has nowhere to keep either. At the deployed `bf0203a`, a session edit (`PATCH /api/sessions/{id}`) takes only `title`, `archived`, `hidden`, `pinned` and `unread`. No route, table or JSON-RPC method stores labels or saved queries (`hermes_cli/web_routers/sessions.py`, `hermes_state_common.py`, read on the server's own checkout). So both are kept on this computer, in one versioned localStorage document (`hermes-chat.tags`), separately for each connection and profile, under the same scope key as project membership (`projectScope`, ADR 0007). Nothing about them is sent to Hermes.

## Tags

- A tag is known by a random id. Renaming it keeps the chats it is on, and a Saved filter names tags by id.
- Names are trimmed, their runs of white space become one space, and they are put in Unicode NFC form. A name can be up to 40 characters, counted as code points, so emoji and every script work. Control characters and the bidirectional overrides that reorder text are refused, so one name can't be made to look like another.
- Two tags in a profile can't share a name, compared without case after normalisation (`localeCompare` at accent sensitivity): "Work" and "work", or "Été" and its decomposed form, are the same name. A tag can change its own name's case. The same name in another profile is a different tag.
- Deleting a tag takes it off every chat. A Saved filter that names it keeps the id, and says the tag was deleted and that nothing can match, rather than quietly matching more chats.
- Deleting a chat takes its tags with it. Clear local cache leaves tags alone, as it leaves project membership.

## Chat filters

A chat filter has words, tags (a chat must have every one), sources, a model (part of its name, without case), a last-activity range in local days, and a state: Active and Settled (the default, as the list), Active, Settled, Archived, or all of them. It always applies to the profile on screen. Searching other profiles isn't supported: tags are per profile, and opening a result in another profile would need the profile switch first.

It reuses the reads the app already makes, rather than a search path of its own:

- **With words:** `GET /api/sessions/search`, as Ctrl+K always did. Hermes narrows by source itself when the filter names only sources it can tell apart (`sources=gui,hermes-chat` for this app; Telegram, Discord, the desktop app, and `cli,tui`). "Other platforms" means every other source, so it is checked here. Search rows carry `model`, `last_active` and `archived`. With any filter beside the words, Hermes is asked for its most results, 100.
- **Without words:** `GET /api/sessions?order=recent&archived=exclude|only|include`, every page up to 20 pages of 100, however old, so a chat older than the list's month is found. Each page also carries every pinned chat, and these are counted once.
- Tags, model, dates and state are checked on what Hermes answered. Active and Settled come from the list's own copy of a chat when it has one. A search match the list doesn't hold is Settled, since every pinned chat is in the list (ADR 0002).

The results say when they may be incomplete:

- Hermes gave as many as it would: the search's 100, or 20 pages of the list.
- A model filter met chats that Hermes recorded no model for. They are left out and counted.
- The filter names a deleted tag.

Running a filter only reads. It marks no chat read, changes no chat's state, and puts nothing in the list or in a project. Opening a result does what opening a search result always did: the chat goes in the list, Settled, and the transcript goes to the message that matched.

## Saved filters and bulk edits

- A Saved filter keeps the filter as tidied (blanks dropped) under a name, unique in the profile by the same rule as tags. The list shows Saved filters in their own section, with a filter icon, apart from the project switcher. Opening one runs it again; it doesn't group chats, and deleting one deletes no chat and no tag.
- A bulk tag edit adds a tag to, or takes it off, the chats in the results. The owner picks the tag and sees how many chats would change, which ones, and how many are already so, then confirms. Nothing is written before that. Cancel or Escape writes nothing. The edit changes only the previewed chats, in one write of the whole document, so it is kept whole or, if the write fails (storage full), not at all, and the error says nothing changed. If the tag was deleted in another window meanwhile, it is refused.
- Each change reads the stored document again first, so another Hermes Chat window's change is kept. The windows watch the `storage` event to show each other's changes.

## Considered options

- **Tags in Hermes, as session titles or as a project per tag.** Rejected. A title is shared with every client and is the chat's name. Projects are Hermes's, with folders, and would show up in the official desktop app.
- **Filtering only the chats the list has loaded.** Rejected. It would miss chats older than a month and archived chats, and call that the result.
- **A server-side filter.** Hermes's search takes `q`, `limit`, `source`, `sources` and `exclude_sources` only. A route that took `model`, a date range, `pinned`/`archived` and a page cursor would make the "more may match" note unnecessary. Tags would still need a session label table (`session_labels(session_id, label)`) and a PATCH field to be shared between clients.

## Consequences

- Tags and Saved filters don't sync between computers, and other Hermes clients don't see them.
- A profile with more than 2,000 chats is checked to its 2,000 most recent when a filter has no words, and the results say so.
- With words, the filters beside them narrow Hermes's best 100 matches, not every match. The results say so when Hermes gave 100.
- A server older than the `model` field in search and list rows shows every chat as having no recorded model, so a model filter matches nothing and says how many it couldn't judge.
