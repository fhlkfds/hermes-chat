// @vitest-environment jsdom
// The side panel's Screen (Screen.tsx, ADR 0039) against a fake of Hermes's `display.*` and a stand-in for noVNC, which
// jsdom can't draw: what it says for each state of the screen, watching, taking over and handing back, another viewer
// taking over, and letting go of the stream when it goes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenTab, type RfbClient, type RfbConstructor } from "./Screen";
import { BROWSER_FIX, viewerHash, type CliResult, type DisplayLease, type DisplayObserve, type DisplayStatus, type ScreenApi } from "../hermes/screen";
import { pasteCommand, type InstallSystem, type SystemOutcome } from "../hermes/screenApps";

afterEach(cleanup);

class FakeRfb implements RfbClient {
  static made: FakeRfb[] = [];
  viewOnly = false;
  scaleViewport = false;
  resizeSession = true;
  focusOnClick = false;
  background = "";
  qualityLevel = 6;
  disconnected = false;
  private handlers: Record<string, ((e: { detail?: { clean?: boolean } }) => void)[]> = {};
  constructor(
    readonly target: HTMLElement,
    readonly channel: unknown,
  ) {
    FakeRfb.made.push(this);
  }
  addEventListener(type: string, h: (e: { detail?: { clean?: boolean } }) => void) {
    (this.handlers[type] ??= []).push(h);
  }
  fire(type: string, detail?: { clean?: boolean }) {
    for (const h of this.handlers[type] ?? []) h({ detail });
  }
  disconnect() {
    this.disconnected = true;
  }
  focus() {}
}

const agent: DisplayLease = { holder: "agent", viewer_hash: null, since: 1, epoch: 0 };

class FakeScreen implements ScreenApi {
  state: DisplayStatus = { supported: true, installed: true, missing: [], running: false, geometry: "1440x900", lease: agent, profile_key: "/home/liam/.hermes" };
  observed: (string | undefined)[] = [];
  closes: ((code: number, reason: string) => void)[] = [];
  sockets = 0;
  leaseListener?: (key: string, l: DisplayLease) => void;
  missing = false;
  status = async () => {
    if (this.missing) throw Object.assign(new Error("unknown method: display.status"), { code: -32601 });
    return this.state;
  };
  start = async () => {
    this.calls.push("start");
    return (this.state = { ...this.state, running: true });
  };
  /** What the Screen asked of Hermes's side of the apps (screenApps.ts), in order. */
  calls: string[] = [];
  programs = new Set(["xfce4-terminal", "mousepad"]);
  pm: CliResult = { blocked: false, code: 0, output: "Installed chromium" };
  stop = async () => {
    this.calls.push("stop");
    if (this.state.lease.holder === "human") throw new Error("a human holds this screen; pass force: true to stop it anyway");
    return (this.state = { ...this.state, running: false });
  };
  installBrowser = async () => {
    this.calls.push("installBrowser");
    if (this.pm.code === 0) this.state = { ...this.state, browser: "/home/liam/.hermes/pm/chromium/chrome" };
    return this.pm;
  };
  findPrograms = async (names: readonly string[]) => names.filter((n) => this.programs.has(n));
  resetDock = async (key: string) => void this.calls.push(`resetDock ${key}`);
  observe = async (viewerId?: string): Promise<DisplayObserve> => {
    this.observed.push(viewerId);
    return { ...this.state, ticket: `t${this.observed.length}`, viewer_id: viewerId ?? "viewer-1" };
  };
  takeOver = async (id: string) => (this.state.lease = { holder: "human", viewer_hash: await viewerHash(id), since: 2, epoch: this.state.lease.epoch + 1 });
  handBack = async () => (this.state.lease = { ...agent, epoch: this.state.lease.epoch + 1 });
  held: (string | undefined)[] = [];
  noteHeld = (id: string | undefined) => void this.held.push(id);
  onLease = (l: (key: string, lease: DisplayLease) => void) => {
    this.leaseListener = l;
    return () => {};
  };
  openSocket = async (_t: string, _d: (b: ArrayBuffer) => void, c: (code: number, reason: string) => void) => {
    this.sockets++;
    this.closes.push(c);
    return { send() {}, close() {} };
  };
}

function show(api = new FakeScreen()) {
  FakeRfb.made = [];
  const load = async () => FakeRfb as unknown as RfbConstructor;
  const r = render(<ScreenTab api={api} shown connected loadRfb={load} />);
  return { api, ...r };
}

/** Lets the attach finish and noVNC say it connected. */
async function connected() {
  await waitFor(() => expect(FakeRfb.made.length).toBeGreaterThan(0));
  await act(async () => new Promise((d) => setTimeout(d, 0)));
  act(() => FakeRfb.made.at(-1)!.fire("connect"));
}

describe("The Screen tab", () => {
  it("says so when this Hermes has no screen", async () => {
    const api = new FakeScreen();
    api.missing = true;
    show(api);
    expect(await screen.findByText("This Hermes has no screen")).toBeTruthy();
  });

  it("says what is missing on the server, and the command that installs it", async () => {
    const api = new FakeScreen();
    api.state = { ...api.state, installed: false, missing: ["Xvnc", "xfwm4"], install_command: "sudo pacman -S --needed tigervnc xfwm4" };
    show(api);
    expect(await screen.findByText("The screen isn't installed on the server")).toBeTruthy();
    expect(screen.getByText("Xvnc, xfwm4")).toBeTruthy();
    expect(screen.getByText("sudo pacman -S --needed tigervnc xfwm4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start the screen/ })).toBeNull();
  });

  it("starts a stopped screen and watches it, without sending the owner's keys or pointer", async () => {
    const { api } = show();
    fireEvent.click(await screen.findByRole("button", { name: /Start the screen/ }));
    await connected();
    expect(api.observed).toEqual([undefined]);
    const rfb = FakeRfb.made[0];
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.resizeSession).toBe(false);
    expect(screen.getByText("Watching: Hermes is in control.")).toBeTruthy();
  });

  it("takes over and hands back, and only then sends keys and pointer", async () => {
    const api = new FakeScreen();
    api.state.running = true;
    const onHeld = vi.fn();
    FakeRfb.made = [];
    render(<ScreenTab api={api} shown connected loadRfb={async () => FakeRfb as unknown as RfbConstructor} onHeld={onHeld} />);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: /Take over/ }));
    await screen.findByText(/You're in control/);
    // viewOnly, onHeld and noteHeld follow `held` in effects, which can run a tick after the text shows.
    await waitFor(() => {
      expect(onHeld).toHaveBeenLastCalledWith(true);
      expect(api.held.at(-1)).toBe("viewer-1");
      expect(FakeRfb.made[0].viewOnly).toBe(false);
    });
    expect(document.querySelector(".screen-view.held")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Hand back/ }));
    await screen.findByText("Watching: Hermes is in control.");
    await waitFor(() => {
      expect(FakeRfb.made[0].viewOnly).toBe(true);
      expect(onHeld).toHaveBeenLastCalledWith(false);
      expect(api.held.at(-1)).toBeUndefined();
    });
  });

  it("watches again on a fresh ticket, as the same viewer, when someone else takes over", async () => {
    const api = new FakeScreen();
    api.state.running = true;
    show(api);
    await connected();
    // Hermes broadcasts the other viewer's lease, then closes this stream with 4000.
    act(() => api.leaseListener!("/home/liam/.hermes", { holder: "human", viewer_hash: "0123456789ab", since: 3, epoch: 1 }));
    expect(screen.getByText("Someone else has taken over this screen.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Take over/ }) as HTMLButtonElement).disabled).toBe(false);
    act(() => api.closes[0](4000, "control-taken"));
    act(() => FakeRfb.made[0].fire("disconnect", { clean: false }));
    await waitFor(() => expect(FakeRfb.made).toHaveLength(2));
    expect(api.observed).toEqual([undefined, "viewer-1"]);
    expect(screen.getByText("Someone else took over, so you're watching again.")).toBeTruthy();
    // A lease for another profile's screen changes nothing here.
    act(() => api.leaseListener!("/home/liam/.hermes/profiles/work", { ...agent, epoch: 9 }));
    expect(screen.getByText("Someone else has taken over this screen.")).toBeTruthy();
  });

  it("keeps the owner in control when the connection to Hermes drops, and watches again once it is back", async () => {
    const api = new FakeScreen();
    api.state.running = true;
    FakeRfb.made = [];
    const load = async () => FakeRfb as unknown as RfbConstructor;
    const { rerender } = render(<ScreenTab api={api} shown connected loadRfb={load} />);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: /Take over/ }));
    await screen.findByText(/You're in control/);
    rerender(<ScreenTab api={api} shown connected={false} loadRfb={load} />);
    // No normal close from here: Hermes would take that as the owner leaving and hand control back.
    expect(FakeRfb.made[0].disconnected).toBe(false);
    // Rust drops the stream with the connection.
    act(() => api.closes[0](1006, "the connection to Hermes closed"));
    act(() => FakeRfb.made[0].fire("disconnect", { clean: false }));
    expect(screen.getByText("The stream from the server was lost.")).toBeTruthy();
    // Back on a new connection, as a new viewer: Hermes still has the owner's earlier hold, and the tab says whose.
    api.observe = async (viewerId?: string) => {
      api.observed.push(viewerId);
      return { ...api.state, ticket: "t2", viewer_id: "viewer-2" };
    };
    rerender(<ScreenTab api={api} shown connected loadRfb={load} />);
    await waitFor(() => expect(FakeRfb.made).toHaveLength(2));
    expect(api.sockets).toBe(2);
    expect(await screen.findByText(/You still have control from before the connection dropped/)).toBeTruthy();
    expect(screen.queryByText("Someone else has taken over this screen.")).toBeNull();
  });

  it("offers to reconnect when the stream is lost, rather than trying for ever", async () => {
    const api = new FakeScreen();
    api.state.running = true;
    show(api);
    await connected();
    act(() => api.closes[0](1006, "reset"));
    act(() => FakeRfb.made[0].fire("disconnect", { clean: false }));
    expect(await screen.findByText("The stream from the server was lost.")).toBeTruthy();
    expect(api.sockets).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
    await waitFor(() => expect(api.sockets).toBe(2));
  });

  it("lets go of the stream when it goes, which hands control back", async () => {
    const api = new FakeScreen();
    api.state.running = true;
    const { unmount } = show(api);
    await connected();
    unmount();
    expect(FakeRfb.made[0].disconnected).toBe(true);
  });
});

describe("The apps the Screen adds", () => {
  /** A stopped screen on a server with no browser, terminal or text editor, but xclip. */
  function bare() {
    const api = new FakeScreen();
    api.state = { ...api.state, browser: null, placement: "gateway" };
    api.programs = new Set(["xclip"]);
    return api;
  }
  /** The install over ssh: sudo with `password`, or none needed. Records what it was given. */
  function sudo(password?: string) {
    const given: (string | undefined)[] = [];
    const install: InstallSystem = async (p) => {
      given.push(p);
      const o: SystemOutcome = !password || p === password ? { kind: "installed" } : p === undefined ? { kind: "needs-password" } : { kind: "wrong-password" };
      return o;
    };
    return { given, install: vi.fn(install) };
  }
  function showWith(api: FakeScreen, system?: InstallSystem) {
    FakeRfb.made = [];
    return render(<ScreenTab api={api} shown connected loadRfb={async () => FakeRfb as unknown as RfbConstructor} system={system} />);
  }

  it("adds a web browser, a terminal and a text editor with no click, and the next start puts them in the dock", async () => {
    const api = bare();
    const ssh = sudo();
    let installed!: () => void;
    const slow: InstallSystem = (p) => new Promise((done) => (installed = () => done(ssh.install(p))));
    showWith(api, slow);
    expect(await screen.findByText(/Adding a terminal and a text editor to the screen/)).toBeTruthy();
    act(() => installed());
    expect(await screen.findByText("Added a web browser, a terminal and a text editor to the screen's dock.")).toBeTruthy();
    expect(ssh.given).toEqual([undefined]);
    // Each app added lets the dock be written again; deleting it twice is the same as once.
    expect(new Set(api.calls)).toEqual(new Set(["installBrowser", "resetDock /home/liam/.hermes"]));
    expect(screen.queryByText("No Chrome or Chromium on the Hermes server")).toBeNull();
    expect(screen.queryByRole("button", { name: /Restart the screen/ })).toBeNull();
  });

  it("asks for the sudo password, sends it only to the install, clears it, and tries again when it was wrong", async () => {
    const api = bare();
    api.state.browser = "/usr/bin/chromium";
    const ssh = sudo("hunter2");
    showWith(api, ssh.install);
    expect(await screen.findByText("Adding a terminal and a text editor needs the server's sudo password")).toBeTruthy();
    const field = () => screen.getByLabelText("Sudo password on the server") as HTMLInputElement;
    expect(field().type).toBe("password");
    fireEvent.change(field(), { target: { value: "hunter3" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("That password didn't work. Try it again.")).toBeTruthy();
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Added a terminal and a text editor to the screen's dock.")).toBeTruthy();
    expect(ssh.given).toEqual([undefined, "hunter3", "hunter2"]);
    expect(screen.queryByLabelText("Sudo password on the server")).toBeNull();
  });

  it("lets the owner put the password off", async () => {
    const api = bare();
    api.state.browser = "/usr/bin/chromium";
    showWith(api, sudo("hunter2").install);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/needs the server's sudo password/)).toBeNull();
  });

  it("gives the command to run on the server when the connection has no SSH target", async () => {
    const api = bare();
    api.state.browser = "/usr/bin/chromium";
    showWith(api, undefined);
    const note = (await screen.findByText("Highwing can't add a terminal and a text editor without SSH")).closest(".preview-state") as HTMLElement;
    expect(within(note).getByText(pasteCommand())).toBeTruthy();
    expect(pasteCommand()).toMatch(/^sudo sh -c '.*xfce4-terminal mousepad.*'$/);
    // Installed by hand, then checked again: added, and the dock is written again.
    api.programs.add("xfce4-terminal").add("mousepad");
    fireEvent.click(within(note).getByRole("button", { name: /Check again/ }));
    expect(await screen.findByText("Added a terminal and a text editor to the screen's dock.")).toBeTruthy();
    expect(api.calls).toEqual(["resetDock /home/liam/.hermes"]);
  });

  it("falls back to Hermes's command, saying why, when it can't install the browser", async () => {
    const api = bare();
    api.programs.add("xfce4-terminal").add("mousepad");
    api.pm = { blocked: false, code: 1, output: "error: no Chromium build for linux-riscv64" };
    showWith(api, sudo().install);
    const note = (await screen.findByText("No Chrome or Chromium on the Hermes server")).closest(".preview-state") as HTMLElement;
    expect(within(note).getByText("Highwing couldn't install Chromium: error: no Chromium build for linux-riscv64")).toBeTruthy();
    expect(within(note).getByText(BROWSER_FIX)).toBeTruthy();
    expect(api.calls).toEqual(["installBrowser"]);
  });

  it("says why the terminal and the editor couldn't be added, and tries again", async () => {
    const api = bare();
    api.state.browser = "/usr/bin/chromium";
    let outcome: SystemOutcome = { kind: "no-sudo" };
    showWith(api, async () => outcome);
    const note = (await screen.findByText("Couldn't add a terminal and a text editor to the screen")).closest(".preview-state") as HTMLElement;
    expect(within(note).getByText("The server has no sudo. Sign in over SSH as root, or install sudo there.")).toBeTruthy();
    outcome = { kind: "installed" };
    fireEvent.click(within(note).getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Added a terminal and a text editor to the screen's dock.")).toBeTruthy();
  });

  it("leaves a running screen alone, and restarts it only when the owner asks", async () => {
    const api = bare();
    api.state.running = true;
    showWith(api, sudo().install);
    await connected();
    expect(await screen.findByText(/It is running on its old dock, so they show in the dock after a restart/)).toBeTruthy();
    expect(api.calls).toEqual(["installBrowser"]);
    fireEvent.click(screen.getByRole("button", { name: /Restart the screen/ }));
    expect(await screen.findByText("Added a web browser, a terminal and a text editor to the screen's dock.")).toBeTruthy();
    expect(api.calls).toEqual(["installBrowser", "stop", "resetDock /home/liam/.hermes", "start"]);
    await waitFor(() => expect(FakeRfb.made).toHaveLength(2));
  });

  it("doesn't restart a screen the owner holds", async () => {
    const api = bare();
    api.state.running = true;
    showWith(api, sudo().install);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: /Take over/ }));
    await screen.findByText(/You're in control/);
    fireEvent.click(await screen.findByRole("button", { name: /Restart the screen/ }));
    expect(await screen.findByText("a human holds this screen; pass force: true to stop it anyway")).toBeTruthy();
    expect(api.calls).toEqual(["installBrowser", "stop"]);
  });

  it("adds xclip for copying out without touching the dock, even on a running screen", async () => {
    const api = bare();
    api.state = { ...api.state, running: true, browser: "/usr/bin/chromium" };
    api.programs = new Set(["xfce4-terminal", "mousepad"]);
    showWith(api, sudo("hunter2").install);
    await connected();
    fireEvent.change(await screen.findByLabelText("Sudo password on the server"), { target: { value: "hunter2" } });
    expect(screen.getByText("Adding xclip (for copying out) needs the server's sudo password")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Added xclip (for copying out).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restart the screen/ })).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("says a recent sign-in may be lost next to Restart the screen", async () => {
    const api = bare();
    api.state.running = true;
    showWith(api, sudo().install);
    await connected();
    const restart = await screen.findByRole("button", { name: /Restart the screen/ });
    expect(restart.parentElement!.textContent).toContain("a sign-in made on the screen in the last half minute may be lost");
  });

  it("adds nothing to a screen in the terminal's sandbox, which brings its own", async () => {
    const api = bare();
    api.state.placement = "terminal:docker";
    const ssh = sudo();
    showWith(api, ssh.install);
    await screen.findByRole("button", { name: /Start the screen/ });
    expect(api.calls).toEqual([]);
    expect(ssh.given).toEqual([]);
  });
});

describe("Loading noVNC", () => {
  it("hides WebCodecs' VideoDecoder while noVNC loads, since probing it crashes WebKitGTK without H.264, and puts it back", async () => {
    const seen: boolean[] = [];
    class VideoDecoder {}
    Object.defineProperty(globalThis, "VideoDecoder", { value: VideoDecoder, configurable: true, writable: true });
    vi.doMock("@novnc/novnc", () => {
      seen.push("VideoDecoder" in globalThis);
      return { default: FakeRfb };
    });
    const { loadNoVnc } = await import("./Screen");
    expect(await loadNoVnc()).toBe(FakeRfb);
    expect(seen).toEqual([false]);
    expect((globalThis as Record<string, unknown>).VideoDecoder).toBe(VideoDecoder);
    vi.doUnmock("@novnc/novnc");
    delete (globalThis as Record<string, unknown>).VideoDecoder;
  });
});
