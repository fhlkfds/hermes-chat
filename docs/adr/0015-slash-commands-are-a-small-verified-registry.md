# Slash commands are a small registry of verified commands, and other "/" text is a message

Typing "/" at the start of the composer opens a menu of slash commands, followed by the profile's skills (see "Skills from the composer" below). The app runs only the commands in its own registry (`src/hermes/commands.ts`): app actions it already has, and Hermes commands whose behaviour was read in Hermes's source at the deployed `bf0203a` and run against that code. Any other text that starts with "/" is sent as an ordinary message, exactly as typed. Nothing typed is passed through to Hermes's command line.

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
- **Availability comes from Hermes.** A server command is offered only if Hermes's `commands.catalog` lists it for the profile, read once per connection and profile. `command.dispatch` runs a quick command (which can be any shell command) or a plugin command before Hermes's own command of the same name, so `/steer` isn't run from here when one of those takes its name, or when Hermes's discovery of them failed (a failed skill discovery overwrites that warning, so it counts too). `/context` is answered from the live session before any of those, so it can't be replaced. Skill bundles and skills can't take a built-in's name at `bf0203a`. A Hermes without `commands.catalog` (JSON-RPC -32601) says it needs an update. A listed command still needs the chat open on Hermes (a runtime session), and `/steer` needs a reply running. Hiding a command isn't a permission: Hermes still applies its own Approvals to anything a command makes it run.
- **Destructive commands reuse the existing question.** `/delete` asks with the chat list's words and buttons (Delete, Cancel focused, Escape or clicking away cancels), then runs the same delete.

## Considered options

- **Forward any "/" text to `slash.exec`, as the official clients do.** Rejected: `slash.exec` runs whatever Hermes's CLI accepts, through a slash worker, and many commands change config or state on disk, answer in terminal-only ways, or move the chat to another session (`/compress` changes the session's key, `/undo` and `/retry` rewrite history this app has on screen). Unknown "/" text going as a message also keeps every message the owner could send before.
- **Build the menu from `complete.slash` or `commands.catalog`.** Rejected for now: it lists dozens of commands this app can't show the results of. The catalog is used to check that a registry command is there, and for the skills it lists (below).
- **Run a command on a single Enter.** Rejected: Enter in the menu fills the command in, so picking from the menu can't send by accident. A second Enter runs it.

## Consequences

- A command name followed by words when it takes none, such as "/help me read this log", is a message. To send a registry command's text itself as a message, start it with a space; the space is trimmed when sending.
- A command empties the Draft only once it has run, and only if the owner hasn't changed the text meanwhile. A failed or refused command keeps the text and says why under the composer.
- A command's answer that arrives after the profile changed, or after the composer went to another chat, isn't shown, and its Draft stays as it was typed. Hermes may still have run it. A `/steer` that Hermes answers with "send it" is sent straight to its chat, so text typed meanwhile stays in the composer.
- `/delete` empties its Draft only once Hermes has deleted the chat; a refused delete brings the chat back with the text.
- One command runs at a time per Draft, so two panes showing one chat can't run it twice.
- Answers and notes are kept in memory, in the composer, until dismissed, the next command, or leaving the chat. The catalog check is kept in memory per connection and profile. Nothing new is stored on disk.
- Adding a command means reading its handler in Hermes and adding it to the registry, with a test.

## Skills from the composer

Added for issue #188. A skill (GLOSSARY.md "Skill", ADR 0030) is run the way Hermes's own clients run one, read in Hermes's source at the deployed `f0d9488` (the same at `bf0203a`) and in its desktop client (`apps/desktop`, `use-prompt-actions/slash.ts`). The code is `src/hermes/skillCommands.ts`.

| Typed | What goes to Hermes |
| --- | --- |
| `/debugging fix the build` | `command.dispatch {name: "debugging", arg: "fix the build", session_id}` |
| `/debugging /writing fix it` | `command.dispatch {name: "debugging", arg: "/writing fix it", session_id}`: Hermes loads both |
| `fix the build using $debugging` | `command.dispatch {name: "debugging", arg: "fix the build using $debugging", session_id}` |
| `$writing then $debugging` | `command.dispatch {name: "writing", arg: "/debugging $writing then $debugging", session_id}` |

Hermes answers `{type: "skill", message, name, display}`. `message` is the skill's SKILL.md wrapped in Hermes's instructions for the model; the app sends it with `prompt.submit`, as the official desktop does. The chat shows `display` (`/debugging fix the build`), which is also what Hermes's history shows for that turn (`session_history._skill_scaffold_projection`).

### Decisions

- **Which skills are offered.** The skills `commands.catalog {profile}` lists (its `skills` field and their `pairs`), less any whose key a quick or plugin command also has, since `command.dispatch` would run that instead. Hermes leaves out of the catalog a skill in `skills.disabled`, one whose name a built-in command has, and one whose name two skills share. The catalog doesn't apply the per-platform lists: the dashboard's process names no platform. So the app also reads Settings → Skills' list, and offers a catalog skill only when a listed skill makes that key (Hermes's `slugify_skill_name`) and it is on for the profile and not kept off for `tui` or `desktop`. A catalog skill no listed skill makes, such as a plugin's skill, isn't offered, since the app can't tell whether it's on. When a quick, plugin or skill discovery failed, or the per-platform lists couldn't be read, no skill is offered. The list is read once per connection and profile, again after a minute when a menu opens, and again after a switch or save in Settings → Skills.
- **"/" lists commands, then skills.** Skills come after the app's commands under their own heading, filtered with the commands' matching (`matchCommands`). A skill whose key is one of the app's command names isn't listed after "/", and "/rename" stays the command. "$rename" reaches the skill. Picking a skill fills in `/key ` and sends nothing, as a command does.
- **"$" is this app's own form.** Hermes has no `$`. Its clients let a `/skill` reference sit in prose, but send that as plain text, so the model may or may not load the skill. A `$name` here makes the message a real skill run: every skill named is stacked in front of the owner's words, which go unchanged as the instruction. "$" opens a skills-only menu at the caret, after a space or at the start, only while a skill matches, so "$5" or "$HOME" in prose opens nothing. A `$` word counts only when it is an offered key exactly, in lower case, and not inside backticks.
- **Hermes's stacking is mirrored, and checked.** Hermes reads up to four more leading `/name` words of the argument as skills (`split_stacked_skill_commands`), five in all. The app does the same reading before sending. A message that would make Hermes load a skill that's off here (say `/debugging /notes ...` with `notes` off for `tui`), or names more than five, isn't sent, and the composer says why.
- **Nothing is run that isn't a skill.** Any answer but `{type: "skill"}` is refused before `prompt.submit`, so a skill bundle by the same name (not in the catalog) is never sent from here. A 4018 answer means Hermes has no such skill for the session now; the message is marked failed with that reason, and nothing reached the chat.
- **The skill's text isn't kept here.** The outbox keeps the call (`name`, `arg`) and the invocation shown, never the SKILL.md text, so Retry asks Hermes to build the message again. A send whose fate is unknown is settled by the history as before (ADR 0006): `session.resume` shows the invocation, and the stored rows read over REST hold the full text, which the app reads back the way Hermes's `describe_skill_invocation` does. That reading is tested against output of Hermes's own function (`tools/skill-invocation-golden.py`).

### Considered options

- **Send `/name words` with `prompt.submit` and let Hermes expand it.** Not possible: `prompt.submit` sends text as typed; the client has to call `command.dispatch`.
- **Send `$name` as plain text, as Hermes's clients send an inline `/name`.** Rejected: the skill would load only if the model chose to, which isn't "running" it.
- **Offer every catalog skill.** Rejected: the catalog keeps a skill turned off only for `tui` or `desktop` in the list, and `command.dispatch` would load it.

### Consequences

- A message that runs a skill can't carry files and can't be queued; the composer says so and keeps the text. Hermes builds the message for the chat's live session when it goes, and file references would land around the skill's text.
- The composer shows "Sends with the debugging skill" under it while the text runs one, so a `$` word isn't a surprise.
- The catalog is read for the profile, not the chat's folder. A project-local skill in the chat's repository can shadow a profile skill of the same name when Hermes runs it.
- Skill text is the agent's instructions, as in ADR 0030. The chat never shows it: the bubble shows Hermes's `display` while the message goes and the history's invocation once it's stored.
