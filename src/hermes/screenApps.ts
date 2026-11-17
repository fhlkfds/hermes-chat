// What the Screen puts on Hermes's Bot Desktop by itself (ADR 0193): a web browser, a terminal and a text editor, so
// they are in the screen's dock without the owner installing anything. Hermes's launcher writes the dock once, with a
// launcher only for each program it finds then (tools/bot_desktop/launcher.sh at bf0203a), so after adding one the
// dock file is deleted while the screen is stopped, and the next start writes it again with the new apps.
//
// The browser is pm's Chromium, the one Hermes runs, installed by Hermes itself (`hermes pm install chromium` over
// `cli.exec`, no root). The terminal and the editor are distribution packages that need root, which Hermes can't
// install, so they go in through the connection's own ssh (src-tauri/src/screen_apps.rs).
import SCRIPT from "../../src-tauri/src/screen_apps.sh?raw";
import { browserOf, isUnavailable, type DisplayStatus, type ScreenApi } from "./screen";
import { errorText } from "./values";

export type ScreenAppId = "browser" | "terminal" | "editor";

type ScreenApp = { id: ScreenAppId; name: string } & ({ install: "pm" } | { install: "system"; program: string });

export const SCREEN_APPS: readonly ScreenApp[] = [
  { id: "browser", name: "a web browser", install: "pm" },
  { id: "terminal", name: "a terminal", install: "system", program: "xfce4-terminal" },
  { id: "editor", name: "a text editor", install: "system", program: "mousepad" },
];

const SYSTEM_APPS = SCREEN_APPS.flatMap((a) => (a.install === "system" ? [a] : []));
/** The packages screen_apps.sh installs, which are also the programs the launcher looks for. */
export const SYSTEM_PROGRAMS = SYSTEM_APPS.map((a) => a.program);

/** The apps named in prose, in the table's order: "a terminal and a text editor". */
export function namesOf(ids: readonly ScreenAppId[]): string {
  const names = SCREEN_APPS.filter((a) => ids.includes(a.id)).map((a) => a.name);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One `command -v` each: dash, Debian's `sh`, answers only for the first name given to one. */
export const checkCommand = (programs: readonly string[]) => programs.map((p) => `command -v ${p}`).join("; ");

/** The programs `checkCommand` found: it prints each one's path, or its bare name for a builtin or function. */
export function foundPrograms(stdout: string, programs: readonly string[]): string[] {
  const printed = new Set(stdout.split(/\r?\n/).map((line) => line.trim().split("/").at(-1)));
  return programs.filter((p) => printed.has(p));
}

/** The dock's layout file, under the profile's Hermes home (`profile_key`; runtime.py `HERMES_BD_CONFIG_HOME`). */
export const dockFile = (profileKey: string) => `${profileKey}/bot-desktop/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml`;

/** `s` as one word for a POSIX shell. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The install as the owner can paste it on the server: screen_apps.sh, one line, under sudo. */
export const pasteCommand = () =>
  `sudo sh -c '${SCRIPT.split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("; ")}'`;

/** How the install over ssh went (screen_apps.rs `Outcome`). */
export type SystemOutcome =
  | { kind: "installed" }
  | { kind: "needs-password" }
  | { kind: "wrong-password" }
  | { kind: "no-package-manager" }
  | { kind: "no-sudo" }
  | { kind: "failed"; output: string }
  | { kind: "error"; message: string };

/** Installs the terminal and the editor through the connection's ssh, with the owner's sudo password if given. */
export type InstallSystem = (password?: string) => Promise<SystemOutcome>;

export type AppState =
  | { kind: "installing" }
  | { kind: "added" }
  | { kind: "needs-password"; wrong: boolean }
  | { kind: "no-ssh"; command: string }
  | { kind: "failed"; why: string };

/**
 * The dock, once something was added. `current`: deleted while the screen was stopped, so its next start writes it
 * with the new apps. `restart`: the screen runs on a dock from before them; only the owner restarts it, since the agent
 * may be in the middle of something there.
 */
export type Dock = { kind: "current" } | { kind: "restart" } | { kind: "failed"; why: string };

/** Each app that was missing, by id; one that was there, or can't be told, has no entry. */
export type AppsSetup = { kind: "unchecked" } | { kind: "checking" } | { kind: "checked"; apps: Partial<Record<ScreenAppId, AppState>>; dock: Dock };

/** Whether the apps can go on this screen: Hermes's own on a Linux server, installed. One in the sandbox brings its own. */
export const canSetUp = (s: DisplayStatus) => s.supported && s.installed && !s.placement?.startsWith("terminal:");

export type SetupDeps = {
  api: ScreenApi;
  /** Undefined when the connection has no SSH target. */
  system: InstallSystem | undefined;
  update: (change: (s: AppsSetup) => AppsSetup) => void;
  /** Each `display.status` read along the way. */
  onStatus: (s: DisplayStatus) => void;
};

const withApps =
  (ids: readonly ScreenAppId[], state: AppState) =>
  (s: AppsSetup): AppsSetup =>
    s.kind === "checked" ? { ...s, apps: { ...s.apps, ...Object.fromEntries(ids.map((id) => [id, state])) } } : s;
const withDock =
  (dock: Dock) =>
  (s: AppsSetup): AppsSetup =>
    s.kind === "checked" ? { ...s, dock } : s;

/** Drops apps from the setup: the owner said not now. */
export const without =
  (ids: readonly ScreenAppId[]) =>
  (s: AppsSetup): AppsSetup =>
    s.kind === "checked" ? { ...s, apps: Object.fromEntries(Object.entries(s.apps).filter(([id]) => !ids.includes(id as ScreenAppId))) } : s;

/** The system apps whose program the server lacks. None when it can't be told (a Hermes without `shell.exec`). */
async function missingSystemApps(api: ScreenApi): Promise<ScreenAppId[]> {
  const found = await api.findPrograms(SYSTEM_PROGRAMS).catch(() => SYSTEM_PROGRAMS);
  return SYSTEM_APPS.filter((a) => !found.includes(a.program)).map((a) => a.id);
}

/** Checks what is missing from the screen in `status` and adds it, browser and system apps at once. */
export async function setUpApps(deps: SetupDeps, status: DisplayStatus): Promise<void> {
  deps.update(() => ({ kind: "checking" }));
  const browser = browserOf(status).kind === "missing";
  const system = await missingSystemApps(deps.api);
  const missing: ScreenAppId[] = [...(browser ? (["browser"] as const) : []), ...system];
  deps.update(() => ({ kind: "checked", apps: Object.fromEntries(missing.map((id) => [id, { kind: "installing" }])), dock: { kind: "current" } }));
  await Promise.all([browser && installBrowser(deps), system.length > 0 && runSystem(deps, system)]);
}

/** `hermes pm install chromium`, then whether Hermes now finds a browser for the profile. */
async function installBrowser(deps: SetupDeps): Promise<void> {
  let why: string | undefined;
  try {
    const r = await deps.api.installBrowser();
    if (r.blocked) why = r.hint || "Hermes wouldn't run it.";
    else if (r.code !== 0) why = lastLines(r.output) || `It ended with exit status ${r.code}.`;
  } catch (e) {
    why = isUnavailable(e) ? "This Hermes can't install it from the app." : errorText(e);
  }
  if (why) return deps.update(withApps(["browser"], { kind: "failed", why }));
  await recheckBrowser(deps, "Hermes installed Chromium, but still finds no browser for this profile.");
}

/** Reads `display.status` again: a browser Hermes now finds was added. Otherwise it stays failed, saying `why`. */
export async function recheckBrowser(deps: SetupDeps, why?: string): Promise<DisplayStatus | undefined> {
  let s: DisplayStatus;
  try {
    s = await deps.api.status();
  } catch (e) {
    deps.update(withApps(["browser"], { kind: "failed", why: errorText(e) }));
    return;
  }
  deps.onStatus(s);
  if (browserOf(s).kind === "found") {
    deps.update(withApps(["browser"], { kind: "added" }));
    await refreshDock(deps, s);
  } else if (why) deps.update(withApps(["browser"], { kind: "failed", why }));
  return s;
}

/**
 * Installs the terminal and the editor (`ids`) over ssh. With no password, it first checks the server again: what the
 * owner installed by hand since counts as added, and only what is still missing is installed.
 */
export async function installSystem(deps: SetupDeps, ids: readonly ScreenAppId[], password?: string): Promise<void> {
  deps.update(withApps(ids, { kind: "installing" }));
  let missing = ids;
  if (password === undefined) {
    const still = await missingSystemApps(deps.api);
    const found = ids.filter((id) => !still.includes(id));
    missing = ids.filter((id) => still.includes(id));
    if (found.length) {
      deps.update(withApps(found, { kind: "added" }));
      if (!missing.length) return refreshDockNow(deps);
    }
  }
  await runSystem(deps, missing, password);
}

async function runSystem(deps: SetupDeps, missing: readonly ScreenAppId[], password?: string): Promise<void> {
  if (!deps.system) return deps.update(withApps(missing, { kind: "no-ssh", command: pasteCommand() }));
  const outcome = await deps.system(password).catch((e: unknown): SystemOutcome => ({ kind: "error", message: errorText(e) }));
  const state = stateOf(outcome);
  deps.update(withApps(missing, state));
  if (state.kind === "added") await refreshDockNow(deps);
}

function stateOf(o: SystemOutcome): AppState {
  switch (o.kind) {
    case "installed":
      return { kind: "added" };
    case "needs-password":
      return { kind: "needs-password", wrong: false };
    case "wrong-password":
      return { kind: "needs-password", wrong: true };
    case "no-package-manager":
      return { kind: "failed", why: "The server has no apt-get, dnf or pacman to install them with." };
    case "no-sudo":
      return { kind: "failed", why: "The server has no sudo. Sign in over SSH as root, or install sudo there." };
    case "failed":
      return { kind: "failed", why: o.output || "The package manager failed." };
    case "error":
      return { kind: "failed", why: o.message };
  }
}

async function refreshDockNow(deps: SetupDeps) {
  try {
    const s = await deps.api.status();
    deps.onStatus(s);
    await refreshDock(deps, s);
  } catch (e) {
    deps.update(withDock({ kind: "failed", why: errorText(e) }));
  }
}

/** Deletes the dock while the screen is stopped; a running Xfce panel could write the old one back as it exits. */
async function refreshDock(deps: SetupDeps, s: DisplayStatus) {
  if (s.running) return deps.update(withDock({ kind: "restart" }));
  try {
    await deps.api.resetDock(s.profile_key);
    deps.update(withDock({ kind: "current" }));
  } catch (e) {
    deps.update(withDock({ kind: "failed", why: isUnavailable(e) ? "this Hermes can't change it from here." : errorText(e) }));
  }
}

function lastLines(text: string, n = 8): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n");
}
