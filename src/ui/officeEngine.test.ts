// @vitest-environment jsdom
// The building's frame budget (ADR 0089), on the real engine with only three.js's WebGL renderer stood in for, since
// jsdom has no WebGL: a frame only when something changes, none at all while no one moves, at most 30 a second while
// someone types, none while inactive, and a pixel ratio of at most 1.5.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAgent, OfficeEngine } from "./officeEngine";

const renderer = vi.hoisted(() => ({ renders: 0, ratio: 0 }));
vi.mock("three", async (real) => ({
  ...(await real<typeof import("three")>()),
  WebGLRenderer: class {
    setPixelRatio(r: number) {
      renderer.ratio = r;
    }
    setSize() {}
    render() {
      renderer.renders++;
    }
    dispose() {}
    forceContextLoss() {}
  },
}));
const { createOfficeEngine, furnitureAt, forward, FACING } = await import("./officeEngine");

let resized: (() => void) | undefined;
beforeEach(() => {
  renderer.renders = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        resized = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function make(): { engine: OfficeEngine; surface: HTMLElement; projected: number } {
  const surface = document.createElement("div");
  const canvas = document.createElement("canvas");
  surface.append(canvas);
  document.body.append(surface);
  const out = { engine: undefined as unknown as OfficeEngine, surface, projected: 0 };
  out.engine = createOfficeEngine({ canvas, surface, onProject: () => void out.projected++ });
  return out;
}
const agent = (key: string, more: Partial<EngineAgent> = {}): EngineAgent => ({ key, floorRoom: "workroom", spot: 0, team: 0, state: "running", stale: false, ...more });
const typing = [agent("r"), agent("a", { spot: 1 }), agent("b", { spot: 2 })];
const still = [
  agent("w", { floorRoom: "waiting", state: "approval" }),
  agent("t", { floorRoom: "trouble", state: "failed" }),
  agent("l", { floorRoom: "lounge", state: "stopped" }),
  agent("x", { stale: true }),
  agent("q", { state: "queued", door: true }),
];
/** Frames drawn over `ms` from now. */
const over = async (ms: number) => {
  const before = renderer.renders;
  await vi.advanceTimersByTimeAsync(ms);
  return renderer.renders - before;
};
const pointer = (type: string, x: number, y: number) => Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1 });

describe("The building's frame budget", () => {
  it("draws one frame for each change, and none while no agent moves", async () => {
    const { engine } = make();
    expect(await over(100)).toBe(1);
    engine.setAgents(still);
    expect(await over(100)).toBe(1);
    expect(await over(10_000)).toBe(0);
    // The same agents again, as every render of the app passes them, draw nothing.
    engine.setAgents(still.map((a) => ({ ...a })));
    expect(await over(1_000)).toBe(0);
    engine.setTheme("light", "#ffffff");
    expect(await over(1_000)).toBe(1);
    resized?.();
    expect(await over(1_000)).toBe(1);
    engine.dispose();
  });

  it("draws about 12 frames a second while agents type, never more than 30, and stops once none does", async () => {
    const { engine } = make();
    engine.setAgents(typing);
    await over(100);
    const second = await over(1_000);
    // The fake display refreshes every 16 ms, so a frame lands on the refresh after each 12th of a second.
    expect(second).toBeGreaterThanOrEqual(9);
    expect(second).toBeLessThanOrEqual(12);
    engine.setAgents(typing.map((a) => ({ ...a, floorRoom: "lounge" as const, state: "completed" as const })));
    await over(100);
    expect(await over(10_000)).toBe(0);
    engine.dispose();
  });

  it("doesn't animate a stale agent, nor anyone when the system asks for reduced motion", async () => {
    const { engine } = make();
    engine.setAgents(typing.map((a) => ({ ...a, stale: true })));
    await over(100);
    expect(await over(5_000)).toBe(0);
    engine.setAgents(typing);
    engine.setMotion(false);
    await over(100);
    expect(await over(5_000)).toBe(0);
    engine.setMotion(true);
    expect(await over(1_000)).toBeGreaterThanOrEqual(9);
    engine.dispose();
  });

  it("draws nothing while inactive (hidden, minimized or unfocused), even as agents change, and catches up once active", async () => {
    const { engine } = make();
    engine.setAgents(typing);
    await over(500);
    engine.setActive(false);
    expect(await over(5_000)).toBe(0);
    engine.setAgents(still);
    expect(await over(1_000)).toBe(0);
    engine.setActive(true);
    expect(await over(1_000)).toBe(1);
    engine.dispose();
  });

  it("draws while the camera turns, then stops, and tells a drag from a click", async () => {
    const { engine, surface, projected } = make();
    engine.setAgents(still);
    await over(100);
    surface.dispatchEvent(pointer("pointerdown", 100, 100));
    surface.dispatchEvent(pointer("pointermove", 102, 100));
    expect(await over(100)).toBe(0);
    expect(engine.dragged()).toBe(false);
    surface.dispatchEvent(pointer("pointermove", 160, 120));
    expect(await over(50)).toBe(1);
    // A drag moves the camera as fast as the pointer, up to 30 frames a second.
    for (let x = 0; x < 60; x++) {
      surface.dispatchEvent(pointer("pointermove", 160 + x, 120));
      await vi.advanceTimersByTimeAsync(1000 / 60);
    }
    await over(100);
    expect(renderer.renders).toBeLessThanOrEqual(3 + 31);
    surface.dispatchEvent(pointer("pointerup", 160, 120));
    expect(engine.dragged()).toBe(true);
    expect(await over(5_000)).toBe(0);
    expect(engine.dragged()).toBe(false);
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    expect(await over(100)).toBe(1);
    engine.resetView();
    expect(await over(100)).toBe(1);
    expect(projected).toBeGreaterThanOrEqual(0);
    engine.dispose();
  });

  it("leaves a drag, scroll or double-click on the card or the buttons to them, not the camera", async () => {
    const { engine, surface } = make();
    engine.setAgents(still);
    await over(100);
    const card = document.createElement("aside");
    card.setAttribute("data-camera-ignore", "");
    const text = document.createElement("p");
    card.append(text);
    surface.append(card);
    text.dispatchEvent(pointer("pointerdown", 100, 100));
    text.dispatchEvent(pointer("pointermove", 200, 160));
    text.dispatchEvent(pointer("pointerup", 200, 160));
    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    text.dispatchEvent(wheel);
    text.dispatchEvent(new MouseEvent("dblclick", { clientX: 100, clientY: 100, bubbles: true }));
    expect(wheel.defaultPrevented).toBe(false);
    expect(engine.dragged()).toBe(false);
    expect(await over(1_000)).toBe(0);
    engine.dispose();
  });

  it("puts a trouble desk in front of whoever sits at it, and a couch's backrest behind whoever sits on it", () => {
    const ahead = (room: "trouble" | "lounge", at: [number, number, number]) => {
      const f = forward(FACING[room]);
      return at[0] * f.x + at[2] * f.z;
    };
    expect(ahead("trouble", furnitureAt("trouble")[0].at)).toBeGreaterThan(0.3);
    const [seat, back] = furnitureAt("lounge");
    expect(ahead("lounge", back.at)).toBeLessThan(-0.3);
    expect(Math.abs(ahead("lounge", seat.at))).toBeLessThan(0.1);
  });

  it("caps the pixel ratio at 1.5, and draws nothing once disposed", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    const { engine } = make();
    expect(renderer.ratio).toBe(1.5);
    engine.setAgents(typing);
    await over(100);
    engine.dispose();
    expect(await over(2_000)).toBe(0);
  });
});
