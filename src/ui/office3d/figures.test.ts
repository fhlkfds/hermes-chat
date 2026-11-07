// The characters' meshes, without a renderer: each agent is drawn at the seat the floor gave it, and only typing arms
// move between frames.
import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import type { Desk, DeskState, Room } from "../../hermes/office";
import { EMPTY_FLOOR_MEMORY, officeFloor } from "../../hermes/officeFloor";
import { buildFigures } from "./figures";

function team(key: string, ...states: DeskState[]): Room {
  const desks = states.map((state, i) => ({ key: `${key} ${i}`, agent: { kind: "reply" }, name: `${key} ${i}`, state }) as Desk);
  return { key, profile: "default", chatId: key, title: key, desks };
}

const positionOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);

describe("The office's characters", () => {
  it("stands each body at its own seat, over the floor plan's spot", () => {
    const floor = officeFloor([team("a", "running", "running", "running"), team("b", "approval", "failed", "completed", "queued")], EMPTY_FLOOR_MEMORY);
    const figures = buildFigures();
    figures.set(floor.characters);
    const [body] = figures.pickable;
    expect(body.count).toBe(floor.characters.length);
    floor.characters.forEach((c, i) => {
      const m = new Matrix4();
      body.getMatrixAt(i, m);
      const at = positionOf(m);
      // The body leans with its pose, so it sits within a hand's width of its spot.
      expect(Math.hypot(at.x - c.spot.x, at.z - c.spot.z)).toBeLessThan(0.3);
      expect(at.y).toBeGreaterThan(0.3);
    });
    const places = floor.characters.map((_, i) => {
      const m = new Matrix4();
      body.getMatrixAt(i, m);
      const p = positionOf(m);
      return `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    });
    expect(new Set(places).size).toBe(places.length);
    expect(figures.keyAt(2)).toBe("a 2");
  });

  it("moves only a typing, current agent's arms, and none when nothing may move", () => {
    const floor = officeFloor([team("a", "running", "completed")], EMPTY_FLOOR_MEMORY);
    const stale = officeFloor([{ ...team("s", "running"), desks: [{ ...team("s", "running").desks[0], stale: "As last seen." }] }], EMPTY_FLOOR_MEMORY);
    const figures = buildFigures();
    figures.set(floor.characters);
    expect(figures.animate(0, false)).toBe(false);
    expect(figures.animate(0, true)).toBe(true);
    figures.set(stale.characters);
    expect(figures.animate(0, true)).toBe(false);
  });
});
