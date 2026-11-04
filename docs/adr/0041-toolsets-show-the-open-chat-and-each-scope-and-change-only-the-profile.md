# Toolsets show the open chat, inherited and forced values, and each scope, and change only the profile

Builds on ADR 0021, which still decides how a change is written and confirmed. #72 also asks that the screen say whether a change reaches this chat, the profile or the whole server, and that it show inherited and forced values separately. Hermes at the deployed `f0d94882e8` (v0.22.6; its toolset routes are unchanged since `bf0203a`) answers each of these with a read, but has a write that keeps the conversation going only for the profile. So Settings → Toolsets reads all three scopes and changes only the profile.

- **This chat, read.** The screen reads the open chat (the active pane's) with `tools.show {session_id}` over `/api/ws`: the tool definitions Hermes builds for that session's agent (`_session_toolsets`: the built agent's `enabled_toolsets` and `disabled_toolsets`, through `get_tool_definitions`, so `agent.disabled_toolsets` and unmet requirements are applied). Before the agent is built, which happens on the chat's first prompt, the answer is what the session's profile would build it with. Under each toolset it says whether the chat has it, and says so when that differs from the profile's setting. It reads again after every change, on Refresh, on window focus, and whenever the chat's live session changes (a reconnect and reopen).
- **Only for the profile the dashboard runs as.** `tools.show` picks the session's own toolsets, but `get_tool_definitions` then checks each tool's requirements (keys, packages, plugin tools) outside the session's profile scope, so as the profile the dashboard process runs as. For a chat in another profile, what it is offered can differ. So the chat is read only when `GET /api/profiles/active` says `current` is the profile shown. For any other profile the screen says Hermes can't say for certain, and shows the profile's setting only. Closing this needs `tools.show` to run `get_tool_definitions` under `_session_profile_runtime_scope`, or to list the built agent's own tool names.
- **Hermes's fallback isn't taken for the chat's.** `tools.show` answers a session id Hermes no longer holds with the launch profile's config, not an error. So `session.status {session_id}`, which answers 4001 for an id Hermes doesn't hold, is asked after `tools.show`. Only when it still finds the session does the answer count, since the session was then there when `tools.show` read it. Otherwise the screen says Hermes no longer has the chat open. An older server without `tools.show` (−32601) shows the profile's setting only.
- **Late answers.** Each read of the chat is numbered, and only the latest one's answer, for the live session still shown, is used. A profile switch remounts the screen. A dropped connection clears every chat's live session id (`Chat.runtimeId`), so nothing from the old connection is shown as the chat's.
- **The profile, changed.** As ADR 0021. Rust's config read now also passes which platforms have a list the profile has saved (`platform_toolsets.<platform>` that Hermes reads as a list: `_platform_toolsets_explicitly_saved`). Without one, the profile inherits Hermes's default for that platform. Each toolset is then marked Inherited, and the screen says the first change saves the whole list into the profile (Hermes's `_save_platform_tools`). A list saved in a form Rust can't read for certain is called unclear, not inherited. The read is repeated after each change, so Inherited turns into Saved in profile only once the config shows it.
- **Forced values, apart.** These are shown apart from the profile's own value:
  - **Forced off:** `agent.disabled_toolsets` (ADR 0021), its own names marked "Forced off on every platform", its composites named above the list.
  - **Forced on in a chat:** a toolset the chat has though the profile has it off, such as the `project` toolset Hermes folds into every non-desktop session (`_with_session_toolsets`). It shows only in the chat's line.
  - **Server pin:** `HERMES_TUI_TOOLSETS` replaces the list for every chat the server builds. No route reports it, so the screen names it as possible.
- **When it takes effect, checked live.** Against a throwaway dashboard at `f0d94882e8` whose model was a stub endpoint recording the tools each request offered (`tools/toolsets-chat-live.py`), turning `web` off:
  - The open chat kept `web_search`, in `tools.show` and on its next turn.
  - A chat started afterwards didn't offer it on its first turn.
  - Reopened right after a reconnect, Hermes reattached the same session with the same tools.
  - Reopened after Hermes stopped holding it (20 s after the socket closed, Hermes's default `ws_orphan_reap_grace_s`), the chat was a new session without `web_search`, on its next turn too.

  So the screen says that a change reaches chats Hermes starts or opens again afterwards, never a chat's next turn, and it reads what the chat has instead of predicting the reopen.

## Considered options

- **A per-chat switch through `tools.configure {session_id}`.** Rejected. It writes the profile's `platform_toolsets.cli` (through `_save_platform_tools`, but with a load and save outside the dashboard route's `config_write_scope` lock), so every chat in the profile changes, not this one. It then runs `_reset_session_agent`, which empties the chat's in-memory history and queued prompts like `/new`. It refuses with 4009 while a turn runs, so it never changes a running reply, but it is not a chat's own setting and it loses the conversation's state.
- **A server-wide switch.** Not offered: `HERMES_TUI_TOOLSETS` lives in the dashboard process's environment, and no route reads or writes it.
- **Predict the chat's tools from the profile's list.** Rejected. The chat's agent may be older than the list, the server may pin a list, coding focus may swap one in, Hermes folds client toolsets in, and tools whose requirements aren't met are left out. `tools.show` is Hermes's own answer.
- **Read the chat with `tools.list` / `toolsets.list {session_id}`.** Rejected. Their `enabled` flag is membership in the agent's `enabled_toolsets` only, without `agent.disabled_toolsets` or requirements, so a stripped toolset would read as on.

## Capability gap, and a backend design that would close it

Hermes has no write that changes one chat's toolsets and keeps the conversation. What it would take:

- `PUT /api/sessions/{id}/toolsets?profile=` with `{enabled: {name: bool}}` (the stored session id), kept on the session row as an override applied over the profile's list by `_load_enabled_toolsets` whenever that session's agent is built.
- For a live session that isn't running, the agent's tool snapshot refreshed in place (as `_refresh_live_sessions` already does for MCP and plugin changes, with `preserve_prefix`), instead of `_reset_session_agent`. While a turn runs, 409, so a reply's tools never change under it.
- An answer that names the session's effective toolsets read back, and a `toolsets_revision` both on the session and on the profile's `platform_toolsets`, so a client can write with `If-Match` instead of ADR 0021's check-then-write window.

A server-wide default would need a dashboard route over a server-level config, which Hermes doesn't have. Until such routes exist, the screen marks this chat and the whole server as "Not changeable here", with why.

## Consequences

- Two read-only RPCs per chat read (`tools.show`, `session.status`), and one more config read through Rust after each change. No secret leaves Rust: `savedLists` is platform names only.
- With no chat open, or a chat not opened on Hermes yet on this connection, the screen says so and shows the profile's setting only.
- `tools.show` lists tools by name, and a toolset's row compares its listed tools. A toolset whose tools the chat has only in part reads "has N of its M tools".
- Not verified with a real model or provider: the turns ran against a stub endpoint, so what an actual model does with the offered tools isn't covered. The 20-second park is Hermes's default, configurable on the server.
