# Hermes approval mode mid-session: research for issue #277

- Date: 2026-11-06
- Question (issue [#277](https://github.com/l0cky12/hermes-chat/issues/277)): can a client change `approvals.mode` (manual / smart / off) or YOLO for one session while it runs? If not, what server change would allow it?
- Upstream: https://github.com/NousResearch/hermes-agent at two commits:
  - **D** = deployed `f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab` (committed 2026-11-02). Read-only worktree at `/tmp/hermes-277/deployed`.
  - **M** = `main` at `6b21d0564de0492e2ebd0d8f63fca86c03b5c892` (committed 2026-11-07). Read-only clone at `/tmp/hermes-277/hermes-agent`.
- Citations are `path:line` relative to the clone root. "D 12 / M 14" means line 12 at D and line 14 at M. One number with no label means the line is the same at both SHAs. Permalink form: `https://github.com/NousResearch/hermes-agent/blob/<sha>/<path>#L<line>`.
- Starting point: the first pass posted to the issue ([comment 6698133642](https://github.com/l0cky12/hermes-chat/issues/277#issuecomment-6698133642)). It was treated as a prior to check. Every `path:line` it cites was re-read at both SHAs. Corrections are listed in "Corrections to the first pass" below.
- App context: this app speaks only the **legacy** WebSocket generation that `hermes dashboard` serves on 9119 (`docs/adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md`). The legacy handlers live in `tui_gateway/`. The canonical "owner" handlers in `gateway/session_*.py` are covered briefly for completeness. They don't affect the app today.
- Status key: CONFIRMED = read in upstream source at the named SHA. STALE = a claim in the first pass or the issue that the source contradicts. UNCONFIRMED = not found in source or not tested on the live server. Nothing in this note was tested on the live server.

## Summary

| # | Question | Answer at D (deployed) | Answer at M (main) | Status |
|---|----------|------------------------|--------------------|--------|
| 1 | Per-session YOLO during a running session? | Yes. `config.set {session_id, key: "yolo", value}` with no `scope` (or `scope: "session"`) flips only that session's flag. It is stored on the session row and restored on resume. The app already sends this (`src/hermes/transport.ts` `setYolo`). | Same. | CONFIRMED |
| 2 | Per-session `approvals.mode` (manual / smart / off)? | No. Every write path (`config.set approvals.mode`, `/approvals`, dashboard `PUT /api/config`) writes the profile's `config.yaml`, which every session of that profile reads. | No. Same paths. `main` also refuses the write with 4030 when an administrator pins the key. | CONFIRMED |
| 3 | When does a change apply? | At the next guarded action, which can be mid-turn. Guards read the mode on every check through an mtime-keyed config cache. Exceptions: managed-worker sessions and hosted rooms, which use a frozen copy (see section 3). | Same. | CONFIRMED (source read; not tested live) |
| 4 | Any other surface that sets either value per session? | Per-session YOLO only: messaging `/yolo` (per routing entry), the TUI `/yolo` (maps to `config.set yolo`), the CLI `/yolo`, the canonical owner's `config.set yolo`. No surface sets `approvals.mode` per session. The OpenAI-compatible API server has no setter for either. | Same. | CONFIRMED |
| 5 | What does legacy `session.info` report? | `approval_mode` (the effective profile mode) and `yolo` = process `--yolo` OR the session flag OR `approval_mode == "off"`. Re-sent to every live session after a mode write. | Same lines. | CONFIRMED |
| 6 | Is the smart-mode guardian gated? | Yes, on several things: it runs only in the shell and `execute_code` guards, only after the floors, bypass, allowlist and session-approval checks, only when a human channel exists, and only for a command the detector flagged. A failed or empty guardian answer escalates to a human. A DENY on an interactive surface still lets the human approve once. | Same. On the canonical owner, `main` makes the guardian's model config follow `config.yaml`; at D it was frozen per session. | CONFIRMED |

The answer for the issue: per chat for YOLO, profile-wide for Manual / Smart / Off, unless the server change in the last section lands.

## 1) Per-session YOLO (legacy WebSocket)

- **Dispatch.** `config.set` maps `"yolo"` to `_set_yolo` (`tui_gateway/methods_config_set.py` D 516 / M 575). CONFIRMED.
- **Scopes.** `_set_yolo` (D 299-329 / M 346-376) reads `scope`, defaulting to `"session"` (D 303 / M 350):
  - Session branch (D 312-322 / M 359-369): `toggle_session_yolo(session["session_key"], ...)` flips only this session's flag and persists it through `db.set_session_yolo(row_id, on)`. It then emits `session.info` for this session (D 322 / M 369).
  - `scope: "global"` (D 305-311 / M 352-358) writes `approvals.mode` as `"off"` or `"manual"` and never restores `"smart"` (comment at D 310 / M 357: `binary: no "smart" restore`).
  - No live session (D 323-327 / M 370-374): sets or pops `HERMES_YOLO_MODE` in the gateway's `os.environ`. This does not change the gateway's own checks, because `_YOLO_MODE_FROZEN` is read once at import (`tools/approval.py` D 44-46 / M 46-48). Child processes started later inherit it.
- **Stale session id.** `yolo` is in `_SESSION_SCOPED_KEYS` (D 527 / M 586). A non-empty `session_id` the backend no longer holds, with no `scope: "global"`, is answered by `_sess_nowait` (D 535-537 / M 594-596). That returns 4001, never the sessionless env write. CONFIRMED.
- **In-memory state.** `_session_yolo: set[str]` (`tools/approval.py` D 54 / M 56), changed under `_lock` by `_set_session_yolo` (D 281-286 / M 294-299), cleared by `clear_session` (D 299-321 / M 312-334).
- **What a guard checks.** `_yolo_active()` (D 337-343 / M 350-356) is true for the frozen process `--yolo`, the current session's flag, or `gateway.session_finite.unattended_turn()` (a `hermes -z` one-shot, `gateway/session_finite.py:27-30`).
- **Persistence.** `SessionDB.set_session_yolo` writes `model_config.yolo_mode` on the row (`hermes_state_sessions.py:823-827`). `session_yolo_enabled` reads it back and returns False on any parse error (`:829-832`). Resume re-arms it (`tui_gateway/methods_session.py:1066-1067`, `tools/approval_yolo.py:46-56`). Compression moves it to the new session id (`tui_gateway/session_compression.py:336-337`, `tools/approval_yolo.py:93`). A toggle made before the row exists is folded in when the row is created (`with_session_yolo`, `tools/approval_yolo.py:106`).

The app path is CONFIRMED to be session-scoped: `setYolo` sends `{session_id, profile, key: "yolo", value: "on"|"off"}` with no `scope` (`src/hermes/transport.ts:2928`).

## 2) Profile-wide `approvals.mode`

Every way to set the mode writes the profile's `config.yaml`:

| Surface | Path | What it writes | Status |
|---|---|---|---|
| Legacy WS `config.set {key: "approvals.mode"}` | `tui_gateway/methods_config_set.py` D 379-380 / M 426-427 (spec), `_set_word` D 398-404 / M 445-451 | `_write_config_key("approvals.mode", w)` then `_emit_all_session_info()`. Accepts `manual`, `smart`, `off` (`tui_gateway/server.py:1254`). Ignores `session_id` except to pick the profile. | CONFIRMED |
| Legacy alias `config.set {key: "approval_mode"}` | `_set_approval_mode` D 295-296 / M 342-343 | Same write, reported under the real key. | CONFIRMED |
| Which profile | `@_profile_scoped` wrapper, `tui_gateway/server.py:485-514` | `params.profile` if set (`:504-506`), else the live session's `profile_home`, else the connection's profile (`:507-511`). | CONFIRMED |
| Legacy WS `slash.exec "/approvals smart"` | `tui_gateway/methods_tools.py` D 1027 / M 1029 sends it to the slash worker. `hermes_cli/cli_commands_mixin.py` D 1939 / M 1938 runs `run_approval_mode_command`. `tui_gateway/methods_slash.py:433-435, 484` re-sends `session.info`. | Profile `config.yaml`. | CONFIRMED |
| Messaging `/approvals <mode>` (Telegram, Discord, …) | `gateway/slash_commands.py` D 947-960 / M 944-957 | Profile `config.yaml`. Refused for non-admins when an access policy is configured (D 956-957 / M 953-954). | CONFIRMED |
| Dashboard REST `PUT /api/config` and `PUT /api/config/raw` | `hermes_cli/web_routers/config_env.py` D 118 / M 122. `hermes_cli/web_routers/analytics.py:57` | The whole config document. When `approvals.mode` changed, `_broadcast_gateway_session_info()` runs (config_env D 141-153 / M 145-157; analytics 67-71). | CONFIRMED |
| Canonical owner `config.set {key: "approvals.mode"}` | `gateway/session_tui_config.py` D 188-189 / M 202-203, `_set_approval_mode` D 300-309 / M 337-349 | Profile `config.yaml` via `run_approval_mode_command`. Refuses any param other than `session_id, profile, key, value` (D 180 / M 194). Sends no `session.info`. | CONFIRMED |
| OpenAI-compatible API server (`gateway/platforms/api_server*.py`) | grep for `yolo`, `approval_mode`, `approvals.mode` finds no setter at either SHA. Only approval answers exist (`api_server_runs.py` D 1369-1389 / M 1374-1394). | Nothing. | CONFIRMED |

The shared helper says it in its own docstring: "Approval mode is profile-scoped configuration, not conversation state. Changing it affects subsequent terminal guard checks immediately because approval.py loads config on each check" (`hermes_cli/approval_mode.py:1-7`, same at both SHAs). CONFIRMED.

**Administrator-managed key (M only).** At M, `_write_config_keys` calls `_refuse_managed_keys` before writing (`tui_gateway/server.py` M 1234-1237). That raises `ManagedKeyError` (`methods_config_set.py` M 20-34), which `config.set` answers with 4030 (M 607-608). This covers `approvals.mode` and also `yolo` with `scope: "global"`. The canonical owner path names the key in its refusal (`gateway/session_tui_config.py` M 345-346, commit `8987ae565f`). D has neither check (`tui_gateway/server.py` D 1234-1250). CONFIRMED.

## 3) When a change takes effect

- `_get_approval_mode()` (`tools/approval_context.py:294-302`, same file at both SHAs) returns the bound hosted-room policy's mode if there is one (`:296-301`). Otherwise it returns `approvals.mode` from `load_config_readonly()` (`_get_approval_config`, `:283-291`). There is no per-session override. CONFIRMED.
- `load_config_readonly()` (`hermes_cli/config.py:1985-1989`) serves a cache keyed on the file's mtime and size. A write gets a fresh inode, so the next read sees it without explicit invalidation (`hermes_cli/config.py:171-176`). `tools/approval_detection.py` D 24-25 / M 26-27 says it directly: "the config cache is mtime-keyed, so a write takes effect mid-session". CONFIRMED.
- The guards call `_get_approval_mode()` each time they run:
  - Shell: `check_all_command_guards` (`tools/approval.py` D 1161 / M 1238), at D 1179-1180 / M 1256-1257.
  - `execute_code`: `check_execute_code_guard` (D 1226 / M 1307), at D 1249-1250 / M 1330-1331.
  - The shared gate `_run_approval_gate` (D 978 / M 1048), at D 1000 / M 1072. File writes to approval-required paths, the MCP trust prompt, plugin rules and computer use go through it.
  - `check_dangerous_command` (D 1105 / M 1177): at D it checks only `_yolo_active()` (D 1116), and `mode == "off"` is caught one step later in `_run_approval_gate`. M adds the explicit `or ... == "off"` (M 1188, commit `ef1dbcfcbb`). Same outcome.
- So on the legacy WS, a mode change applies at the next guarded action, which can be inside the current turn. The issue's "these settings are read at session start; changing them requires `/reset` or a new session" is STALE for this path.

Exceptions where a change does **not** apply mid-session:

- **Managed-worker sessions (canonical owner only).** Safe-mode, config-only and kanban sessions run out of process. So do custom-provider CLI sessions when `gateway.managed_workers: true` (`gateway/session_managed_worker.py:40-56`). The worker binds the session's frozen config as the only config any reader sees (`agent/managed_worker.py` D 129-142 / M 130; `hermes_cli/config.py:2215-2218`). `approvals` is not in `FOLLOW_SECTIONS` (`gateway/session_policy.py:22-23`), and `_worker_config` re-reads only `command_allowlist` from the live profile (`gateway/session_managed_worker.py:92-108`). Such a session keeps the `approvals.mode` it was created with. YOLO still applies per turn, because the owner sends the route's live flag in `turn_v1.yolo` (`:75`, `_session_yolo` `:110-118`). CONFIRMED by source read. Not reachable from this app.
- **Hosted rooms.** The room policy fixes `approval_mode` when it is built (`gateway/hosted_room_execution_policy.py:103-107`) and binds it through a ContextVar for the room's turns (`:113-124`). CONFIRMED.
- **Parallel terminal batches.** `check_all_command_guards` first takes a decision prepared ahead for a parallel batch of terminal calls (`tools/approval.py` D 1174-1177 / M 1251-1254; `agent/terminal_approval_batch.py:1-7`). A mode change between preparing and running one batch might not reach the commands already prepared. UNCONFIRMED: inferred from the code shape, not traced end to end.

## 4) What `session.info` reports

- **Legacy (`tui_gateway/server.py`, `_session_info` at 1454, same lines at both SHAs).** `approval_mode = _load_approval_mode()` (`:1474`), which calls the guard's own `_get_approval_mode()`, so it includes the managed overlay and any hosted-room override (`tui_gateway/agent_factory.py:241-246`). `yolo = _YOLO_MODE_FROZEN or session_yolo or approval_mode == "off"` (`:1469-1477`). Both go out in the event (`:1501`). It doesn't include `unattended_turn()`, which can't happen on a dashboard WS session. CONFIRMED.
- It is re-sent after a session-scoped `yolo` write (one session), after any `approvals.mode` write over `config.set` or `/approvals` (all sessions), and after a dashboard REST config save that changed the mode (all sessions in the process, own profile only). See section 2.
- `config.get {key: "approvals.mode"}` also returns the effective mode (`tui_gateway/methods_config.py` D 272-273 / M 273-274).
- **Canonical owner (not used by this app).** `local_session_info` (`gateway/session_local.py:454`) carries no `approval_mode`. Its `yolo` is the launch `--yolo` OR the route flag only, without `approvals.mode == "off"` (`_classic_cli_fields`, D 510-514 / M 512-516). A client there must read the mode with `config.get approvals.mode` (`gateway/session_config.py` D 105-106 / M 107-108). CONFIRMED.

## 5) The smart-mode guardian and what gates it

- **Default mode.** `"mode": "smart"` is the shipped default (`hermes_cli/config_defaults.py` D 1663 / M 1661), and the docs say so (`website/docs/user-guide/configuration.md` D 3039 / M 3108). `_normalize_approval_mode` falls back to `"manual"` only for an unknown value (`tools/approval_context.py:266-280`). The issue's "`smart` (default)" is CONFIRMED.
- **Where it runs.** Only two call sites pass `smart=approval_mode == "smart"` to `_human_decision`: the shell guard (`tools/approval.py` D 1203 / M 1284) and the `execute_code` guard (D 1294 / M 1375). `_run_approval_gate` calls `_human_decision` without it (D 1044-1048), so file-write, MCP-trust, plugin and computer-use prompts never consult the guardian. In Smart mode they prompt as they would in Manual. CONFIRMED.
- **What runs before it, in the shell guard (D order):**
  1. Container backends skip every prompt: Docker without host bind mounts, Modal, Daytona, Vercel sandbox, or a plugin backend declaring the same (`_should_skip_container_guards` D 1051 / M 1123, applied at D 1167 / M 1244). Only `approvals.deny` rules still block.
  2. Hardline floors and `approvals.deny` globs block outright under any mode (`tools/approval_floors.py:1-7, 23-27`; D 1170-1172).
  3. YOLO or `off` approves (D 1179-1180).
  4. The permanent allowlist approves (D 1182-1183).
  5. No human channel (not CLI, gateway or ask bridge): the unattended rule (`cron_mode`, `single_query_mode`, `unattended_mode`, default `deny`) decides with no guardian (D 1188-1193 / M 1265).
  6. The detector must flag the command, and no earlier session or always approval may cover it (D 1195-1198).
- **The call.** `_smart_approve` (`tools/approval_smart.py:88-146`, file identical at both SHAs) calls `call_llm(task="approval", temperature=0, max_tokens=16, timeout=auxiliary.approval.timeout)` (`:123-127`). The model is whatever `auxiliary.approval` resolves to (default "auto / main model", 30 s timeout, per `website/docs/user-guide/configuration.md` D 1503, 1725). `approvals.smart_policy` is appended to the system prompt (`:68-71`, `:107-113`). An empty answer, an exception or a timeout returns `"escalate"` (`:130-146`), which falls through to the normal human prompt.
- **Verdicts** (`_smart_gate`, `tools/approval.py` D 774-803 / M 844-873). APPROVE approves this command only, with nothing persisted. DENY counts toward the denial breaker (`approvals.denial_breaker_threshold`, default 3, D 62-77). With a human present it still prompts, but offers only once or deny (D 794-795, 818-825). Without one it blocks. ESCALATE prompts as Manual would. So the issue's "denies high-risk" is only true on unattended surfaces. In this app a smart DENY shows up as a prompt.
- **Model config on the canonical owner.** At D an in-process owner session reads its own frozen `auxiliary` section (`gateway/session_policy.py` D 1137-1139: "Auxiliary tasks read the session's frozen section, never live config.yaml"). At M only bypass sessions do. Others follow the profile's `config.yaml` (M 1141-1144). This doesn't apply to the legacy dashboard path the app uses. CONFIRMED.

## 6) What also prompts, and what YOLO does not skip

Kept from the first pass and re-checked. All CONFIRMED, and each file is identical at D and M:

- `execute_code` has its own guard (section 3).
- The MCP trust prompt for a tool not marked read-only is skipped by YOLO or `off` through `is_approval_bypass_active()` (`tools/mcp_tool_handlers.py:67-73`, used at `:135`).
- Writes to approval-required paths such as `~/.ssh/config` go through the routine gate and honour YOLO (`tools/file_tools_write_guards.py:362-365`).
- Writes to `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursorrules` and the project `.hermes` tree **always** ask, even under YOLO, and fail closed with no human channel (`tools/file_tools_write_guards.py:179-184, 260-268`).
- Hardline floors and `approvals.deny` globs block under any mode (`tools/approval_floors.py:3-6, 24-27`).

## 7) Corrections to the issue's own claims

- "Only shell commands ever trigger approval prompts — file writes never do." STALE. `execute_code`, MCP tools without a read-only hint, and writes to approval-required paths and protected instruction files also prompt (section 6).
- "These settings are read at session start; changing them requires `/reset` or a new session." STALE for the legacy WS and the in-process owner. True only for managed-worker sessions and hosted rooms (section 3).
- "`smart` … denies high-risk." Partly STALE. With a human present, a DENY becomes a once-or-deny prompt (section 5).
- "`off` — equivalent to `--yolo`." Close, but they are separate sources: `off` is profile-wide, `--yolo` is process-wide and frozen at import, `/yolo` is per session. All three skip the same prompts, and none skips the protected-file prompt or the floors.

## 8) What the app can build with no server change

- **YOLO per chat.** Done (`setYolo`). Add the one-time warning from the acceptance criteria. The warning should say that writes to `AGENTS.md`, `CLAUDE.md` and `SOUL.md` still ask, and that blocklisted commands are still blocked.
- **Manual / Smart / Off as a profile setting.** Send `config.set {key: "approvals.mode", value, profile}`. The control must say that it changes every chat on that profile, plus the CLI and messaging sessions that share it, not just this chat. It takes effect at the next guarded action, so "Switching to Manual while a chat is open causes the next destructive shell command to prompt" can pass with a profile-wide control.
- **Read state from the server, not from the click.** Show `session.info.approval_mode` and `session.info.yolo`. A per-chat YOLO flag still bypasses prompts after the profile is set to Manual, until that flag is turned off. `yolo: true` with the chat's flag off means the process `--yolo` or `approval_mode: "off"` is the cause. The app already models this (`yoloEverywhere`, `src/hermes/transport.ts:2936-2940, 4767`).
- **Handle refusals.** At M a pinned key answers 4030 and nothing is saved. Show the server's message and keep the old value.
- **UI copy for Smart.** Smart affects only shell commands and `execute_code`. Other prompts behave as in Manual.

## 9) Server change needed for a per-chat Manual / Smart

Neither SHA has one. A per-session override fits beside per-session YOLO. Line numbers are D, with M where it moved.

1. **State.** In `tools/approval.py`, add `_session_approval_mode: dict[str, str]` next to `_session_yolo` (D 54 / M 56), guarded by `_lock`. Pop it in `clear_session` (D 299 / M 312), and move it in the same place `transfer_session_yolo` moves the YOLO flag (`tools/approval_yolo.py:93`).
2. **Read path.** In `tools/approval_context.py` `_get_approval_mode()` (294-302), after the hosted-room check and before the config read, return the override for `get_current_session_key()` when one is set. Every guard and `_load_approval_mode()` already go through this function, so `session.info` and `config.get` report the effective mode with no other change.
3. **Legacy write path.** Give the `approvals.mode` setter (`tui_gateway/methods_config_set.py` D 379-380 / M 426-427) a `scope` parameter, defaulting to `"global"` so existing clients keep their behaviour. With `scope: "session"`, set or clear the session's override. An empty value means "follow the profile". Then emit `session.info` for that session only. **The stale-session gate needs care.** The current gate fires when `scope != "global"` (D 535-537 / M 594-596), and an omitted scope reads as `""`. Adding `approvals.mode` to `_SESSION_SCOPED_KEYS` as is would answer 4001 to a default (global) write that carries a stale `session_id`. Test `scope == "session"` for this key instead.
4. **Persistence.** Store it on the row's `model_config` next to `yolo_mode`, with a `set_session_approval_mode` beside `set_session_yolo` (`hermes_state_sessions.py:823-832`). Restore it on resume (`tui_gateway/methods_session.py:1066-1067`), move it on compression (`tui_gateway/session_compression.py:336-337`), and fold a pre-row choice in the same way `with_session_yolo` does (`tools/approval_yolo.py:106`).
5. **Reporting.** Add `approval_mode_scope: "session" | "profile"` to `_session_info` (`tui_gateway/server.py:1469-1501`), so a client can tell an override from the profile default.
6. **Canonical owner, for parity.** `config.set approvals.mode` rejects a `scope` param today (`gateway/session_tui_config.py` D 180 / M 194). It would need a session branch like `yolo_config` (`gateway/session_busy_controls.py` D 131-160 / M 132-161), persisted on the routing entry as `SessionEntry.yolo` is. Managed workers would need the override in `turn_v1` beside `yolo` (`gateway/session_managed_worker.py:75`). `local_session_info` would need to report the mode at all (section 4).
7. **Precedence.** Floors and `approvals.deny`, then the process `--yolo`, then the session YOLO flag, then a hosted-room policy, then the session override, then `config.yaml`. That keeps per-chat YOLO above per-chat Manual, as the app already assumes.

Until that lands upstream or as a patch on the owner's server, the issue has to choose between a profile-wide Manual / Smart / Off control with clear "every chat on this profile" copy, and waiting for the server change.

## Corrections to the first pass

What changed against the posted comment:

- `_profile_scoped` is `tui_gateway/server.py:485-514`, not `485-498`. The session-profile fallback is at `:507-511`.
- `clear_session` starts at `tools/approval.py` D 299 / M 312 (the comment had D 300-306 and no M).
- `approval_detection.py` M line is `26-27`, not `26`.
- "Every guard checks `_yolo_active() or mode == "off"`" is not literally true at D. `check_dangerous_command` (D 1116) checks only `_yolo_active()` and leaves `off` to `_run_approval_gate`. M adds the explicit check (M 1188). Same outcome.
- `_yolo_active()` also returns true for an unattended `hermes -z` turn (`unattended_turn()`, D 341-343 / M 354-356). The comment didn't mention it.
- 4030 at M is raised from `_write_config_keys` (`tui_gateway/server.py` M 1236-1237) and answered at `methods_config_set.py` M 607-608. It also covers `yolo` with `scope: "global"`. The canonical owner refuses the same way (`gateway/session_tui_config.py` M 345-346).
- The sessionless `config.set yolo` branch writes `HERMES_YOLO_MODE` into the gateway's environment, which has no effect on its own frozen check. New.
- Server-change step 3 as written would make a stale `session_id` answer 4001 for a default global write. It needs a `scope == "session"` test (section 9).
- `with_session_yolo` exists at `tools/approval_yolo.py:106`. The comment named it but gave no location.
- "A change applies at the next guarded command" has exceptions: managed-worker sessions, hosted rooms, and possibly prepared terminal batches (section 3). New.
- The `session.info` description holds for the legacy generation only. The canonical `session.info` has no `approval_mode`, and its `yolo` ignores `off`. New. It doesn't affect this app.
- Smart-mode gating was not covered: shell and `execute_code` only, container skip, unattended rule, escalate on failure, once-or-deny after a DENY, frozen auxiliary config at D on the canonical owner. New (section 5).
- Other surfaces were not covered: dashboard REST `PUT /api/config` and `/api/config/raw` (profile-wide, re-sends `session.info`), messaging `/approvals` (profile-wide, admin-gated), `slash.exec /approvals`, and the API server (no setter). New (section 2).
- The issue's "`smart` (default)" was not checked. It is CONFIRMED (`hermes_cli/config_defaults.py` D 1663 / M 1661).
