# Toolsets screenshots

Captured on 2026-11-02 from the running Tauri debug build of commit `e110963` (WebKitGTK) on an Xvfb display. These are framebuffer captures of the 1280 × 820 window, not mockups, and nothing was composited or retouched.

The app was signed in through its real Rust transport (URL mode) to a real Hermes dashboard: the deployed checkout at `bf0203a`, run on the Hermes server from its existing dependency environment, with `HERMES_HOME` in a throwaway folder under `/tmp`, bound to loopback with the sign-in gate on, and reached through an SSH tunnel. Every toolset, state, provider status and error shown came from that server. Its config started empty apart from a few unrelated test keys, so it is not the owner's setup. The owner's own config was never read or written.

To show each state, the throwaway config was changed by hand on the server between captures: `no_mcp` added to `platform_toolsets.cli` (images 4–5), `agent.disabled_toolsets: [debugging]` added (6) and removed again, and the home folder made read-only for one change (7), which makes Hermes's save fail with a 500. For image 2, a small local proxy between the app and the tunnel held each toggle `PUT` for 4 seconds, so the Saving state stays visible; the real write takes milliseconds. Image 10 is that proxy stopped, dropping the connection.

- `01-toolset-list.png`: the list as Hermes reports it, with what the setting reaches, when it applies, and that it isn't Approvals or YOLO. Vision is marked Needs setup from Hermes's own key check.
- `02-saving.png`: a change on its way. Every switch and Refresh wait. (In an earlier capture of this state at `43173e5`, a click on another switch during it sent nothing; the server still had that toolset as before.)
- `03-saved.png`: the change read back from Hermes.
- `04-confirm-no-mcp.png`: the profile has `no_mcp` for the CLI, which Hermes clears on any toolset save, so the app asks first. (From `e110963`, where the confirmation opened above the list; since `f7e29b0` it opens under the toolset's row, as in image 14.)
- `05-saved-mcp-back.png`: after confirming, read back: Hermes cleared `no_mcp` (checked in the config on the server), and the unrelated test keys were kept.
- `06-read-back-mismatch.png`: Hermes answered `ok` for turning Web on, but `agent.disabled_toolsets` still resolves it off, so the app reports a mismatch, not success.
- `07-server-error.png`: Hermes's save failed with a 500; the app doesn't call it refused or saved, and says what a later read found.
- `08-needs-setup.png`: Speech-to-Text marked Needs setup because its active provider, Local Whisper, isn't installed on that server, though Hermes's key check counts it configured; toolsets with no ready provider likewise.
- `09-other-platforms.png`: the Discord toolsets, kept apart because they change Hermes's Discord chats, not this app's. A plugin's long description is cut to two lines.
- `10-disconnected.png`: the connection dropped: the last read stays, says when it was read, and can't be changed.
- `11-other-profile.png`: after switching to another profile in the same throwaway home, its own toolsets, which differ from `default`'s. The chat list's error is that profile having no gateway running, unrelated to toolsets.
- `12-disabled-everywhere-notice.png`, `13-off-on-every-platform.png`: captured later, from builds of `3e0113e` (12–13) and `f7e29b0` (14–15), with `agent.disabled_toolsets: [tts, debugging]` and a `telegram` list naming `tts` added to the same throwaway config. `debugging`, a composite that no switch undoes, is named above the list; Text-to-Speech, named there itself, is marked Off on every platform.
- `14-confirm-off-everywhere.png`: turning Text-to-Speech on asks first, under its row, because Hermes's save takes it off `agent.disabled_toolsets` and so turns it back on for Telegram too.
- `15-saved-everywhere-back.png`: after confirming, read back as on, and the config read again shows `tts` gone from `agent.disabled_toolsets` (checked on the server: `debugging` and the `telegram` list stayed).

Not shown from the real server: the install confirmation for Computer Use (its `cua_driver` was already installed there, so Hermes had nothing to install) and the running-reply notice (the throwaway home has no model to run a reply). Both are covered by `src/ui/toolsets.test.tsx`.
