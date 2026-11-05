# Bots view screenshots (#222, ADR 0066)

Captured on 2026-11-04 from the running Tauri debug application (WebKitGTK), built with its frontend embedded, on an Xvfb
display at 1280 × 820 with openbox. The images are on the `pr-assets` branch, in `bot-mode-222/`. No visual elements were
composited or retouched.

**Against FakeHermes** (`bridge.ts` here): the repo's `FakeHermes` (`src/hermes/fakeHermes.ts`) behind real HTTP and
WebSocket on loopback, signed in by its LAN route. It is not a real Hermes dashboard. Every bot, chat and picture is
synthetic. The "before" shots are `main` at `059ddc6`, against the same stand-in.

- `before-1-rail-and-list.png`: main. No Bots button in the rail.
- `before-2-search-finds-bot-chat.png`: main, `scribe` profile. Hermes hides the Bot Chat from the list, but its search
  doesn't filter hidden chats, so "release" finds the Bot Chat.
- `after-1-bots-view.png`: the Bots view. Scribe (pinned, with a picture) is Replying in its Bot Chat, Hermes (the
  default profile) has no Bot Chat yet, and Ops waits on an Approval, so the rail button has a dot.
- `after-2-hidden-bots.png`: "Hidden in Hermes" opened: Night Watch, hidden by its owner in Hermes, dimmed.
- `after-3-bot-chat-open.png`: Scribe's row opened its Bot Chat, marked "Bot". The list holds only the side-chat.
- `after-4-search-leaves-out-bot-chat.png`: the same search as `before-2`; the Bot Chat is left out.
- `after-5-new-bot-chat-in-other-profile.png`: Hermes's row, from `scribe`: the app switched to `default` and created
  its Bot Chat, empty, with no message sent. The list is unchanged.
- `after-6-no-bot-mode.png`: the stand-in switched to a Hermes whose `profiles.list` doesn't report Bot Chats
  (`GET /__bot-mode?no-canonical`). The view says why. The button stays while the view is open.
- `after-7-no-bots-button.png`: after Escape, the Bots button is gone.

**Against a real Hermes**: a throwaway `hermes dashboard --isolated` from the deployed checkout `f0d94882` (private
`HOME`/`HERMES_HOME`, basic-auth gate on `127.0.0.22`), with `scribe` and `ops` profiles and a loopback stub model that
answers with fixed text. Scribe's Bot Chat and picture were made beforehand over `/api/ws` (research doc "Bot Mode").

- `real-1-bots-view.png`: the roster as `profiles.list` reports it: Scribe's picture from `profiles.get_asset`, and
  its Bot Chat's newest message from `canonical_session.preview`.
- `real-2-ops-replying.png`: Ops's row created its Bot Chat on this Hermes (`session.create` hidden, then
  `session.title`), and a message there shows Ops as Replying, from `session.active_list`.
- `real-3-bot-chat-open.png`: Ops's Bot Chat, titled "Bot Chat" on the server and here. The list shows only an
  ordinary chat in `ops`. Looked up by title afterwards, `ops` has exactly one session titled "Bot Chat", hidden.
