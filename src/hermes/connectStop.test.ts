// Stopping a first connection while it opens (`connect`'s signal): Setup's Stop during Save and connect.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import type { OpenPipe } from "./pipe";
import { CONNECT_STOPPED, connect } from "./transport";

/** A pipe that opens only when let through, or fails once it is told to stop, as Rust's `hermes_connect` does. */
function heldPipe(server: FakeHermes) {
  const state = { stopsAsked: 0, opening: false, letThrough: undefined as (() => void) | undefined };
  const open: OpenPipe = async (onEvent, profile, signal) => {
    state.opening = true;
    await new Promise<void>((resolve, reject) => {
      state.letThrough = resolve;
      signal?.addEventListener("abort", () => {
        state.stopsAsked++;
        reject(new Error("The connection was stopped."));
      });
    });
    return server.openPipe(onEvent, profile);
  };
  return { open, state };
}

describe("Stopping a connection while it opens", () => {
  it("stops Rust's opening and rejects as stopped, leaving nothing open", async () => {
    const server = new FakeHermes();
    const { open, state } = heldPipe(server);
    const stop = new AbortController();
    const connecting = connect(open, undefined, undefined, undefined, stop.signal);
    await new Promise((r) => setTimeout(r));
    expect(state.opening).toBe(true);
    stop.abort();
    await expect(connecting).rejects.toThrow(CONNECT_STOPPED);
    expect(state.stopsAsked).toBe(1);
    expect(server.opened).toBe(0);
  });

  it("never opens when stopped before it starts", async () => {
    const server = new FakeHermes();
    const { open, state } = heldPipe(server);
    const stop = new AbortController();
    stop.abort();
    await expect(connect(open, undefined, undefined, undefined, stop.signal)).rejects.toThrow(CONNECT_STOPPED);
    expect(state.opening).toBe(false);
  });

  it("closes a pipe that opened but whose Hermes hadn't answered yet, and says stopped", async () => {
    const server = new FakeHermes();
    // Opens at once, but Hermes's gateway.ready comes only after the stop.
    let sendReady: (() => void) | undefined;
    const slow: OpenPipe = async (onEvent, profile) => {
      const pipe = await server.openPipe((e) => {
        if (e.kind === "frame" && e.text.includes("gateway.ready") && !sendReady) return void (sendReady = () => onEvent(e));
        onEvent(e);
      }, profile);
      return pipe;
    };
    const stop = new AbortController();
    const connecting = connect(slow, undefined, undefined, undefined, stop.signal);
    await new Promise((r) => setTimeout(r));
    expect(server.opened).toBe(1);
    stop.abort();
    sendReady?.();
    await expect(connecting).rejects.toThrow(CONNECT_STOPPED);
    expect(server.closed).toBe(true);
  });

  it("changes nothing once Hermes has answered", async () => {
    const server = new FakeHermes();
    const stop = new AbortController();
    const hermes = await connect(server.openPipe, undefined, undefined, undefined, stop.signal);
    stop.abort();
    await new Promise((r) => setTimeout(r));
    expect(server.closed).toBe(false);
    expect(hermes.getSnapshot().status).toBe("connected");
    await hermes.close();
  });

  it("fails as before without a signal", async () => {
    const server = new FakeHermes();
    server.refuse = "Can't reach the Hermes dashboard: connection refused";
    await expect(connect(server.openPipe)).rejects.toThrow("connection refused");
  });
});
