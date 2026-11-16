# Highwing developer guide

This guide is for engineers who build, test, or change Highwing. It lists the setup, commands, and configuration, then explains the main design choices. To learn to use the app, read the [README](../README.md). For what each feature does, read the [feature guide](features.md).

Highwing is a Tauri 2 desktop app. The frontend is React 19 and TypeScript, built with Vite and tested with Vitest. The backend is Rust. On Linux the window is WebKitGTK (`webkit2gtk-4.1`), and on Windows it is WebView2. The npm package, the binary, and the data folders keep the old name `hermes-chat` ([ADR 0176](adr/0176-the-app-is-called-highwing-and-its-icon-is-an-eagles-head.md)).

## Setup

### Requirements

| Tool | Version |
| --- | --- |
| Node.js | 22, as CI uses |
| npm | the one that ships with Node.js 22 |
| Rust | stable |
| WebKitGTK | `webkit2gtk-4.1` |

System packages on Arch Linux:

```sh
sudo pacman -S --needed rust nodejs npm webkit2gtk-4.1 base-devel curl wget file openssl \
	appmenu-gtk-module libappindicator-gtk3 librsvg openssh
```

System packages on Ubuntu 24.04, as `.github/workflows/ci.yml` installs them:

```sh
sudo apt-get install -y --no-install-recommends \
	pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libdbus-1-dev xvfb
```

### First run

From the repository root:

```sh
npm ci
git config core.hooksPath .githooks
npm run app
```

`npm ci` installs the versions in `package-lock.json`. The `git config` line turns on `.githooks/pre-commit` for this clone and all of its worktrees. The hook refuses a commit that stages Rust when `cargo fmt --check` fails. `npm run app` starts Vite on port 1420 and opens the app with hot reload.

The app needs a Hermes Agent server with its dashboard running. [`compatibility.md`](compatibility.md) lists what each feature needs from the server and which Hermes versions were checked. The tests don't need a server: they run against `FakeHermes`.

## Commands

### npm scripts

| Command | What it does |
| --- | --- |
| `npm run app` | Runs `tauri dev` with `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `HERMES_CHAT_NEW_INSTANCE=1`. |
| `npm run dev` | Runs only the Vite dev server on port 1420. The page can't reach Hermes outside the Tauri window. |
| `npm run build` | Type-checks all three `tsconfig` files, runs `oxlint --deny-warnings`, and builds the frontend into `dist/`. |
| `npm run lint` | Runs `oxlint --deny-warnings`. |
| `npm test` | Runs every Vitest test once, in jsdom, against `FakeHermes`. CI uses this. |
| `npm run test:local` | Runs the same tests with two workers, so a full run doesn't time out on a loaded machine. |
| `npm run e2e` | Runs each feature end to end in headless Chromium against `FakeHermes`. Writes screenshots and `e2e/out/summary.json`. See [`e2e.md`](e2e.md). |
| `npm run check` | Runs the checks that most often fail a PR: `scripts/check-adrs.mjs`, `cargo fmt --check`, `npm run build`, `npm run test:local`, and `cargo clippy --all-targets -- -D warnings`. |
| `npm run bump -- <level>` | Raises the version to the next `patch`, `minor`, or `major` in every version file. See [`releases.md`](releases.md). |
| `npm run tauri -- build --no-bundle` | Builds the release binary `src-tauri/target/release/hermes-chat`. |

If one test file times out under load, run it alone with `npx vitest run <file> --maxWorkers=1`.

### Rust

Run these in `src-tauri/`. `tauri::generate_context!` needs `dist/` to exist at compile time, so run `npm run build` or `mkdir -p ../dist` first.

| Command | What it does |
| --- | --- |
| `cargo test --lib --tests` | Runs the library's unit tests and every file in `tests/`. |
| `xvfb-run -a cargo test --test clipboard -- --ignored` | Runs the clipboard tests on a display of their own. |
| `xvfb-run -a cargo test --test selection -- --ignored` | Runs the selection tests on a display of their own. |
| `xvfb-run -a dbus-run-session -- cargo test --lib -- --ignored --exact <test>` | Runs one ignored `page_view` test. Each needs its own process, display, and session bus. |
| `cargo clippy --all-targets -- -D warnings` | Lints. CI fails on any warning. |
| `cargo fmt --check` | Checks formatting against `rustfmt.toml`. |

### Other tools

| Command | What it does |
| --- | --- |
| `node scripts/check-adrs.mjs` | Fails when two ADRs share a number, and prints the highest number in use. |
| `node scripts/screenshot-refs.mjs` | Lists every file under `docs/screenshots/` that nothing references. `--delete` removes them. |
| `node bench/run.mjs` | Times long chats (50, 200, and 800 turns) in headless Chromium. `node bench/run.mjs code` times streaming code blocks. Needs `$CHROME` or Playwright's cached headless shell. |
| `xvfb-run -a python3 bench/webkit.py 'bench.streamCode(10,false)'` | Runs `window.bench` calls in WebKitGTK 4.1 and prints each result as JSON. Build the page first with `npx vite build --config bench/vite.config.ts`. Needs `python-gobject`. |
| `HERMES_HOME=$(mktemp -d) <hermes venv>/bin/python tools/cron-golden.py <hermes checkout>` | Regenerates `src/hermes/cronGolden.json`, which `schedule.test.ts` checks the schedule preview against. |
| `ruff check .` | Lints the repo's Python against `ruff.toml`. CI runs it, and `npm run check` doesn't. |

## Configuration

### Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | WebKitGTK | Prevents a blank window on some Wayland setups. The desktop launcher and `npm run app` set it. |
| `HERMES_CHAT_NEW_INSTANCE=1` | `src-tauri/src/remote.rs` | Starts this copy beside a running one instead of bringing that one forward. `npm run app` and an update's restart set it. |
| `HTTP_PROXY`, `HTTPS_PROXY` | Rust HTTP client | Apply to dashboard HTTP requests. The WebSocket ignores them and connects directly. |
| `HERMES_LIVE_DASHBOARD`, `HERMES_LIVE_USER`, `HERMES_LIVE_PASSWORD` | `src/hermes/*.live.test.ts` | Run the live tests against a real dashboard. Without `HERMES_LIVE_DASHBOARD`, those tests skip. Each file's header lists the other variables it reads. |
| `CHROME` | `bench/run.mjs` | Path to the Chromium binary for benchmarks. |
| `THROTTLE` | `bench/run.mjs` | Slows the CPU by this factor. |

### Files

| File | Holds |
| --- | --- |
| `src-tauri/tauri.conf.json` | Product name `Highwing`, identifier `net.l0cky12.hermes-chat`, version, `devUrl` `http://localhost:1420`, and `frontendDist` `../dist`. |
| `src-tauri/tauri.release.conf.json` | Release-build overrides: the AppImage bundle and the updater. See [`releases.md`](releases.md). |
| `src-tauri/tauri.windows.conf.json` | Overrides for the Windows build. |
| `src-tauri/capabilities/` | The Tauri permissions the webview has. |
| `vite.config.ts` | The dev server (port 1420, `127.0.0.1`, `strictPort`) and the Vitest timeout (20 s). |
| `e2e/vitest.config.ts` | The end-to-end suite's Vitest browser-mode setup. |
| `packaging/aur/PKGBUILD` | The `hermes-chat-git` Arch package. Build it with `packaging/aur/build.sh`, never with `makepkg` in place. |

### Where the app keeps data

| Data | Location |
| --- | --- |
| Passwords, tokens, and extra request headers | System keyring, service `hermes-chat` |
| Webview local storage | `$XDG_DATA_HOME/net.l0cky12.hermes-chat/localstorage/` |
| Project defaults, restart drafts, and recovery backups | `$XDG_DATA_HOME/net.l0cky12.hermes-chat/` |
| The Close to tray setting | `$XDG_CONFIG_HOME/net.l0cky12.hermes-chat/window.json` |
| Screenshots waiting to send | `$XDG_CACHE_HOME/hermes-chat/captures/` |

The feature guide's [What is stored where](features.md#what-is-stored-where) lists every item and what removes it.

### Command-line arguments

| Argument | Effect |
| --- | --- |
| `--show` | Brings the running window forward. |
| `--toggle` | Brings the running window forward, or hides it when it is already in front. |
| `--screenshot` | Takes a screenshot and attaches it to the chat on screen. |
| `hermes-chat://chat?…` | Opens that chat link. |

Only one copy runs at a time. A second launch hands its arguments to the running copy and exits. On Linux it uses the session bus name `net.l0cky12.HermesChat`. On Windows it uses a named pipe (`src-tauri/src/remote/pipe.rs`). With none of these arguments, it starts the app, or brings the running copy forward.

## Repository layout

```text
src/
	App.tsx          the app's top-level component and state
	hermes/          protocol, data, and logic, with no React; FakeHermes and the *.test.ts files live here
	ui/              React components and their *.test.tsx files
	i18n/            the interface text catalogue (en.ts, es.ts)
	extensions/      bundled extensions (chat-stats)
src-tauri/
	src/lib.rs       Tauri setup and the commands the webview can call
	src/transport.rs the dashboard connection: sign-in, REST relay, and the /api/ws WebSocket
	src/tunnel.rs    the SSH tunnel
	src/*.rs         one file per native feature: keyring, tray, screenshots, updates, and others
	tests/           Rust integration tests
e2e/               the end-to-end suite (features/<name>.e2e.tsx)
bench/             performance benchmarks
tools/             golden-file generators and live-test helpers, mostly Python
scripts/           repo checks and release scripts
packaging/aur/     the Arch package
docs/adr/          architecture decision records
```

## CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`:

| Job | Runs |
| --- | --- |
| `frontend` | `check-adrs.mjs`, `npm ci`, `npm test` (twice), `npm audit --audit-level=high`, `npm run build`, and the release script tests |
| `e2e` | `npm run e2e`, and uploads `e2e/out` |
| `rust` | `cargo test --lib --tests`, the display tests under `xvfb-run`, `cargo clippy`, and `cargo fmt --check` |
| `python` | `ruff check .` |
| `audit` | `cargo audit` |

`installers.yml` builds the Windows `.exe` and the `.deb` when a `v<version>` tag is pushed, and attaches both to that tag's GitHub release. [`releases.md`](releases.md) covers versions, tags, and signing.

## Pull requests

- Run `npm run check` before each commit. A failing check blocks the PR.
- Record a design decision as a new file in `docs/adr/`, with the next free number. `check-adrs.mjs` prints it.
- Attach screenshots for any UI change.
- Link the issue with `Fixes #N`.
- Only a human merges to `main`.

Terms the code and docs use, such as Active, Settled, Approval, and Saved copy, are defined in [`GLOSSARY.md`](../GLOSSARY.md).

## Design choices

These are the decisions that shape most of the code. Each links to the ADR that records it in full.

### Rust does all the network traffic

The webview never opens a connection to Hermes. Rust opens the SSH tunnel, signs in, keeps the cookies, relays the webview's REST calls, and carries the `/api/ws` JSON-RPC frames in both directions ([ADR 0003](adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md)). The frontend sees that traffic only through one interface, the pipe in `src/hermes/pipe.ts`. In the app the pipe is `tauriPipe.ts`. In tests it is `FakeHermes`.

This costs a hop for every request, and in return it settles three problems at once. Passwords, tokens, and gateway headers stay in Rust, so a script running in the webview can't read them ([ADR 0058](adr/0058-sign-in-methods-are-what-hermes-advertises-and-their-secrets-stay-in-rust.md)). The dashboard's CORS and `Origin` checks never apply, because the requests don't come from a browser page. And every frontend test runs against a fake server through the same interface the real app uses, with no network at all. That last point is why the suite can drive the whole app in jsdom.

### Hermes is the source of truth

What Hermes can store, Hermes stores: chats, titles, archive state, projects, scheduled jobs, memory, skills, and settings. The app keeps on this computer only what Hermes has no place for yet, such as drafts, queued messages, project defaults, and tags ([ADR 0017](adr/0017-project-defaults-are-local-and-sent-when-a-chat-starts.md), [ADR 0018](adr/0018-queued-messages-are-kept-and-sent-by-this-app.md), [ADR 0106](adr/0106-tags-and-saved-filters-are-local-and-filters-check-what-hermes-answered.md)). Each of those ADRs says what Hermes would need before the data could move there.

### A change counts once Hermes reads it back

Several clients edit the same server: Highwing, the Hermes CLI, the official desktop app, and messaging gateways. So the app doesn't trust its own write. It reads the value back, and shows the change as saved only when Hermes has it ([ADR 0005](adr/0005-archive-is-hermess-archived-flag-confirmed-by-read-back.md), [ADR 0014](adr/0014-persona-saves-check-hermes-first-and-read-back.md)). Where Hermes offers a revision, the app checks it before writing, and refuses to overwrite a change it hasn't shown you. When a send's outcome is unknown, for example because the connection dropped, the app reads the chat's history to settle it and never resends on its own ([ADR 0006](adr/0006-a-send-whose-outcome-is-unknown-is-settled-by-reading-history-back.md)).

The extra round trip is cheap next to the alternative, which is a screen that says "saved" while Hermes holds something else.

### Features are checked, not guessed from a version

Hermes servers differ by commit, and a version number doesn't say which routes a server has. The app learns what a server supports from what Hermes says about itself and from one read-only request per feature ([ADR 0044](adr/0044-capabilities-are-what-hermes-says-or-answers-checked-only-by-reading.md)). A screen whose feature is missing shows a note in its place, and the app sends no change for that feature. Settings → Diagnostics shows the results.

### Only the legacy session protocol

Hermes has two protocol generations. The app speaks the legacy one, which the dashboard serves. If `gateway.ready` reports `session_authority`, the app stops instead of mixing the two ([ADR 0003](adr/0003-sign-in-through-ssh-tunnel-to-the-dashboard.md)).

### Untrusted content runs in a sandbox

Web pages, HTML files, and tool output in the preview pane load in sandboxed frames or a separate view ([ADR 0007](adr/0007-preview-pane-shows-untrusted-content-in-sandboxed-frames.md)). Extensions run in a worker behind a sandboxed frame, and reach the app only through calls the owner granted ([ADR 0126](adr/0126-an-extension-runs-in-a-worker-behind-a-sandboxed-frame-and-reaches-the-app-only-through-granted-calls.md)).

### Decisions are written down

Every design decision gets an ADR in `docs/adr/`, numbered in order. The ADR says what was decided, the options that lost, and the gaps left open. Read the ADR before you change a feature: it often names the constraint that makes the obvious change wrong.

## Related documents

- [`compatibility.md`](compatibility.md): what each feature needs from the Hermes server.
- [`research/hermes-gateway-api.md`](research/hermes-gateway-api.md): the Hermes API the app relies on.
- [`e2e.md`](e2e.md): the end-to-end suite.
- [`releases.md`](releases.md): versions, tags, installers, and signing.
- [`features.md`](features.md): every feature, in detail.
