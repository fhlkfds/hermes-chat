# Toolset scope screenshots (#72)

Captured on 2026-11-04 from the running Tauri debug build of this branch (WebKitGTK) on an Xvfb display. These are framebuffer captures of the window, not mockups, and nothing was composited or retouched. Images 1–4 are 1280 × 820; images 5–6 are 760 × 820, the app's minimum width.

The app was signed in through its real Rust transport (URL mode) to a real Hermes dashboard: the deployed checkout `f0d94882e8` (Hermes 0.22.6), run from a git worktree with `HERMES_HOME` in a throwaway folder under `/tmp`, on `127.0.0.2` with the sign-in gate on and a throwaway password. The owner's config was never read or written. The profile's model is a local stub endpoint that answers every turn with "ok" (the chat's title, "ok #5", came from it too). The chat's turns are real Hermes turns, so its agent and tools are Hermes's own. Every toolset, state, readiness and chat line shown came from that server.

Between captures the throwaway config was changed by hand on the server: `platform_toolsets` removed so the profile inherits Hermes's default (image 1), and `agent.disabled_toolsets: [tts]` added (image 3).

- `01-scopes-inherited-and-this-chat.png`: what a change reaches (this chat and the whole server can't be changed here, the profile can). The profile inherits Hermes's default list, so each toolset is marked Inherited. Each line under a toolset is what Hermes offers the open chat, from `tools.show`. Browser Automation is on for the profile, but the chat isn't offered its tools because none of its providers is ready.
- `02-saved-open-chat-keeps-its-tools.png`: Web Search turned off, read back as saved. The config read again shows the profile's own saved list now, so Inherited is gone. The open chat still has Web Search, and the screen says that isn't the profile's setting.
- `03-forced-off-and-missing-dependencies.png`: Text-to-Speech, which `agent.disabled_toolsets` forces off on every platform, is marked separately from the profile's own value, while the open chat still has it. Image Generation and Speech-to-Text show Hermes's own missing-dependency readiness, without any key.
- `04-reopened-after-reconnect.png`: the app was closed, and reopened after Hermes stopped holding the chat (more than 20 seconds later). The reopened chat no longer has Web Search, as the profile's list says.
- `05-narrow-window-keyboard-focus.png`: the minimum window width, with keyboard focus on a switch reached with Tab.
- `06-narrow-window-scopes.png`: the scope list at the minimum width. (The Settings tab bar scrolling sideways at this width predates this change.)

Not shown from the real server: a reply running while the screen is open (the stub answers at once), and a server without `tools.show`. `src/ui/toolsets.test.tsx` covers both.
