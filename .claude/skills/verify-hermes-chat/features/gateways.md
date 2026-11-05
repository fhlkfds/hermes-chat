# Gateways

Settings → Gateways sets up one profile's Telegram and Discord gateways on the server, picked in the tab's profile list, one platform at a time beside a sub-nav. Each platform shows its state as Hermes reports it, a Turned on switch, its bot token as Hermes's redacted preview (Replace opens an empty masked field, Remove clears it on Save, a row left alone keeps it), its allowed user IDs, Check status (sends no message), and Save. Save reads the platform first and sends nothing if it changed on the server, then says "Saved, and Hermes reads it back that way" only once a read shows all of it.

## Sub-features

- `gw-list`: the sub-nav lists Telegram and Discord; each shows Status, Turned on, its settings and the token's preview, never the token.
- `gw-replace`: Replace, paste, Save; the preview changes and the field is gone.
- `gw-remove`: Remove, Save; the row says "Not set."
- `gw-switch`: the switch changes only on Save, and a new token alone never turns a platform on.
- `gw-invalid-token`: a token Hermes or the platform turns down reads "Token turned down".
- `gw-missing-dependency`: a gateway without python-telegram-bot or discord.py reads "Missing on the server".
- `gw-conflict`: a change made on the server after the screen read it stops the save with "changed on the server".
- `gw-check`: Check status shows Hermes's answer.
- `gw-profile`: the profile list shows another profile's gateways.

## How to get to it (user POV)

- Rail → Settings (gear) → **Gateways** tab.
- Settings search for "Telegram" or "Discord" → **Open Gateways**.

## Driving it with wd.mjs

Preconditions:

- Signed in ([sign-in.md](sign-in.md)). The stand-in's FakeHermes has the messaging routes with nothing set. For the gateway's own states (missing dependency, a running gateway), use a real `f0d94882` dashboard: `hv up --dashboard <url>`, and start its gateway with `hermes gateway run` under the same `env -i` and `HERMES_HOME`. The box's Hermes venv has neither python-telegram-bot nor discord.py, so an enabled platform reports `missing_dependency` there.

- **Open.** `$S/wd.mjs click button Settings`, `$S/wd.mjs click '[role=tab]' Gateways`, `$S/wd.mjs wait h2 Telegram`.
- **Turned-down token.** `$S/wd.mjs click button "Add Telegram bot token"`, `$S/wd.mjs fill input "Telegram bot token" -- not-a-token`, `$S/wd.mjs click button Save`, `$S/wd.mjs wait '[role=alert]' "Token turned down"`.
- **Replace.** `$S/wd.mjs fill input "Telegram bot token" -- 123456789:AAAAdummydummydummydummydummydummy00`, `$S/wd.mjs click '[role=switch]' ` (Turned on), `$S/wd.mjs click button Save`, `$S/wd.mjs wait '[role=status]' "Hermes reads it back"`. The token row shows `«redacted:1234...my00»`; the dashboard's `GET /api/messaging/platforms` shows `is_set: true`, `enabled: true`.
- **Missing dependency.** Start the gateway, then `$S/wd.mjs click button "Read again"` and `$S/wd.mjs wait .gw-problem "Missing on the server"`.
- **Check status.** `$S/wd.mjs click button "Check status"`, `$S/wd.mjs wait .gw-line "python-telegram-bot not installed"`.
- **Conflict.** Change the token through the dashboard's API, then flip the switch, `$S/wd.mjs click button Save`, `$S/wd.mjs wait .gw-line "changed on the server"`.
- **Remove.** `$S/wd.mjs click button "Remove Telegram bot token"`, `$S/wd.mjs click button Save`, `$S/wd.mjs wait .set-hint "Not set."`.
- **Discord.** `$S/wd.mjs click '.subnav-item' Discord`, `$S/wd.mjs wait h2 Discord`.

## Gotchas

- A live connection to Telegram or Discord needs a real bot token and account; dummy tokens only reach the "turned down" and "missing" states.
- Hermes turns a platform on by itself when a token is saved without `enabled`; the app always sends the switch, so check `enabled` on the server after a token-only save.
- Starting the gateway with dummy tokens and the libraries installed would make it contact Telegram or Discord. Without them it stops at `missing_dependency` and contacts nothing.
