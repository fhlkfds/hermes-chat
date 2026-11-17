// What the Screen puts on Hermes's Bot Desktop by itself (ADR 0193): a web browser, a terminal and a text editor, so
// they are in the screen's dock without the owner installing anything, and xclip, which reads the screen's clipboard
// for copying out of it (screenClipboard.ts). Hermes's launcher writes the dock once, with a launcher only for each
// program it finds then (tools/bot_desktop/launcher.sh at bf0203a), so after adding one of those the dock file is
// deleted while the screen is stopped, and the next start writes it again with the new apps.
//
// The browser is pm's Chromium, the one Hermes runs, installed by Hermes itself (`hermes pm install chromium` over
// `cli.exec`, no root). The terminal and the editor are distribution packages that need root, which Hermes can't
// install, so they go in through the connection's own ssh (src-tauri/src/screen_apps.rs).
import SCRIPT from "../../src-tauri/src/screen_apps.sh?raw";
import { browserOf, isUnavailable, type DisplayStatus, type ScreenApi } from "./screen";
import { errorText } from "./values";

export type ScreenAppId = "browser" | "terminal" | "editor" | "clipboard";

/** `inDock`: the launcher gives it a place in the dock, so adding it means writing the dock again. */
type ScreenApp = { id: ScreenAppId; name: string; inDock: boolean } & ({ install: "pm" } | { install: "system"; program: string });

export const SCREEN_APPS: readonly ScreenApp[] = [
  { id: "browser", name: "a web browser", inDock: true, install: "pm" },
  { id: "terminal", name: "a terminal", inDock: true, install: "system", program: "xfce4-terminal" },
  { id: "editor", name: "a text editor", inDock: true, install: "system", program: "mousepad" },
  { id: "clipboard", name: "xclip (for copying out)", inDock: false, install: "system", program: "xclip" },
];

const inDock = (ids: readonly ScreenAppId[]) => ids.filter((id) => SCREEN_APPS.find((a) => a.id === id)?.inDock);

const SYSTEM_APPS = SCREEN_APPS.flatMap((a) => (a.install === "system" ? [a] : []));
/** The packages screen_apps.sh installs, which are also the programs the launcher and the clipboard look for. */
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
  /**
   * The server couldn't be asked (a Hermes without `shell.exec`), so nothing is installed and nothing relies on it.
   * `carried`: a run cut off may have added it, so the dock is still owed once a check can tell.
   */
  | { kind: "unknown"; carried?: true }
  /** The owner put off the password: not now. */
  | { kind: "skipped" }
  | { kind: "added" }
  | { kind: "needs-password"; wrong: boolean }
  | { kind: "no-ssh"; command: string }
  | { kind: "failed"; why: string };

/**
 * The dock, once something was added. `current`: deleted while the screen was stopped, so its next start writes it
 * with the new apps. `restart`: the screen runs on a dock from before them; only the owner restarts it, since the agent
 * may be in the middle of something there. `pending`: on its way to one of those.
 */
export type Dock = { kind: "current" } | { kind: "restart" } | { kind: "pending" } | { kind: "failed"; why: string };

/**
 * Each app that was missing or can't be told, by id; one that was there has no entry. `carried`: what the run before
 * may have added without writing the dock again (`unfinished`).
 */
export type AppsSetup =
  | { kind: "unchecked" }
  | { kind: "checking"; carried: readonly ScreenAppId[] }
  | { kind: "checked"; apps: Partial<Record<ScreenAppId, AppState>>; dock: Dock };

/**
 * What a run cut off may have added since, so the next run writes the dock again for it: apps installing, or added
 * before the dock was written.
 */
export function unfinished(s: AppsSetup): readonly ScreenAppId[] {
  if (s.kind === "checking") return s.carried;
  if (s.kind === "unchecked") return [];
  const dockDone = s.dock.kind === "current" || s.dock.kind === "restart";
  return (Object.keys(s.apps) as ScreenAppId[]).filter((id) => {
    const app = s.apps[id];
    return app?.kind === "installing" || (app?.kind === "unknown" && app.carried) || (app?.kind === "added" && !dockDone);
  });
}

/** Whether the apps can go on this screen: Hermes's own on a Linux server, installed. One in the sandbox brings its own. */
export const canSetUp = (s: DisplayStatus) => s.supported && s.installed && !s.placement?.startsWith("terminal:");

export type SetupDeps = {
  api: ScreenApi;
  /** Undefined when the connection has no SSH target. */
  system: InstallSystem | undefined;
  update: (change: (s: AppsSetup) => AppsSetup) => void;
  /** Each `display.status` read along the way. */
  onStatus: (s: DisplayStatus) => void;
  /** False once the profile or the connection changed: `api` then answers for another screen. */
  alive: () => boolean;
};

/** `p`, while the run is alive. After that it never settles, so the run makes no more Hermes calls or updates. */
const whileAlive = <T>(deps: SetupDeps, p: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) =>
    p.then(
      (v) => deps.alive() && resolve(v),
      (e: unknown) => deps.alive() && reject(e),
    ),
  );

const withApps =
  (ids: readonly ScreenAppId[], state: AppState) =>
  (s: AppsSetup): AppsSetup =>
    s.kind === "checked" ? { ...s, apps: { ...s.apps, ...Object.fromEntries(ids.map((id) => [id, state])) } } : s;
const withDock =
  (dock: Dock) =>
  (s: AppsSetup): AppsSetup =>
    s.kind === "checked" ? { ...s, dock } : s;

/** The owner said not now. */
export const skip = (ids: readonly ScreenAppId[]) => withApps(ids, { kind: "skipped" });

/** The system apps whose program the server lacks, or undefined when it can't be told (a Hermes without `shell.exec`). */
async function missingSystemApps(deps: SetupDeps): Promise<ScreenAppId[] | undefined> {
  const found = await whileAlive(deps, deps.api.findPrograms(SYSTEM_PROGRAMS)).catch(() => undefined);
  return found && SYSTEM_APPS.filter((a) => !found.includes(a.program)).map((a) => a.id);
}

/**
 * Checks what is missing from the screen in `status` and adds it, browser and system apps at once. Those in `skipped`,
 * which the owner put off, stay put off. Those in `carried` that are there now were added, so the dock is written
 * again.
 */
export async function setUpApps(deps: SetupDeps, status: DisplayStatus, skipped: readonly ScreenAppId[] = [], carried: readonly ScreenAppId[] = []): Promise<void> {
  deps.update(() => ({ kind: "checking", carried }));
  const browser = browserOf(status).kind === "missing";
  const missing = await missingSystemApps(deps);
  const system = missing?.filter((id) => !skipped.includes(id));
  const landed = carried.filter((id) => (id === "browser" ? browserOf(status).kind === "found" : missing && !missing.includes(id)));
  const apps: Partial<Record<ScreenAppId, AppState>> = Object.fromEntries([
    ...(browser ? [["browser", { kind: "installing" }]] : []),
    ...(system ?? []).map((id) => [id, { kind: "installing" }]),
    ...(missing ?? []).filter((id) => skipped.includes(id)).map((id) => [id, { kind: "skipped" }]),
    ...(missing ? [] : SYSTEM_APPS.map((a) => [a.id, carried.includes(a.id) ? { kind: "unknown", carried: true } : { kind: "unknown" }])),
    ...landed.map((id) => [id, { kind: "added" }]),
  ]);
  deps.update(() => ({ kind: "checked", apps, dock: { kind: "current" } }));
  await Promise.all([browser && installBrowser(deps), (!!system?.length || inDock(landed).length > 0) && addSystem(deps, system ?? [], undefined, landed)]);
}

/** `hermes pm install chromium`, then whether Hermes now finds a browser for the profile. */
async function installBrowser(deps: SetupDeps): Promise<void> {
  let why: string | undefined;
  try {
    const r = await whileAlive(deps, deps.api.installBrowser());
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
    s = await whileAlive(deps, deps.api.status());
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
  if (password !== undefined) return addSystem(deps, ids, password);
  const still = (await missingSystemApps(deps)) ?? ids;
  const found = ids.filter((id) => !still.includes(id));
  if (found.length) deps.update(withApps(found, { kind: "added" }));
  await addSystem(deps, still.filter((id) => ids.includes(id)), undefined, found);
}

/** Installs `missing` over ssh, then lets the dock be written again if it gained an app, here or in `found`. */
async function addSystem(deps: SetupDeps, missing: readonly ScreenAppId[], password?: string, found: readonly ScreenAppId[] = []): Promise<void> {
  const added = missing.length ? await runSystem(deps, missing, password) : [];
  if (inDock([...found, ...added]).length) await refreshDockNow(deps);
}

/** The install over ssh, or the command to paste without it. Returns what it added. */
async function runSystem(deps: SetupDeps, missing: readonly ScreenAppId[], password?: string): Promise<readonly ScreenAppId[]> {
  if (!deps.system) {
    deps.update(withApps(missing, { kind: "no-ssh", command: pasteCommand() }));
    return [];
  }
  const outcome = await whileAlive(
    deps,
    deps.system(password).catch((e: unknown): SystemOutcome => ({ kind: "error", message: errorText(e) })),
  );
  const state = stateOf(outcome);
  deps.update(withApps(missing, state));
  return state.kind === "added" ? missing : [];
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
  deps.update(withDock({ kind: "pending" }));
  try {
    const s = await whileAlive(deps, deps.api.status());
    deps.onStatus(s);
    await refreshDock(deps, s);
  } catch (e) {
    deps.update(withDock({ kind: "failed", why: errorText(e) }));
  }
}

/** Deletes the dock while the screen is stopped; a running Xfce panel could write the old one back as it exits. */
async function refreshDock(deps: SetupDeps, s: DisplayStatus) {
  deps.update(withDock({ kind: "pending" }));
  if (s.running) return deps.update(withDock({ kind: "restart" }));
  try {
    await whileAlive(deps, deps.api.resetDock(s.profile_key));
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
