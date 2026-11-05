// @vitest-environment jsdom
// The side panel's Screen (Screen.tsx, ADR 0039) against a fake of Hermes's `display.*` and a stand-in for noVNC, which
// jsdom can't draw: what it says for each state of the screen, watching, taking over and handing back, another viewer
// taking over, and letting go of the stream when it goes.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenTab, type RfbClient, type RfbConstructor } from "./Screen";
import { viewerHash, type DisplayLease, type DisplayObserve, type DisplayStatus, type ScreenApi } from "../hermes/screen";

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
  start = async () => (this.state = { ...this.state, running: true });
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
