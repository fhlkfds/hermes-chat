# External memory screenshots (ADR 0042)

Captured on 2026-11-04 from the running Tauri debug build of this branch (WebKitGTK) on an Xvfb display. These are framebuffer captures of the window, not mockups, and nothing was composited or retouched. Images are 1280 × 900; image 9 is 760 × 900, the app's minimum width.

The app was signed in through its real Rust transport (URL mode) to a real Hermes dashboard: the deployed checkout `f0d94882e8` (Hermes 0.22.6), run from a git worktree with `HERMES_HOME` in a throwaway folder under `/tmp`, on `127.0.0.2` with the sign-in gate on and a throwaway password. The owner's config and live dashboard were never read or written. The throwaway home had five synthetic profiles (`default`, `aegis`, `research`, `scribe`, `work`), Honcho copied from the owner's plugins folder into four of them, and a synthetic Honcho key in `default`'s host block. No Honcho or RetainDB server was contacted: every status, setting and write shown is Hermes's own answer from its config files.

Honcho's Python packages were installed into the throwaway home from the app with Install on the server (image 10 shows that question). Hermes answered `restart_required` for that step, which led to the "restart Hermes there" notice. ByteRover's `curl … | sh` install was only shown (image 6), then cancelled; it was never run.

- `01-profiles-and-their-providers.png`: every profile's provider. `default` and `aegis` point at the same Honcho workspace and peers; `research` and `scribe` each use their own host; `work` uses built-in memory only. Honcho on `aegis`, `research` and `scribe` needs settings because those host blocks have no API key.
- `02-copy-default-settings-to-research.png`: `research`'s Honcho settings after Copy from `default` and typing an API key. Base URL is marked as kept for every profile on the same `honcho.json`.
- `03-copied-unsaved.png`: the copied workspace and peers, marked Unsaved, and the notice saying the key isn't copied.
- `04-saved-and-read-back.png`: Save and use for research, confirmed by reading back. On the server, a `hermes_research` host block now points at `shared-ws`, and the key is in `research`'s `.env`.
- `05-research-now-shares-the-store.png`: the table read again, with `research` on the same store as `default` and `aegis`, and Ready.
- `06-install-asks-first-with-the-commands.png`: ByteRover on `work`, with the exact command Hermes would run on the server, before anything is sent.
- `07-refused-as-not-ready-but-written.png`: RetainDB on `scribe` saved without a key. Hermes refused to switch because it isn't ready, but it had already written the project; the screen says so and leaves nothing marked unsaved. `scribe` stays on Honcho.
- `08-profiles-table-after-sharing.png`: the table with each store setting on its own line.
- `09-minimum-window-width.png`: the table at the minimum width. (The Settings tab bar scrolling sideways at this width predates this change.)
- `10-honcho-install-asks-first.png`: the install question for Honcho's Python packages.

Images 1–7 were taken before the last layout fix, so their table shows each profile's store settings joined on one line; images 8 and 9 show the current table. Image 10 is from the first build: the Copy button sits at the far right and Base URL has no "All profiles on this file" badge yet.

Not shown from the real server: a write whose answer was lost, a change made by another client during a save, and a server without the `/api/memory` routes. `src/ui/memoryProviders.test.tsx` and `src/hermes/memoryProviders.test.ts` cover those.
