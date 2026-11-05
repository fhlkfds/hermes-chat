# Skills in the composer (#188)

Captured on 2026-11-04 from the real Tauri debug application (WebKitGTK, `tauri build --debug --no-bundle`) on an Xvfb
display at the app's 1280 × 820 window. They are framebuffer captures, not mockups, and nothing was retouched.

- **Before**: the app built from `main` at `af77a05`.
- **After**: the app built from this branch's final code.

Both were signed in by URL to `bridge.ts`, a stand-in dashboard on `127.0.0.1:47810` answered by the tests'
`FakeHermes`. Its chats, messages and skills are synthetic. It has six skills in the default profile. `notes` is kept off
for this app's chats (`skills.platform_disabled.tui`) and `old-deploy` is off for the profile (`skills.disabled`), so
neither is offered. The fake's `commands.catalog` and `command.dispatch` answer in the deployed Hermes's format
(`f0d9488`). The keyring warning at sign-in comes from the app running on its own D-Bus session bus, and nothing was
written to a real keyring.

1. `before-1-slash-menu.png`: "/" lists the app's commands only.
2. `before-2-dollar-typed.png`: "$re" typed mid-message opens nothing.
3. `before-3-sent.png`: "Clear the stale lock using $restic-maintenance" went out as plain text, so the skill wasn't loaded.
4. `after-1-slash-menu.png`: "/" lists the commands, then a Skills heading.
5. `after-2-slash-menu-skills.png`: the menu scrolled to the skills. `notes` and `old-deploy` aren't there.
6. `after-3-dollar-menu.png`: "$re" mid-message opens a skills-only menu, filtered as the command menu filters.
7. `after-4-runs-with.png`: `$restic-maintenance` picked. The note under the composer says the message runs that skill.
8. `after-5-sent.png`: sent. Hermes's `command.dispatch` built the message and the chat shows its `display`, the
   invocation `/restic-maintenance Clear the stale lock using $restic-maintenance`, not the skill's text. The reply is
   the bridge's synthetic one (`GET /__finish`).
9. `after-6-help.png`: `/help` explains `/` and `$` for skills.

To reproduce: build the bridge (`npx rolldown docs/screenshots/composer-skills/bridge.ts --platform node -o
/tmp/skills-bridge.mjs`), run `session.sh <app binary> <display>` in the background, then drop `steps.sh` into its queue
folder as `1.sh`. The clicks are at fixed coordinates for that window size.
