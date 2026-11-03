<img src="assets/icon.svg" width="64" height="64" alt="">

# Hermes Chat

Hermes Chat (`hermes-chat`) is a personal desktop chat client for one remote [Hermes Agent](https://github.com/NousResearch/hermes-agent) server, built for Arch Linux. It signs in to the Hermes web dashboard, either through an SSH tunnel or at a dashboard URL. Through the dashboard, it lists, searches, and continues the chats of each Hermes profile.

Created in [T3 Code](https://t3.codes).

![Hermes Chat with a chat open, showing a reply with a table and the status bar](docs/screenshots/readme/chat.png)

The application is built with Tauri 2, React 19, and TypeScript, and it uses Vite and Vitest. The Rust side handles all network traffic to Hermes: the SSH tunnel, HTTP sign-in, the dashboard REST relay, and the JSON-RPC WebSocket. Web pages in the preview pane and images in replies load in the webview. It also handles the system keyring, desktop notifications, screenshots, and file access. The window is WebKitGTK (`webkit2gtk-4.1`).

## Contents

- [Server requirements](#server-requirements)
- [Features](#features)
- [Install on Arch Linux](#install-on-arch-linux)
- [Updates](#updates)
- [Development](#development)
- [Project defaults](#project-defaults)
- [Connecting to Hermes](#connecting-to-hermes)
- [What is stored where](#what-is-stored-where)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Project documents](#project-documents)
- [License](#license)

## Server requirements

- A Hermes Agent server that runs the web dashboard (`hermes dashboard`). The dashboard serves the REST API under `/api/` and the JSON-RPC WebSocket at `/api/ws`. The app was developed against Hermes at commit `bf0203a`. Other versions can differ.
- Username and password sign-in on the dashboard (the dashboard's `basic` provider). The app doesn't support token, OAuth, or OIDC sign-in.
- The dashboard's legacy session protocol. If `gateway.ready` reports `session_authority` (the canonical protocol), the app stops and says that it doesn't support that protocol yet.
- For SSH: the dashboard must listen on port **9119** on the server's loopback address. The tunnel always forwards to `127.0.0.1:9119` on the server.
- For voice: speech-to-text and text-to-speech providers set up for the profile on the server (`hermes tools`).
- For Projects: a Hermes that has the `projects.*` methods. Without them, the chat list works and the project switcher says that Hermes needs an update.
- For Toolsets: the dashboard's `GET /api/tools/toolsets` and `PUT /api/tools/toolsets/{name}` routes, which Hermes at `bf0203a` has. Without the first, Settings → Toolsets says that this Hermes doesn't list toolsets; without the second, it shows each toolset's state without switches.
- For the inbox's running and waiting work in other profiles: legacy `session.active_list` on the dashboard socket, which Hermes at `bf0203a` has. Without it, the inbox still lists Unread chats and Failed messages in every profile, and the shown profile's running replies and Approvals, and says it can't see running work elsewhere.
- For Outputs: a dashboard that serves `GET /api/sessions/{id}/messages` with tool rows (`tool_name`, `tool_call_id` and the stored result) and `GET /api/fs/list`, as `bf0203a` does. Files are found only in the stored results of `write_file`, `patch`, `text_to_speech` and `image_generate` with the result fields `bf0203a` writes. Without the routes, Outputs says which one is missing. Older tool results that don't name their file are counted, and the chat is labelled partial.
- For Persona: the dashboard's `GET` and `PUT /api/profiles/{name}/soul` routes, which Hermes at `bf0203a` has. Without them, Settings → Persona says that this Hermes can't edit personas, and reads or writes nothing.
- For Hermes's slash commands (`/steer`, `/context`): a Hermes whose `/api/ws` answers `commands.catalog`, `command.dispatch` and `slash.exec`, as `bf0203a` does. Without `commands.catalog`, those commands say that Hermes needs an update; the app's own commands still work.
- For Server files: a dashboard that serves its managed-files routes, `GET /api/files` and `GET /api/files/read`, which the dashboard's own Files tab uses. Hermes at `bf0203a` does. Without them, the Server files screen says that this Hermes needs a dashboard with the Files tab. To limit browsing to one folder, start the dashboard with `HERMES_DASHBOARD_FILES_ROOT=/that/folder`.
- For Scheduled jobs: a dashboard with the cron routes under `/api/cron/` (Hermes at `bf0203a` has them), and the profile's gateway running on the server, since its scheduler runs the jobs. Set the profile's time zone with `timezone:` in its `config.yaml`; without it Hermes uses the server's own zone, which the app can't name. Without the routes, the screen says that this Hermes has no scheduled jobs.
- For Memory: Hermes's `learning.*` methods on `/api/ws` and `GET /api/profiles/active` (Hermes at `bf0203a` has them). Memory can be edited only for the profile the dashboard runs as. Without the methods, Settings → Memory says that this Hermes has no memory editing calls.

## Features

These features are on the `main` branch.

- **Chat list.** Chats are **Active** or **Settled**. You move them yourself, and Settled chats wait in a collapsed section. The list shows Unread dots and a source icon for chats started in Telegram, Discord, the CLI, or the official desktop app. Each row has buttons to Settle, Archive or Restore, and Delete a chat. Right-click a chat to Rename it, Regenerate its title, or open it in a pane. The chat header exports a chat to Markdown. The list shows the past month; Settings → General → **Pull older history** loads the rest.
- **Search and Find.** Ctrl+K searches every chat in the profile, and can include archived chats. Ctrl+F finds text in the open chat.
- **Replies.** Replies stream in as Markdown, with syntax-highlighted code, tool calls, and optional reasoning blocks. When Hermes asks to run a dangerous command, an **Approval** card offers the choices Hermes sends (once, for this chat, always, or deny).
- **Queued messages.** While Hermes replies, the composer stays editable. Enter or the Queue button, beside Stop, queues the message to go after the reply. The queue above the composer shows each message's words, file count, position and state. Edit a message in place, reorder it with its buttons or Alt+↑/↓, remove it with its button or Delete, and pause or resume the whole queue. Hermes Chat sends the next message only after the reply ends, and only while the app is open, connected and showing that profile. See [Queued messages](#queued-messages).
- **Failed messages.** A message that Hermes didn't take, or might not have taken, stays in the chat with **Retry**, **Edit**, and **Dismiss**. Nothing resends it automatically.
- **Attachments.** Drag files into the composer or paste them. Hermes accepts images up to 25 MB and other files up to 256 MB.
- **Screenshots.** Press Ctrl+Shift+S, or click the camera button, to attach a region or window. See [Screenshots](#screenshots).
- **Voice.** Use **Dictation** to speak a message into the composer, and **Read aloud** to have Hermes speak a reply. Hermes does the transcription and speech on the server.
- **Two panes.** Ctrl+\\ opens a second chat beside the first.
- **Preview pane.** A resizable pane shows web links from replies, files on the Hermes server, local files you choose, and tool output. Web pages and HTML files load in sandboxed frames.
- **Server files.** The folder button on the rail opens a read-only browser for the disk of the machine the dashboard runs on. It shows folders with a path trail, sizes, modified times, types, and symbolic links, and previews text files up to 1 MiB and images up to 10 MiB. It shows what the dashboard's OS user can read, starting in that user's home folder, and Hermes never lists credential files such as `.env` or `auth.json`.
- **Scheduled jobs.** The calendar button on the rail lists the profile's Hermes cron jobs, and creates, edits, pauses, resumes, runs, and deletes them. Hermes keeps and runs them on the server, so they run while Hermes Chat is closed. See [Scheduled jobs](#scheduled-jobs).
- **Memory.** Settings → Memory shows what Hermes remembers for the profile, and changes or deletes single entries. See [Memory](#memory).
- **Outputs.** The rail's Outputs button lists the files Hermes's tools wrote, for the open chat, the project in the list, or every chat in the profile. It shows each file's name, type, size, version, whether it was at its path when last checked, and the chat and tool that made it. You can search, filter by type, open a file in the preview pane, go to the tool call that made it, or open its folder in Server files. Paths a reply only mentions aren't listed, and you can add a server file by its path. See [ADR 0016](docs/adr/0016-outputs-are-what-hermes-tools-say-they-wrote.md).
- **Projects.** Projects are Hermes's own named groups of chats and server folders. Hermes stores the projects and their folders. This computer stores which chats are in each project.
- **Project defaults.** A project's screen sets instructions, a model with its reasoning effort, and a working folder on the server for the chats started while the list shows it. The New chat pane lists what the chat will start with and where each value comes from: chosen for this chat, the project's default, or the profile's. See [Project defaults](#project-defaults).
- **Models.** The composer has a model picker with reasoning effort, fast mode, and starred models. Settings → Model sets the profile's main model, subagent models, auxiliary models (including the Text generation model used for titles), and guardrails.
- **Toolsets.** Settings → Toolsets lists the toolsets Hermes can offer the model in the profile shown, each one's state as Hermes reads it, and a switch for each one that the server lets this app change. The setting belongs to the profile on the server, so the CLI, the TUI, and the official desktop app see the same choice. A change applies to chats that Hermes starts afterwards. A chat that Hermes already has open, and any reply running in it, keeps its tools. A server started with `HERMES_TUI_TOOLSETS`, or a profile in coding focus mode, can give new chats a different list. The app shows a change as saved only after Hermes reads it back that way, and asks first when a change would start an install, turn MCP servers back on, or take a toolset off the profile's `agent.disabled_toolsets`, which turns it back on for Hermes's other platforms as well. Toolsets don't change Approvals or YOLO.
- **Persona.** Settings → Persona edits the shown profile's `SOUL.md` on the Hermes server as plain Markdown, and shows the server, profile, and file path. Save writes nothing if the file changed on the server since you started; it says so and lets you choose. After writing, it reads the file back, and says it saved only then. New chats use the new persona; chats already under way keep theirs. Hermes doesn't restart. Leaving, switching profile, signing out, or closing the window with unsaved changes asks first, and the changes stay on this computer to restore. The last five versions a save replaced can be viewed and put back.
- **Usage and cost.** You see token usage per reply and per chat. Cost appears only as Hermes recorded it, because the app keeps no price list.
- **Status bar.** The status bar shows how full the context window is, a per-chat YOLO switch, the model, and the connection state. Right-click it to choose the items.
- **Appearance.** Choose light, dark, or system mode, themes (with a theme editor), contrast, interface and code fonts, sizes, word wrap, and chat width.
- **Inbox.** The inbox button on the rail lists, for every profile on the server, chats with a reply running, an Approval waiting, a failure or a Failed message, and completed replies not read yet. Its badge counts the ones that need you. Filter by Running, Needs approval, Failed or Completed. Each entry names its profile, chat and server and says when; opening it switches profile if needed and opens the chat at the Approval card or message. Nothing is approved, retried or resent from the inbox. Dismissing an entry hides it from the inbox only. See [The inbox](#the-inbox).
- **Desktop notifications.** While the window isn't focused, the app posts a notification when a reply finishes or an Approval is waiting. This needs a freedesktop notification service, such as mako, dunst, swaync, GNOME, or KDE.
- **Slash commands.** Type `/` at the start of a message for a menu of commands, each marked App or Hermes: `/help`, `/new`, `/rename <title>`, `/delete` (asks first), `/steer <message>` for a running reply, and `/context`. Any other text starting with `/` is sent as a message. See [Slash commands](#slash-commands).
- **Drafts and reopening.** Drafts are kept for each chat, profile, and connection, and they survive restarts. The app can reopen the last chat at launch.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+K | Search chats |
| Ctrl+N | New chat |
| Ctrl+F | Find in the open chat |
| Ctrl+B | Hide or show the chat list |
| Ctrl+\\ | Open a second pane, or close the inactive one |
| Ctrl+1, Ctrl+2 | Focus the left or right composer |
| Ctrl+Shift+S | Take a screenshot (configurable in Settings → General) |

### Slash commands

Type `/` at the very start of the composer to open the command menu. Keep typing to filter it by name or description. ↑ and ↓ choose, Enter or Tab fills the command in, and Escape closes the menu. Filling a command in never sends anything: press Enter again to run it. While an input method is composing, these keys stay with it.

| Command | Runs in | What it does |
| --- | --- | --- |
| `/help` | App | Lists every command, its argument, and why it can't run now. Escape closes it. |
| `/new` | App | Opens the New chat pane. |
| `/rename <title>` | App | Renames the chat in every Hermes client, as Rename in the chat list does. |
| `/delete` | App | Asks, as the chat list does, then deletes the chat in every Hermes client. |
| `/steer <message>` | Hermes | Gives the running reply your words after its next tool call, without stopping it. If the reply ended meanwhile, Hermes has the words sent as your next message. |
| `/context` | Hermes | Shows what fills the chat's context window, as Hermes counts it. |

Hermes's commands need a Hermes that lists them in `commands.catalog` (Hermes at `bf0203a` does), the chat open on Hermes, and for `/steer` a reply running. If the profile has a quick command or plugin command called `steer`, Hermes would run that instead, so the app says so and doesn't run `/steer`. It also holds back when Hermes couldn't list those. A command that can't run says why under the composer and keeps your text. So does one that fails. The text is cleared only once the command has run. An answer that arrives after you switched profile isn't shown, and the text stays in that chat's draft. Text after `/` that isn't one of these commands, or words after a command that takes none (`/help me read this log`), is sent as an ordinary message. To send a command's own text as a message, start it with a space.

Answers and notes stay in the composer, in memory, until you dismiss them or leave the chat. Nothing new is stored on disk. Commands that make Hermes run tools still ask for Approvals as usual.

### Two chats side by side

![Two chats side by side, each with its own transcript and composer](docs/screenshots/readme/split-panes.png)

Click the split button in the chat header, or press Ctrl+\\, to open a second pane. Right-click a chat to open it in the left or right pane. The pane you click or tab into becomes active, marked by an accent line. The chat list, Search, New chat, and Find act on the active pane. Drag the divider to resize the panes, or double-click it to make them equal. When fewer than 646 pixels remain for the chats, a Left/Right switcher shows one pane at a time.

Different chats keep their own drafts, replies, and unread state. The same chat in both panes shares its draft, queued messages, and reply. Scroll position, Find, and unsent attachments belong to each pane. Closing a pane keeps the draft and any running reply, but discards unsent attachments in that pane. Switching profile returns to one pane. The split layout lasts only for the current run.

### Queued messages

Hermes Chat keeps the queue itself, on this computer. Hermes's legacy protocol can hold one message during a turn, but it can't list, edit, reorder or cancel what it holds. So:

- **The app must stay running.** Queued messages go only while Hermes Chat is open, connected, and showing the chat's profile. Closing the app or switching profile leaves them waiting here. Nothing is sent from the server meanwhile.
- **One at a time.** The next message goes only after the reply has ended, with no Approval waiting, and with no Failed message (or one Hermes may have) in the chat. Each goes once. If the connection drops before Hermes answers, the message is marked as one Hermes may have, and the chat's history settles it. It is never sent again on its own.
- **Pauses.** The queue pauses itself, and says why, after a reply that was stopped or failed, or that asked for an Approval. It also pauses when a queued message didn't go, when the connection drops, and when the app restarts or you switch back to the profile. Check the chat, then press **Resume**. Stop doesn't clear the queue.
- **Two panes** of the same chat show one queue. Other chats, profiles and connections each have their own.
- **Limits.** A chat holds up to 20 queued messages. Attached files are sent from where they are when the message goes, so a file moved or deleted meanwhile makes that message fail. If local storage is full, the queue says so and lasts only until the app closes.

### Scheduled jobs

![The Scheduled jobs list, with each job's schedule, time zone, next run, and last result](docs/screenshots/scheduled-jobs/1-job-list.png)

Each job shows its schedule in words, the profile's time zone, Hermes's next run, its last result, and where it delivers. New job and Edit take a schedule the way Hermes does: `every day at 9am`, `weekdays at 8:30am`, `every 2h`, a cron expression such as `0 9 * * 1-5`, `in 30m`, or a time such as `2026-11-05T15:00`. The editor explains it and previews the next runs, daylight-saving changes included, and the job screen says what Hermes does with a run its scheduler missed. Delivery offers only the places the profile's gateway has set up. Pause and Resume act at once; Delete and **Run now** ask first, since Run now is a real run with the job's real delivery, and Hermes also resumes a paused job it runs.

Every change shows only once Hermes, read back, has it. A second press of Create can't make a second job, and a create whose answer was lost is looked for before anything is sent again. An edit sends only the fields you changed, and stops if another Hermes client changed the job since you opened it. The screen warns when Hermes's scheduler hasn't checked the profile's jobs lately, and when another profile holds a copy of a job (Hermes copies jobs into a profile made from another). See [ADR 0013](docs/adr/0013-scheduled-jobs-are-hermess-cron-jobs-confirmed-by-read-back.md).

### Memory

![Settings → Memory, naming the server, profile and file, with the entries of the agent's notes](docs/screenshots/memory-editor/1-memory-list.png)

Settings → Memory shows what Hermes remembers for the profile: its own notes (`memories/MEMORY.md`) and what it knows about you (`memories/USER.md`), both on the server. Pick an entry to change it, then press Save, or Delete it. Cancel drops your edit, and Reload reads memory again without losing it. Before saving, the app checks that the entry hasn't changed on the server since you opened it. If it has, nothing is written, and your text stays on screen to copy or put in an entry. After saving, the app reads memory back to confirm. If a save's answer is lost, a Reload settles it, and an edit Hermes may not have is kept on screen rather than placed on another entry. Leaving Settings, opening a chat, switching profile, signing out, or closing the window with an unsaved edit asks first.

Edits reach chats that start afterwards, and a running chat once Hermes compresses its context. Hermes isn't restarted. Hermes's memory calls (`learning.*` over `/api/ws`) reach only the profile its dashboard runs as, so other profiles' memory can't be edited from the app. There is no call for adding an entry: ask Hermes in a chat to remember something. See [ADR 0020](docs/adr/0020-memory-is-edited-entry-by-entry-for-the-dashboards-own-profile.md).

### Screenshots

Ctrl+Shift+S, or the camera button in the composer, attaches a screenshot of a region or window to your message. You can review it before you send.

- **Hyprland, Sway, and other wlroots compositors:** install `slurp` and `grim`. If they're missing, the app says what to install and captures nothing.
- **GNOME and KDE Plasma:** the desktop's screenshot portal shows its own picker. It needs `xdg-desktop-portal` with `xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`.

The in-app shortcut works only while Hermes Chat has focus. For a shortcut that works anywhere, bind a desktop key to `hermes-chat --screenshot`. On Hyprland, for example:

```ini
bind = SUPER SHIFT, S, exec, env WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat --screenshot
```

If Hermes Chat is running, the screenshot goes to the chat on screen. If it isn't running, or is on the sign-in screen, the screenshot is taken once you sign in, if you sign in within two minutes.

### The inbox

The inbox opens beside the rail and leaves the chat panes as they are, so a chat open in either pane stays read and leaves the inbox. Up and Down move between entries, Enter opens one, and Escape closes the inbox. It reads:

- the profile shown, live over its connection;
- the other profiles' 50 most recent chats, checked every two minutes with the profile switcher's dots, and every 30 seconds while the inbox is open;
- what is working or waiting in any profile, from Hermes's `session.active_list`, at most every 15 seconds.

The inbox says when it last checked, and which profiles, or which of Hermes's answers, it couldn't read. Their entries are marked "as last seen" until a check succeeds. Opening an entry in another profile switches to it, asking first if a reply is running or an Approval waiting here, as the switcher does. Entries are keyed by stable ids, so a reconnect that reports the same reply or Approval again doesn't add it twice, and an Approval Hermes stopped waiting on shows as expired, never as waiting again. See [ADR 0019](docs/adr/0019-the-inbox-is-derived-and-its-dismissals-are-local.md).

## Install on Arch Linux

`packaging/aur/PKGBUILD` builds the `hermes-chat-git` package. It isn't published on the AUR, so build it from this repository. The PKGBUILD clones `main` from GitHub, not your local checkout.

```sh
git clone https://github.com/l0cky12/hermes-chat.git
cd hermes-chat/packaging/aur
makepkg -si
```

The package installs:

- `/usr/bin/hermes-chat`
- the icons
- a desktop launcher that sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`

Optional dependencies:

| Package | Needed for |
| --- | --- |
| `openssh` | Signing in through an SSH tunnel |
| A Secret Service provider (`gnome-keyring` or `kwallet`) | Remembering the password and extra request headers |
| `slurp` and `grim` | Screenshots on Hyprland and Sway |
| `xdg-desktop-portal` and the desktop's backend | Screenshots on GNOME and KDE Plasma |

To start the app from a terminal, set the WebKit variable yourself:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 hermes-chat
```

## Updates

Settings → General → **Updates** shows the installed version, what's newer, and what changed. It checks once at launch unless you turn that off. Nothing installs or restarts without you. A restart keeps your drafts and unsent messages: they're written to disk first, and the app doesn't restart if that fails. If the app's storage is too full to put them all back, it clears its cached chat lists and Saved copies to make room; failing that, it keeps them in a file and Settings says where. How an update installs depends on how the app was installed:

- **The `hermes-chat-git` package** (pacman owns `/usr/bin/hermes-chat`): the app compares the package's commit with `main` on GitHub and lists the pull requests merged since. It never replaces the package's files. You run the update yourself, from your checkout: `git pull && cd packaging/aur && makepkg -si`. Back in the app, it sees the new version and offers **Restart now**.
- **A standalone AppImage built with an update key**: Tauri's updater downloads the new AppImage, checks its signature against the public key built into the app, and replaces the AppImage. Then you restart.
- **Anything else** (for example `npm run app`, or a binary you copied): the app says it isn't updated from here.

The repo ships no AppImage, update server or signing key yet, so standalone updates are off. To turn them on for your own builds, generate a key once. Keep the private key and its password out of the repo:

```sh
npx tauri signer generate -w ~/.tauri/hermes-chat.key
```

Bump `version` in `src-tauri/tauri.conf.json` for each release; the updater compares semver. Then build with the signing key in the environment and the updater turned on:

```sh
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/hermes-chat.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… \
npx tauri build --bundles appimage --config '{
  "bundle": { "active": true, "createUpdaterArtifacts": true },
  "plugins": { "updater": {
    "pubkey": "<contents of ~/.tauri/hermes-chat.key.pub>",
    "endpoints": ["https://github.com/l0cky12/hermes-chat/releases/latest/download/latest.json"],
    "requireSignedVersion": true
  } }
}'
```

Publish the `.AppImage`, its `.sig`, and a `latest.json` in Tauri's [static JSON format](https://v2.tauri.app/plugin/updater/#static-json-file) at that endpoint. A build without `plugins.updater` (the PKGBUILD's, for one) doesn't load the updater at all.

## Development

Install the Tauri 2 prerequisites, Node.js, and npm:

```sh
sudo pacman -S --needed rust nodejs npm webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg openssh
```

CI uses Node.js 22 and stable Rust.

Then, from the repository root:

```sh
npm ci          # install the exact versions in package-lock.json
npm run app     # run the desktop app in development mode
```

`npm run app` runs `tauri dev` with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. This variable prevents a blank window on some Wayland setups. Tauri starts the Vite dev server on port 1420 itself.

| Command | What it does |
| --- | --- |
| `npm run app` | Runs the desktop app with hot reload. |
| `npm run dev` | Runs only the Vite dev server on port 1420. The page can't connect to Hermes outside the Tauri window. |
| `npm run build` | Type-checks with `tsc --noEmit`, and builds the frontend into `dist/`. |
| `npm test` | Runs the frontend tests (Vitest and jsdom) against a fake Hermes. |
| `npm run tauri -- build --no-bundle` | Builds the release binary `src-tauri/target/release/hermes-chat`. No installer bundles are configured. |
| `cd src-tauri && cargo test --lib --test transport --test media --test screenshot` | Runs the Rust tests. The `dist/` folder must exist first, so run `npm run build` or `mkdir -p dist`. |
| `HERMES_HOME=$(mktemp -d) ~/.hermes/hermes-agent/venv/bin/python tools/cron-golden.py ~/.hermes/hermes-agent` | Regenerates `src/hermes/cronGolden.json`, what Hermes's own scheduler code makes of a set of schedules, which `schedule.test.ts` checks the schedule preview against. |
| `HERMES_LIVE_DASHBOARD=… npx vitest run src/hermes/cronJobs.live.test.ts` | Runs the Scheduled jobs calls against a real dashboard. It refuses one whose profiles don't all live under `/tmp`; see the file's header. Skipped by `npm test`. |
| `node bench/run.mjs` | Benchmarks long chats (50, 200, and 800 turns) in headless Chromium. See below. |

The benchmark times opening, streaming, find-in-chat, scrolling, two simultaneous streams, and divider dragging. It needs `$CHROME` or Playwright's cached headless shell (`npx playwright install chromium-headless-shell`). Set `THROTTLE=4` to slow the CPU four times.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm test`, `npm run build`, and the Rust tests on every pull request and on pushes to `main`.

## Project defaults

Open a project's screen (the gear beside the project switcher) and set **Defaults for new chats**. Edits wait for **Save defaults**; **Cancel** puts back what's saved. Anything left empty comes from the profile, and a model picked in the New chat pane beats the project's for that chat. Saving changes only chats started afterwards.

- **Folder.** One of the project's folders. Before each chat starts, the app lists it on the server; a missing folder, a file, or one Hermes's user can't open stops the chat with the reason, and the message goes back in the composer. Hermes runs a chat in its own folder, without an error, when it can't use the one asked for, so the app keeps a chat only when Hermes answers that it runs in that exact folder.
- **Model and reasoning effort.** If Hermes no longer offers the model, or lists it as unavailable, the chat doesn't start; pick a model for the chat or change the default. The app never picks another model for you.
- **Instructions.** Sent once, when the chat starts, as a hidden message before your first one. The model reads it as part of the conversation, not as its system prompt, and no Hermes client shows it. They aren't sent again with later messages.
- **Apply to this chat.** In a started chat of the shown project, the folder-and-gear button asks first and lists what changes. It can switch the chat's model and effort, and move its folder between replies. It can't change the instructions a chat started with.

The defaults are kept on this computer, per connection and profile, because Hermes has no place for them; other computers and Hermes clients don't use them. If another window or running copy of Hermes Chat saved them since you started editing, Save says so and lets you load theirs or save yours over them; every copy shares the one file and changes it under a file lock, so no save silently replaces another. This version won't change defaults that a newer version saved. See [ADR 0017](docs/adr/0017-project-defaults-are-local-and-sent-when-a-chat-starts.md).

These rely on Hermes's legacy `session.create` taking `cwd`, `cwd_explicit`, `model`, `provider`, `reasoning_effort` and seeded `messages`, and on `session.cwd.set`, as Hermes at `bf0203a` does. A server without them may ignore a field rather than refuse it; the folder check after creation catches an ignored folder, but not ignored instructions.

## Connecting to Hermes

<img src="docs/screenshots/readme/sign-in.png" width="420" alt="The sign-in screen in URL mode, with an extra request header whose value is masked">

### Setup

On a computer with nothing saved, the app opens **Setup** instead of the sign-in screen (ADR 0009). It asks for the server, then the dashboard username and password, and tests the connection before saving anything. The test opens the tunnel or resolves the URL, reads `/api/status`, signs in, and opens the chat connection. If a step fails, Setup says which one and what to fix. **Save and connect** then signs in for real, as below. Setup can also give Hermes a model provider's API key: the provider checks it first, and Hermes keeps it in the profile's `.env` on the server. The app never stores it. Account providers, such as Nous Portal, are set up on the server.

To open Setup again, use **Settings → General → Run setup again**, or **Set up a different server…** on the sign-in screen. The connection in use carries on until a new one is tested and saved. A computer that already has a saved sign-in never sees Setup on its own.

### SSH

Choose **SSH** and enter an SSH target, such as `me@hermes` or a `Host` alias from `~/.ssh/config`. Then enter the dashboard username and password. The app runs the system `ssh` with `BatchMode=yes`, so the key must work without a prompt: use an agent or an unencrypted key. New host keys are accepted on first use (`StrictHostKeyChecking=accept-new`), and a changed key fails. The tunnel forwards a free local port to `127.0.0.1:9119` on the server. SSH connections are never labelled Unsecure.

### Direct URL

Choose **URL** and enter the dashboard address, such as `http://hermes:9119` or `https://hermes.example.com`. The app labels a connection **Unsecure** when it uses `http://` or `ws://`, unless the host is one of these:

- loopback
- a Tailscale MagicDNS name (`*.ts.net`)
- a Tailscale address
- a bare name, such as `hermes`, that resolves only to Tailscale addresses

For HTTPS, the app uses the system OpenSSL and trust store. `HTTP_PROXY` and `HTTPS_PROXY` apply to HTTP requests only. The WebSocket connects directly, so the dashboard must be reachable without a proxy.

### Extra request headers

A gateway in front of the dashboard, such as Cloudflare Access, may need headers. Add them under **Extra request headers** on the sign-in screen, for example `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Rust sends them with every request to that dashboard, including sign-in, REST calls, and the WebSocket handshake. It never sends them anywhere else:

- With headers set, the app follows a redirect only within the dashboard's origin.
- If saved headers were restored from the keyring, the first change to the URL clears every header value and keeps the names. Otherwise, changing the URL keeps the values you entered, so check them before connecting to a different server.
- SSH connections don't send the headers.

Settings shows the header names but never their values. The app reserves a few names, such as `Host`, `Cookie`, `Origin`, `Sec-WebSocket-*`, and `Proxy-*`. `Authorization` is allowed.

### Signing in and out

After a successful sign-in, the password is saved in the system keyring, and the app signs in with it at each launch. **Settings → General → Sign out** deletes the saved password. It keeps the target, URL, username, and extra headers, so the sign-in screen asks only for the password. If the keyring can't save, the sign-in still works, and the app says the password wasn't kept.

### Profiles

Each Hermes profile has its own chats. The chat list header is the profile switcher. It also marks other profiles that have Unread chats, checking every two minutes. Switching happens in place, with the same sign-in. If a reply is running or an Approval is waiting, the app asks first. Hermes keeps the reply running and brings both back when you return. Drafts and Saved copies are kept per profile. Switching profile resets the composer's model pick to that profile's own default model. The last profile you used opens at the next launch.

## What is stored where

### On the Hermes server

Hermes stores the chats and their history, titles, Archived state, and Unread state. It also stores projects and their folders, the profile's model settings, toolsets, and persona (`SOUL.md`), and usage and cost totals. Active or Settled is stored as Hermes's `pinned` flag, so it syncs between computers. Hermes refuses that edit for chats it has no route for, such as chats started in this app or the official desktop app. For those chats, Active or Settled is kept on this computer only. Messages, attachments, and Dictation recordings are sent to Hermes. Rename, Archive, Delete, and project changes appear in every Hermes client. Scheduled jobs live in the profile's `cron/jobs.json` on the server, with their run history, and every Hermes client sees the same ones; this computer stores nothing about them. Memory lives in the profile's `memories/MEMORY.md` and `memories/USER.md` on the server. An unsaved or kept memory edit exists only on screen and is gone when Settings closes.

### On this computer

| What | Where | Removed by |
| --- | --- | --- |
| Dashboard password | System keyring, service `hermes-chat`, account `dashboard-password` | Sign out |
| Extra request headers (names, values, and their URL) | System keyring, account `extra-request-headers` | Signing in to the URL with no headers |
| Sign-in mode, SSH target, URL, and username | Webview local storage (`hermes-chat.sign-in`) | Not removed by the app |
| Chat list copy for each profile | Webview local storage | Clear local cache |
| **Saved copies** of recently opened chats (up to 2 MB in total) | Webview local storage | Clear local cache, deleting the chat, or the oldest copy going first when the 2 MB limit is reached |
| Drafts and **Failed messages** | Webview local storage, per connection, profile, and chat | Sending, Retry, or Dismiss. Clear local cache keeps them. |
| **Queued messages**, with the paths of their attachments | Webview local storage (`hermes-chat.queue.…`), per connection, profile, and chat | The message going, removing it, or deleting the chat. Clear local cache keeps them. |
| Which chats are in each project | Webview local storage (`hermes-chat.projects`) | Deleting the project. Clear local cache keeps it. |
| Inbox dismissals: each dismissed entry's key (profile, chat id, and Approval request or message id) and times, per connection. No chat text. | Webview local storage (`hermes-chat.inbox-dismissed.*`) | Kept 30 days, at most 1000; the oldest go first. Clear local cache keeps them. |
| Each project's defaults for new chats | `$XDG_DATA_HOME/net.l0cky12.hermes-chat/project-defaults.json`, readable only by you | Deleting the project in Hermes Chat. Clear local cache keeps them. |
| The Outputs index: each Output's path, tool, call, stored time, reported size and last availability check, per connection and profile. No file contents or chat text. | Webview local storage (`hermes-chat.outputs`), at most 1,000 Outputs per chat, 3,000 per profile, 200 added files per profile, and 8 profiles | The oldest-read chats when over the limit. Clear local cache keeps it; Refresh rebuilds it. |
| Unsaved persona edits, and the last five versions of `SOUL.md` that saves from this app replaced | Webview local storage, per connection and profile | Saving or discarding the edit; a newer save pushes out the oldest version. Clear local cache keeps them. |
| Display preferences, model pick, starred models, and reopen-last-chat | Webview local storage | Not removed by Clear local cache |
| Drafts, Failed messages and Queued messages saved for an update's restart | `$XDG_DATA_HOME/net.l0cky12.hermes-chat/restart-drafts.json`, readable only by you | Putting them back at the next launch. A copy that couldn't be put back is renamed `restart-drafts-<time>.json` and stays until you move or delete it; Settings says where. |
| Screenshots waiting to send | `$XDG_CACHE_HOME/hermes-chat/captures/`, readable only by you | Confirmed delivery, removing them from the composer, or leaving the composer without sending. A queued message keeps its screenshots until it goes or you remove it. A Failed message keeps its screenshots until delivery is confirmed, history reconciles it, or you Dismiss it. Startup cleanup removes only leftovers that no message needs. |
| Pasted files | A private folder under `$TMPDIR/hermes-chat/` (usually `/tmp/hermes-chat/`) | Not removed by the app |
| Exported chats | The file you chose in the Save dialog | You |

Webview local storage is in `$XDG_DATA_HOME/net.l0cky12.hermes-chat/localstorage/` (usually `~/.local/share/...`). It isn't encrypted. Saved copies, drafts, queued messages, and Failed messages hold chat text in plain form, so anyone who can read your home folder can read them. Saved copies never hold Approvals, errors, or Failed messages. To remove chat text from this computer, use **Settings → General → Clear local cache**. This deletes the chat list copy and the Saved copies. Drafts, Failed messages, and project membership remain. Sign out doesn't clear the cache. Dictation recordings and Read aloud audio are never saved on disk. An exported Markdown file names its attachments but doesn't include them.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| The window is blank | Start the app with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. The launcher and `npm run app` already set it. |
| "SSH failed" or "SSH didn't open the tunnel within 20s" | Check that `ssh -o BatchMode=yes <target> true` works without a prompt. Load a passphrase-protected key with `ssh-add`. Check that the dashboard listens on port 9119 on the server. |
| "Wrong username or password" | Use the dashboard's own username and password, not the SSH account. |
| "This Hermes server speaks the canonical session protocol" | That Hermes version isn't supported yet. |
| "The dashboard sent Hermes Chat on to …, another site" | A gateway redirected the request, usually to its login page. Check the extra request headers that the gateway needs. |
| The password isn't remembered | Start a Secret Service provider, such as GNOME Keyring or KWallet, and sign in again. Settings shows whether the password was saved. |
| The connection is labelled Unsecure | Use `https://`, SSH, or a Tailscale address. Plain `http://` to a public or LAN address isn't encrypted. |
| A page in the preview pane stays blank | The site forbids framing (`X-Frame-Options` or `frame-ancestors`), or it is on the server's loopback address, which this computer can't reach. Open it in a browser instead. |
| Screenshots do nothing on Hyprland or Sway | Install `slurp` and `grim`. |
| Dictation can't record | Check the microphone and the PipeWire or PulseAudio sound server. Settings → General → Voice shows which providers the profile uses. |
| No desktop notifications | Install and run a notification daemon. Notifications appear only while the window isn't focused. |

## Known limitations

- The app supports one Hermes server connection at a time, and only the legacy session protocol with username and password sign-in.
- The app targets Linux on Arch with WebKitGTK; CI runs on Ubuntu. No other packages or installers exist.
- Active and Settled don't sync between computers for chats that Hermes won't pin, such as chats started in this app.
- Project membership and project defaults are stored on this computer only. Other computers and Hermes clients don't see them.
- A project's instructions reach the model as a hidden message in the conversation, not as part of the system prompt, because Hermes has no per-chat instructions field. They can't be changed in a chat that has started.
- Queued messages are sent by this app, not by Hermes: they wait while the app is closed, disconnected, or showing another profile, and other computers don't see them. The app sends each queued message once, but without a server receipt it can't promise Hermes runs it exactly once; a send whose outcome is unknown is settled by reading the chat's history back. Queuing was checked against the Hermes source at `bf0203a` and the automated tests' fake Hermes. Other versions, and the canonical protocol, weren't tested.
- Per-reply usage appears only for replies that the app watched from start to finish. Chat totals come from Hermes and cover every call. Costs count only the calls Hermes could price.
- Server files is read-only: it can't upload, rename, delete, or download. A preview reads the whole file, so bigger files aren't previewed at all, and the server sends a folder in one answer, however many items it has.
- Toolsets are the profile's, not a chat's, and reach only chats Hermes starts afterwards. Hermes keeps no revision for the toolset list, so a change made in another client to the same toolset in the moment between the app's check and its write can be overwritten; the read afterwards then shows what Hermes has.
- Hermes has no conditional write for `SOUL.md`. Persona checks the file just before writing and reads it back after, but a change made elsewhere in the moment between the check and the write is overwritten. Hermes reads the file back with LF line ends and no byte order mark, so saving a file that had CRLF line ends writes LF.
- Scheduled jobs: Hermes's per-job routes act on another profile's copy of a job if this profile's job was deleted elsewhere just before, and Hermes offers no revision to stop an edit landing between the app's conflict check and its write. Only prompt jobs can be created here, run history goes back 100 runs, and the app can't see a `HERMES_TIMEZONE` set in the server's environment.
- Memory: only the profile the dashboard runs as can be edited, since Hermes's `learning.*` calls take no profile. They would need a `profile` parameter (or a REST route with `?profile=`). There is no call to add an entry, and an external memory provider's store isn't shown.
- Outputs finds only files that `write_file`, `patch`, `text_to_speech` and `image_generate` report writing. Files made by `terminal`, `execute_code`, MCP tools or subagents aren't found unless you add them by path. Sizes come from the tool (only `write_file` reports one), because Hermes has no route that reads a file's size on the machine the tools run on. Each chat's newest 2,000 stored rows (at most 64 MiB of them) are read, 25 chats at a time. Audio and images Hermes saves itself are on the dashboard's machine, so they are checked and previewed through the Server files routes and their limits. Availability is checked only on Refresh. Outputs can't download a file; downloads are planned for the Server files screen (#94).
- Framed web pages in the preview pane get no cookies, so sites that need a sign-in don't stay signed in. HTML files show as static documents.
- Long transcripts render in full. Very long chats, especially two at once, can be slow while streaming or resizing.
- On the legacy protocol, a reply to a Telegram or Discord chat should stay in Hermes clients and not be posted back to Telegram or Discord. This comes from reading Hermes's source and hasn't been tested live.
- The app doesn't install pacman updates itself: you run the PKGBUILD, and it offers the restart. In-app installation works only for an AppImage you build and sign yourself, since the repo publishes no releases or update server. Checking a package build asks GitHub without signing in, which allows 60 checks an hour.
- The inbox sees running and waiting work in other profiles only for sessions live in the dashboard's own process, such as chats run from this app or the official desktop app. Hermes doesn't say which profile such a session is in: the app knows it for chats it started or resumed in this run, and otherwise looks the chat up by id in every profile, listing it only when exactly one profile has it. A failure seen in a profile is kept only until you are back in it. Work running in the CLI, a messaging gateway or cron shows once its chat is Unread. A background chat waiting on you shows as waiting, without what it asks, until you open it. Approval and error entries show when the app first noticed them, since Hermes gives no time for them. The inbox covers the one server signed in to.
- Slash commands are a short list. The app doesn't offer Hermes's other commands, skills, or quick commands, and sends any other `/` text as a message. Command answers aren't kept in the chat's history or Saved copy.
- The automated tests use a fake Hermes. Native Wayland screenshot pickers and real audio devices aren't covered.

## Project documents

- [`GLOSSARY.md`](GLOSSARY.md) defines the app's terms, such as Active, Settled, Saved copy, and Approval.
- [`docs/adr/`](docs/adr/) records the design decisions, for example the [SSH sign-in](docs/adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md), the [Unsecure label](docs/adr/0004-direct-url-sign-in-and-what-counts-as-unsecure.md), [extra request headers](docs/adr/0006-extra-request-headers-for-a-gateway-in-front-of-the-dashboard.md), the [preview pane sandbox](docs/adr/0007-preview-pane-shows-untrusted-content-in-sandboxed-frames.md), [usage and cost](docs/adr/0008-usage-and-cost-come-from-hermes.md), [Server files](docs/adr/0012-server-files-are-the-dashboards-managed-files-read-only.md), [Scheduled jobs](docs/adr/0013-scheduled-jobs-are-hermess-cron-jobs-confirmed-by-read-back.md), [persona saves](docs/adr/0014-persona-saves-check-hermes-first-and-read-back.md), [slash commands](docs/adr/0015-slash-commands-are-a-small-verified-registry.md), [Outputs](docs/adr/0016-outputs-are-what-hermes-tools-say-they-wrote.md), [project defaults](docs/adr/0017-project-defaults-are-local-and-sent-when-a-chat-starts.md), [Queued messages](docs/adr/0018-queued-messages-are-kept-and-sent-by-this-app.md), [the inbox](docs/adr/0019-the-inbox-is-derived-and-its-dismissals-are-local.md), [Memory](docs/adr/0020-memory-is-edited-entry-by-entry-for-the-dashboards-own-profile.md), and [Toolsets](docs/adr/0021-toolsets-are-profile-settings-confirmed-by-read-back.md).
- [`docs/research/hermes-gateway-api.md`](docs/research/hermes-gateway-api.md) describes the Hermes API that the app relies on.

## License

Copyright (C) 2026 l0cky12

Hermes Chat is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [`LICENSE`](LICENSE) for the full text. SPDX identifier: `GPL-3.0-or-later`.

This license covers only the code and assets in this repository. Third-party npm packages and Rust crates keep their own licenses. Most use permissive licenses, such as MIT, Apache-2.0, BSD, ISC, Zlib, or Unicode-3.0, and a few crates use MPL-2.0. Hermes Agent is a separate project with its own license.
