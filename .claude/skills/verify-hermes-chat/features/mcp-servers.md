# MCP servers

Settings → MCP servers lists the MCP servers Hermes connects one profile's agent to, picked in the tab's profile list. The owner adds a server from a blank form or Hermes's catalog, edits it in a dialog whose secrets start empty (a blank one keeps what Hermes has), removes it after a question in its row, turns it on or off, tests it (Hermes connects and lists its tools) and signs in to an OAuth server in the browser. Each change says "Hermes reads it back that way" only once the list read again shows it.

## Sub-features

- `mcp-list`: each server's command or URL, switch, sign-in kind, env var names, and "from plugin" (read-only).
- `mcp-test`: Test shows the tools found, or Hermes's reason.
- `mcp-add`: Add server (stdio with env, or URL with a bearer token or OAuth).
- `mcp-edit`: Edit, with empty secret fields; a typed token replaces Hermes's.
- `mcp-remove`: Remove asks in the row; Keep it changes nothing.
- `mcp-switch`: the switch turns a server off or on.
- `mcp-signin`: Sign in opens the provider's page and follows the flow; Stop cancels it.
- `mcp-catalog`: From catalog lists Hermes's catalog and installs an entry with the values it asks for.
- `mcp-profile`: the profile list shows another profile's servers.

## How to get to it (user POV)

- Rail → Settings (gear) → **MCP servers** tab.
- Settings search for "MCP" → **Open MCP servers**.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in ([sign-in.md](sign-in.md)). It seeds `default` with `filesystem` (stdio, Test finds 4 tools), `github` (bearer token, Test fails with a 401), `linear` (OAuth), `weather` (off, with `WEATHER_API_KEY`) and `kanban` (from plugin `kanban-board`); profile `work` has `calendar`. The catalog has `context7` and `brave-search` (asks for `BRAVE_API_KEY`).

- **Open.** `$S/wd.mjs click button Settings`, `$S/wd.mjs click '[role=tab]' "MCP servers"`, `$S/wd.mjs wait .mcp-name filesystem`.
- **Test.** `$S/wd.mjs click button "Test filesystem"` then `$S/wd.mjs wait .mcp-test "4 tools"`; `$S/wd.mjs click button "Test github"` then `$S/wd.mjs wait .mcp-test "Couldn't connect"`.
- **Edit a token.** `$S/wd.mjs click button "Edit github"`; `$S/wd.mjs value '[role=dialog] input[type=password]'` prints nothing. `$S/wd.mjs fill '[role=dialog] input[type=password]' -- new-token`, `$S/wd.mjs click button Save`, `$S/wd.mjs wait .mcp-note "Saved: Hermes reads it back"`. `$S/hv state` shows `mcp.default.github` still with `Bearer ${MCP_GITHUB_API_KEY}`; `bridge.log` shows `PUT /api/env` then `PUT /api/mcp/servers`.
- **Add.** `$S/wd.mjs click button "Add server"`, fill `'[role=dialog] input[autocomplete=off]' Name`, `'[role=dialog] input[placeholder=npx]'`, `'[role=dialog] textarea'`, `button "Add a variable"`, `input "Variable 1 name"` and `input "<NAME> value"`, then `$S/wd.mjs click '[role=dialog] button[type=submit]'` and `$S/wd.mjs wait '[role=status]' "Added <name>"`. `$S/hv state` shows it under `mcp.default`, and the page text never holds the value.
- **Remove.** `$S/wd.mjs click button "Remove <name>"`, then `$S/wd.mjs click '[role=group] button.danger' Remove`, then `$S/wd.mjs wait '[role=status]' "Removed <name>"`.
- **Switch.** `$S/wd.mjs click '[role=switch][aria-labelledby=mcp-weather-label]'`, `$S/wd.mjs wait .mcp-note "Turned on"`.
- **Sign in.** `$S/wd.mjs click button "Sign in to linear"`, `$S/wd.mjs wait .mcp-signin "Finish signing in"`, then `$S/wd.mjs click '.mcp-signin button' Stop` and `$S/wd.mjs wait .mcp-note "Sign-in stopped"`; `bridge.log` shows `DELETE /api/mcp/oauth/flows/flow-1`.
- **Catalog.** `$S/wd.mjs click button "From catalog"`, `$S/wd.mjs click '.mcp-catalog-item' brave`, `$S/wd.mjs fill '[role=dialog] input[type=password]' -- key`, `$S/wd.mjs click '[role=dialog] button' Install`, `$S/wd.mjs wait '[role=status]' "Installed brave-search"`.
- **Another profile.** `$S/wd.mjs select select "Profile whose MCP servers are shown" -- work`, `$S/wd.mjs wait .mcp-name calendar`.

## Gotchas

- There's no browser on the run's display, so Sign in also says "Couldn't open your browser"; the flow still waits until Stop.
- `fill input "URL"` can match the wrong element; use `'[role=dialog] input[placeholder^="https://mcp"]'`.
- The stand-in has no OAuth provider: an approved sign-in is covered by the tests (`mcpSettings.test.tsx`), not here.
- Against a real dashboard, Test runs the server for real: a stdio command must exist on the server, and an HTTP server built on the MCP SDK refuses an unexpected Host header (421) unless it allows it.
