// The apps the Screen adds to Hermes's Bot Desktop (screenApps.ts, ADR 0193): reading what the server has, and the
// setup against FakeHermes's `display.*`, `cli.exec` and `shell.exec`, with a stand-in for the install over ssh.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import {
  SYSTEM_PROGRAMS,
  checkCommand,
  dockFile,
  foundPrograms,
  installSystem,
  namesOf,
  pasteCommand,
  setUpApps,
  shellQuote,
  type AppsSetup,
  type InstallSystem,
  type SetupDeps,
  type SystemOutcome,
} from "./screenApps";
import { connect } from "./transport";

const HOME = "/home/liam/.hermes";
const DOCK = dockFile(HOME);
/** Hermes's one Chromium profile for the screen (tools/bot_desktop/browser.py `profile_dir`), where sign-ins last. */
const PROFILE = `${HOME}/bot-desktop/browser-profile`;

describe("What the server has", () => {
  it.each([
    ["both, as paths", "/usr/bin/xfce4-terminal\n/usr/bin/mousepad\n", ["xfce4-terminal", "mousepad"]],
    ["one", "/usr/bin/mousepad\n", ["mousepad"]],
    ["none", "", []],
    ["a builtin or function, by its bare name", "xfce4-terminal\n", ["xfce4-terminal"]],
    ["a program whose name only ends the same", "/usr/bin/not-mousepad\n", []],
    ["CRLF lines", "/usr/local/bin/xfce4-terminal\r\n", ["xfce4-terminal"]],
  ])("reads %s from what command -v printed", (_, stdout, found) => {
    expect(foundPrograms(stdout, SYSTEM_PROGRAMS)).toEqual(found);
  });

  it("asks with one command -v each, since dash answers only for the first name it is given", () => {
    expect(checkCommand(SYSTEM_PROGRAMS)).toBe("command -v xfce4-terminal; command -v mousepad; command -v xclip");
  });

  it("names the dock's layout file under the profile's Hermes home, quoted for the shell", () => {
    expect(DOCK).toBe("/home/liam/.hermes/bot-desktop/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml");
    expect(shellQuote("/home/o'neil/.hermes")).toBe(`'/home/o'\\''neil/.hermes'`);
    expect(execFileSync("sh", ["-c", `printf %s ${shellQuote("/a b/o'neil $HOME")}`], { encoding: "utf8" })).toBe("/a b/o'neil $HOME");
  });

  it("names the apps in prose", () => {
    expect(namesOf(["editor", "browser", "terminal"])).toBe("a web browser, a terminal and a text editor");
    expect(namesOf(["editor", "terminal"])).toBe("a terminal and a text editor");
    expect(namesOf(["editor"])).toBe("a text editor");
  });

  it("gives the owner the same install Rust runs over ssh, as one line that sh reads", () => {
    const script = readFileSync(join(__dirname, "../../src-tauri/src/screen_apps.sh"), "utf8");
    expect(script).toContain(`pkgs="${SYSTEM_PROGRAMS.join(" ")}"`);
    const paste = pasteCommand();
    expect(paste).not.toContain("\n");
    const inner = /^sudo sh -c '(.*)'$/.exec(paste)![1];
    for (const line of script.split("\n").filter((l) => l.trim())) expect(inner).toContain(line.trim());
    execFileSync("sh", ["-n", "-c", inner]);
  });
});

/**
 * A Hermes whose screen and machine lack all three apps, but have xclip, with the dock written before they were
 * installed, and the browser's profile with the owner's sign-ins beside it.
 */
function server({ running = false } = {}) {
  const s = new FakeHermes();
  s.display = { status: { supported: true, installed: true, missing: [], running, placement: "gateway", browser: null }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  s.machine = {
    programs: new Set(["xclip"]),
    files: new Set([DOCK, PROFILE]),
    pmInstall: { code: 0, output: "Installed chromium 141" },
    browser: `${HOME}/pm/chromium/chrome`,
  };
  return s;
}

/** Runs the setup and keeps the state it ends in. `system`: the install over ssh, recording each password given. */
async function setUp(s: FakeHermes, outcomes: (password?: string) => SystemOutcome, ssh = true) {
  const hermes = await connect(s.openPipe);
  const passwords: (string | undefined)[] = [];
  const system: InstallSystem = async (password) => {
    passwords.push(password);
    const o = outcomes(password);
    if (o.kind === "installed") for (const p of SYSTEM_PROGRAMS) s.machine!.programs.add(p);
    return o;
  };
  let state: AppsSetup = { kind: "unchecked" };
  const deps: SetupDeps = { api: hermes.screen, system: ssh ? system : undefined, update: (f) => (state = f(state)), onStatus: () => {}, alive: () => true };
  await setUpApps(deps, await hermes.screen.status());
  return { deps, passwords, state: () => state, asked: (method: string) => s.requests.filter((r) => r.method === method).map((r) => r.params) };
}

const sudoWith =
  (password: string): ((given?: string) => SystemOutcome) =>
  (given) =>
    given === undefined ? { kind: "needs-password" } : given === password ? { kind: "installed" } : { kind: "wrong-password" };

describe("Adding the apps", () => {
  it("installs all three with no password when ssh signs in as root or sudo needs none, then lets the next start write the dock", async () => {
    const s = server();
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.state()).toEqual({ kind: "checked", apps: { browser: { kind: "added" }, terminal: { kind: "added" }, editor: { kind: "added" } }, dock: { kind: "current" } });
    expect(run.passwords).toEqual([undefined]);
    expect(run.asked("cli.exec")).toEqual([{ argv: ["pm", "install", "chromium"], timeout: 600 }]);
    expect(run.asked("shell.exec")).toContainEqual({ command: "command -v xfce4-terminal; command -v mousepad; command -v xclip" });
    expect(run.asked("shell.exec")).toContainEqual({ command: `rm -f -- '${DOCK}'` });
    expect(s.machine!.files.has(DOCK)).toBe(false);
    expect(run.asked("display.stop")).toEqual([]);
  });

  it("asks for the sudo password, says when it was wrong, and installs with the right one", async () => {
    const s = server();
    const run = await setUp(s, sudoWith("hunter2"));
    const apps = () => (run.state() as Extract<AppsSetup, { kind: "checked" }>).apps;
    expect(apps()).toEqual({ browser: { kind: "added" }, terminal: { kind: "needs-password", wrong: false }, editor: { kind: "needs-password", wrong: false } });
    await installSystem(run.deps, ["terminal", "editor"], "hunter3");
    expect(apps().terminal).toEqual({ kind: "needs-password", wrong: true });
    await installSystem(run.deps, ["terminal", "editor"], "hunter2");
    expect(apps()).toEqual({ browser: { kind: "added" }, terminal: { kind: "added" }, editor: { kind: "added" } });
    expect(run.passwords).toEqual([undefined, "hunter3", "hunter2"]);
    // The password goes to the install over ssh only, never to Hermes.
    expect(JSON.stringify(s.requests)).not.toContain("hunter");
  });

  it("gives the command to paste when the connection has no SSH target, and adds what the owner installed by hand", async () => {
    const s = server();
    const run = await setUp(s, () => ({ kind: "installed" }), false);
    expect(run.state()).toMatchObject({ apps: { terminal: { kind: "no-ssh", command: pasteCommand() }, editor: { kind: "no-ssh" } } });
    s.machine!.files.add(DOCK);
    s.machine!.programs.add("xfce4-terminal").add("mousepad");
    await installSystem(run.deps, ["terminal", "editor"]);
    expect(run.state()).toMatchObject({ apps: { terminal: { kind: "added" }, editor: { kind: "added" } }, dock: { kind: "current" } });
    expect(s.machine!.files.has(DOCK)).toBe(false);
  });

  it("says why the browser couldn't be installed, so the Screen falls back to the command", async () => {
    const s = server();
    s.machine!.pmInstall = { code: 1, output: "Resolving chromium...\nerror: no Chromium build for linux-riscv64" };
    s.machine!.programs.add("xfce4-terminal").add("mousepad");
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.state()).toEqual({ kind: "checked", apps: { browser: { kind: "failed", why: "Resolving chromium...\nerror: no Chromium build for linux-riscv64" } }, dock: { kind: "current" } });
    expect(run.passwords).toEqual([]);
    expect(s.machine!.files.has(DOCK)).toBe(true);
  });

  it("says why the package manager failed", async () => {
    const run = await setUp(server(), () => ({ kind: "failed", output: "E: Unable to locate package mousepad" }));
    expect(run.state()).toMatchObject({ apps: { terminal: { kind: "failed", why: "E: Unable to locate package mousepad" } } });
  });

  it("leaves a running screen's dock alone, for the owner to restart", async () => {
    const s = server({ running: true });
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.state()).toMatchObject({ dock: { kind: "restart" } });
    expect(s.machine!.files.has(DOCK)).toBe(true);
    expect(run.asked("shell.exec").some((p) => String(p.command).startsWith("rm"))).toBe(false);
  });

  it("skips the terminal, the editor and xclip quietly on a Hermes without shell.exec, and doesn't count on them", async () => {
    const s = server();
    s.machine = undefined;
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.passwords).toEqual([]);
    expect(run.state()).toEqual({
      kind: "checked",
      apps: { browser: { kind: "failed", why: "This Hermes can't install it from the app." }, terminal: { kind: "unknown" }, editor: { kind: "unknown" }, clipboard: { kind: "unknown" } },
      dock: { kind: "current" },
    });
  });

  it("adds xclip alone without writing the dock again, since it has no place there", async () => {
    const s = server({ running: true });
    s.display!.status.browser = "/usr/bin/chromium";
    s.machine!.programs = new Set(["xfce4-terminal", "mousepad"]);
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.state()).toEqual({ kind: "checked", apps: { clipboard: { kind: "added" } }, dock: { kind: "current" } });
    expect(s.machine!.files.has(DOCK)).toBe(true);
    expect(run.asked("display.status")).toHaveLength(1);
  });

  it("deletes only the dock's layout, never the browser's profile with the owner's sign-ins", async () => {
    const s = server();
    const run = await setUp(s, () => ({ kind: "installed" }));
    await run.deps.api.resetDock(String((await run.deps.api.status()).profile_key));
    const deleted = run.asked("shell.exec").filter((p) => String(p.command).startsWith("rm"));
    expect(deleted.length).toBeGreaterThan(1);
    expect(new Set(deleted.map((p) => p.command))).toEqual(new Set([`rm -f -- '${DOCK}'`]));
    expect(JSON.stringify(run.asked("shell.exec"))).not.toContain("browser-profile");
    expect(s.machine!.files).toEqual(new Set([PROFILE]));
  });

  it("leaves what the owner put off alone when it runs again", async () => {
    const s = server();
    s.display!.status.browser = "/usr/bin/chromium";
    const run = await setUp(s, () => ({ kind: "needs-password" }));
    await setUpApps(run.deps, await run.deps.api.status(), ["terminal", "editor"]);
    expect(run.state()).toEqual({ kind: "checked", apps: { terminal: { kind: "skipped" }, editor: { kind: "skipped" } }, dock: { kind: "current" } });
    expect(run.passwords).toEqual([undefined]);
  });

  it("does nothing when all three are there", async () => {
    const s = server();
    s.display!.status.browser = "/usr/bin/chromium";
    s.machine!.programs.add("xfce4-terminal").add("mousepad");
    const run = await setUp(s, () => ({ kind: "installed" }));
    expect(run.state()).toEqual({ kind: "checked", apps: {}, dock: { kind: "current" } });
    expect(run.asked("cli.exec")).toEqual([]);
  });
});
