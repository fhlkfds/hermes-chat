// The Screen's logic (screen.ts, ADR 0039): what to show for each `display.status`, how the lease is read, the
// WebSocket-shaped relay noVNC drives, and `display.*` over the transport against FakeHermes.
import { describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { RelayedSocket, heldBy, isOlder, isUnavailable, phaseOf, viewerHash, type DisplayLease, type DisplayStatus, type ScreenSocket } from "./screen";

const agent: DisplayLease = { holder: "agent", viewer_hash: null, since: 1, epoch: 0 };
const status = (s: Partial<DisplayStatus>): DisplayStatus => ({ supported: true, installed: true, missing: [], running: false, lease: agent, profile_key: "/h", ...s });

describe("What the Screen shows", () => {
  it("reads each state of the screen from display.status", () => {
    expect(phaseOf(status({ supported: false }))).toEqual({ kind: "unsupported" });
    expect(phaseOf(status({ installed: false, missing: ["Xvnc"], install_command: "sudo pacman -S tigervnc" }))).toEqual({
      kind: "not-installed",
      missing: ["Xvnc"],
      command: "sudo pacman -S tigervnc",
    });
    expect(phaseOf(status({ blocker: "only 900 MB free; the screen needs 1536 MB" }))).toEqual({ kind: "blocked", why: "only 900 MB free; the screen needs 1536 MB" });
    expect(phaseOf(status({}))).toEqual({ kind: "stopped" });
    expect(phaseOf(status({ running: true }))).toEqual({ kind: "live" });
  });

  it("names the lease's holder by the same hash Hermes does, and never trusts an older lease", async () => {
    // Python: hashlib.sha256(b"abc").hexdigest()[:12]
    expect(await viewerHash("abc")).toBe("ba7816bf8f01");
    const mine: DisplayLease = { holder: "human", viewer_hash: "ba7816bf8f01", since: 2, epoch: 3 };
    expect(heldBy(mine, "ba7816bf8f01")).toBe(true);
    expect(heldBy(mine, "000000000000")).toBe(false);
    expect(heldBy(agent, undefined)).toBe(false);
    expect(isOlder(mine, { ...agent, epoch: 2 })).toBe(true);
    expect(isOlder(mine, { ...agent, epoch: 4 })).toBe(false);
  });

  it("tells a Hermes without the screen apart from other failures", () => {
    expect(isUnavailable(Object.assign(new Error("unknown method: display.status"), { code: -32601 }))).toBe(true);
    expect(isUnavailable(new Error("Method not found"))).toBe(true);
    expect(isUnavailable(new Error("Not connected to Hermes."))).toBe(false);
  });
});

describe("The relayed stream noVNC drives", () => {
  function relay() {
    let onData!: (b: ArrayBuffer) => void;
    let onClose!: (code: number, reason: string) => void;
    const sent: Uint8Array[] = [];
    const sock: ScreenSocket & { closed: number } = { closed: 0, send: (b) => void sent.push(b), close: () => void sock.closed++ };
    const open = vi.fn(async (_t: string, d: typeof onData, c: typeof onClose) => {
      onData = d;
      onClose = c;
      return sock;
    });
    return { open, sent, sock, data: (b: number[]) => onData(new Uint8Array(b).buffer), close: (code: number) => onClose(code, "control-taken") };
  }

  it("opens on the next task and hands over bytes that came before noVNC was listening", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "ticket-1");
    expect(r.open.mock.calls[0][0]).toBe("ticket-1");
    expect(ws.readyState).toBe(0);
    r.data([82, 70, 66]);
    const got: number[][] = [];
    ws.onmessage = (e) => void got.push([...new Uint8Array(e.data)]);
    const opened = vi.fn();
    ws.onopen = opened;
    await new Promise((d) => setTimeout(d, 0));
    expect(opened).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(1);
    expect(got).toEqual([[82, 70, 66]]);
  });

  it("copies what it sends, since noVNC reuses its buffer at once", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    const buffer = new Uint8Array([1, 2, 3]);
    ws.send(buffer.subarray(0, 2));
    buffer[0] = 9;
    expect([...r.sent[0]]).toEqual([1, 2]);
  });

  it("reports Hermes's close code, and closes normally itself so control goes back to the agent", async () => {
    const r = relay();
    const ws = await RelayedSocket.open(r.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    const closed = vi.fn();
    ws.onclose = closed;
    r.close(4000);
    expect(ws.closeCode).toBe(4000);
    // Rust lets go of its end of a stream Hermes closed.
    expect(r.sock.closed).toBe(1);
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: "control-taken", wasClean: false });
    ws.send(new Uint8Array([1]));
    expect(r.sent).toHaveLength(0);

    const r2 = relay();
    const ws2 = await RelayedSocket.open(r2.open, "t");
    await new Promise((d) => setTimeout(d, 0));
    ws2.close();
    expect(r2.sock.closed).toBe(1);
    expect(ws2.closeCode).toBe(1000);
  });
});

describe("display.* over the connection", () => {
  it("asks for the profile shown, mints a viewer, takes over and hands back, hearing Hermes's lease broadcasts", async () => {
    const server = new FakeHermes();
    server.display = { status: { supported: true, installed: true, missing: [], running: false, geometry: "1440x900" }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const leases: [string, DisplayLease][] = [];
    const off = hermes.screen.onLease((k, l) => void leases.push([k, l]));

    expect((await hermes.screen.status()).running).toBe(false);
    await expect(hermes.screen.observe()).rejects.toThrow(/not running/);
    expect((await hermes.screen.start()).running).toBe(true);
    const seen = await hermes.screen.observe();
    expect(seen).toMatchObject({ ticket: "ticket-viewer-1", viewer_id: "viewer-1" });
    // Observing again with the id this connection minted keeps it.
    expect((await hermes.screen.observe("viewer-1")).viewer_id).toBe("viewer-1");

    const taken = await hermes.screen.takeOver("viewer-1");
    expect(heldBy(taken, await viewerHash("viewer-1"))).toBe(true);
    await expect(hermes.screen.takeOver("made-up")).rejects.toThrow(/not minted/);
    const back = await hermes.screen.handBack("viewer-1");
    expect(back.holder).toBe("agent");
    await vi.waitFor(() => expect(leases.map(([, l]) => l.holder)).toEqual(["human", "agent"]));
    expect(leases[0][0]).toBe("/home/liam/.hermes");
    off();

    const asked = server.requests.filter((r) => r.method.startsWith("display."));
    expect(asked.every((r) => r.params.profile === "default")).toBe(true);
  });

  it.each(["another profile", "sign-out"])("hands back the screen the owner holds before leaving for %s, stream or no stream", async (leave) => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    await hermes.screen.takeOver(viewer_id);
    hermes.screen.noteHeld(viewer_id);
    expect(server.display.lease.holder).toBe("human");
    if (leave === "sign-out") await hermes.close();
    else await hermes.switchProfile("work");
    expect(server.display.lease.holder).toBe("agent");
    const release = server.requests.find((r) => r.method === "display.lease.release")!;
    expect(release.params).toMatchObject({ viewer_id, profile: "default" });
  });

  it("lands on the profile picked last when one is picked while the screen is still being handed back", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [], home: [] };
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    await hermes.screen.takeOver(viewer_id);
    hermes.screen.noteHeld(viewer_id);
    const first = hermes.switchProfile("work");
    const second = hermes.switchProfile("home");
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "home", status: "connected" }));
    expect(server.display.lease.holder).toBe("agent");
  });

  it("stays on the profile shown when the owner picks it again while the screen is being handed back", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    await hermes.screen.takeOver(viewer_id);
    hermes.screen.noteHeld(viewer_id);
    await Promise.all([hermes.switchProfile("work"), hermes.switchProfile("default")]);
    expect(hermes.getSnapshot()).toMatchObject({ profile: "default", status: "connected" });
    expect(server.display.lease.holder).toBe("agent");
  });

  it("waits for a hand-back under way before signing out", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    await hermes.screen.takeOver(viewer_id);
    hermes.screen.noteHeld(viewer_id);
    const switching = hermes.switchProfile("work");
    await hermes.close();
    await switching;
    expect(server.display.lease.holder).toBe("agent");
  });

  it("leaves the screen alone when the owner doesn't hold it", async () => {
    const server = new FakeHermes();
    server.display = { status: { supported: true, installed: true, missing: [], running: true }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
    const hermes = await connect(server.openPipe);
    const { viewer_id } = await hermes.screen.observe();
    hermes.screen.noteHeld(viewer_id);
    hermes.screen.noteHeld(undefined);
    await hermes.close();
    expect(server.requests.some((r) => r.method === "display.lease.release")).toBe(false);
  });

  it("says when this Hermes has no screen, and refuses to open a stream the connection can't relay", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const failed = await hermes.screen.status().catch((e: unknown) => e);
    expect(isUnavailable(failed)).toBe(true);
    await expect(hermes.screen.openSocket("t", () => {}, () => {})).rejects.toThrow(/can't show the screen/);
  });
});
