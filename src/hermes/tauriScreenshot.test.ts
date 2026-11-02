import { beforeEach, describe, expect, it, vi } from "vitest";
import { onDesktopScreenshot } from "./tauriScreenshot";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(vi.fn());
});

describe("Desktop screenshot request lifecycle", () => {
  it("leaves a pending request for the next window when cleanup happens while Rust answers", async () => {
    let answer!: (id: number | null) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const old = vi.fn();
    const stop = onDesktopScreenshot(old);
    await flush();
    stop();
    answer(7);
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["screenshot_pending_request"]);

    invoke.mockResolvedValueOnce(7).mockResolvedValueOnce(undefined);
    const next = vi.fn();
    const stopNext = onDesktopScreenshot(next);
    await flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("screenshot_ack_request", { id: 7 });
    stopNext();
  });

  it("unregisters once and never asks Rust when disposed before listener registration finishes", async () => {
    let registered!: (stop: () => void) => void;
    listen.mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
    const unlisten = vi.fn();
    const capture = vi.fn();
    const stop = onDesktopScreenshot(capture);
    stop();
    registered(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("serializes startup and event requests, acknowledging only after handling them", async () => {
    let event!: () => void;
    let answer!: (id: number | null) => void;
    const unlisten = vi.fn();
    listen.mockImplementation(async (_, fn) => { event = fn; return unlisten; });
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(null);
    const capture = vi.fn(() => expect(invoke).not.toHaveBeenCalledWith("screenshot_ack_request", { id: 3 }));
    const stop = onDesktopScreenshot(capture);
    await flush();
    event();
    event();
    answer(3);
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls).toEqual([["screenshot_pending_request"], ["screenshot_ack_request", { id: 3 }], ["screenshot_pending_request"]]);
    stop();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
