# Slash commands are a small registry of verified commands, and other "/" text is a message

Typing "/" at the start of the composer opens a menu of slash commands. The app runs only the commands in its own registry (`src/hermes/commands.ts`): app actions it already has, and Hermes commands whose behaviour was read in Hermes's source at the deployed `bf0203a` and run against that code. Any other text that starts with "/" is sent as an ordinary message, exactly as typed. Nothing typed is passed through to Hermes's command line.

| Command | Scope | How it runs |
| --- | --- | --- |
| `/help` | App | Opens the command help above the composer. |
| `/new` | App | Opens the New chat pane, as Ctrl+N does. |
| `/rename <title>` | App | The same `rename` as the chat list's Rename, with its conflict check. |
| `/delete` | App | Asks first, then the chat list's Delete. |
| `/steer <message>` | Hermes | `command.dispatch {name: "steer", arg, session_id}`. |
| `/context` | Hermes | `slash.exec {command: "/context", session_id}`. |

## Why these

- **Server commands need a structured, verified route.** `command.dispatch` takes the argument as its own field, so a multiline `/steer` reaches Hermes as typed. `_cmd_steer` queues the words for after the running turn's next tool call, or, with no turn running, answers `{type: "send", message}` and the app sends the words as the chat's next message. `slash.exec /context` is answered from the live session in-process (`_format_live_context_output`), so it doesn't start Hermes's slash worker, which is a full CLI process per chat.
- **Availability comes from Hermes.** A server command is offered only if Hermes's `commands.catalog` lists it for the profile, read once per connection and profile. Hermes runs a quick command (which can be any shell command) or a plugin command before its own command of the same name, so a name one of those takes isn't run from here, and a catalog whose quick or plugin discovery failed counts as unknown. Skill bundles and skills can't take a built-in's name at `bf0203a`. A Hermes without `commands.catalog` (JSON-RPC -32601) says it needs an update. A listed command still needs the chat open on Hermes (a runtime session), and `/steer` needs a reply running. Hiding a command isn't a permission: Hermes still applies its own Approvals to anything a command makes it run.
- **Destructive commands reuse the existing question.** `/delete` asks with the chat list's words and buttons (Delete, Cancel focused, Escape or clicking away cancels), then runs the same delete.

## Considered options

- **Forward any "/" text to `slash.exec`, as the official clients do.** Rejected: `slash.exec` runs whatever Hermes's CLI accepts, through a slash worker, and many commands change config or state on disk, answer in terminal-only ways, or move the chat to another session (`/compress` changes the session's key, `/undo` and `/retry` rewrite history this app has on screen). Unknown "/" text going as a message also keeps every message the owner could send before.
- **Build the menu from `complete.slash` or `commands.catalog`.** Rejected for now: it lists dozens of commands this app can't show the results of. The catalog is used only to check that a registry command is there.
- **Run a command on a single Enter.** Rejected: Enter in the menu fills the command in, so picking from the menu can't send by accident. A second Enter runs it.

## Consequences

- A command name followed by words when it takes none, such as "/help me read this log", is a message. To send a registry command's text itself as a message, start it with a space; the space is trimmed when sending.
- A command empties the Draft only once it has run, and only if the owner hasn't changed the text meanwhile. A failed or refused command keeps the text and says why under the composer.
- A command's answer that arrives after the profile changed, or after the composer went to another chat, isn't shown, and its Draft stays as it was typed. Hermes may still have run it. A `/steer` that Hermes answers with "send it" is sent straight to its chat, so text typed meanwhile stays in the composer.
- `/delete` empties its Draft only once Hermes has deleted the chat; a refused delete brings the chat back with the text.
- One command runs at a time per Draft, so two panes showing one chat can't run it twice.
- Answers and notes are kept in memory, in the composer, until dismissed, the next command, or leaving the chat. The catalog check is kept in memory per connection and profile. Nothing new is stored on disk.
- Adding a command means reading its handler in Hermes and adding it to the registry, with a test.
