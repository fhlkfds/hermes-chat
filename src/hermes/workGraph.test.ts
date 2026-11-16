// The Work page's graph (issue #604): which cards' links are read, the graph those reads draw, and its layout.
import { describe, expect, it } from "vitest";
import type { BoardTask } from "./kanban";
import { NODE, arrow, graphOf, layout, place, readKey, toRead, type LinkRead } from "./workGraph";

const card = (id: string, parents = 0, children = 0, status = "todo"): BoardTask => ({
  id,
  title: `Card ${id}`,
  body: "",
  assignee: "",
  status,
  priority: 0,
  comments: 0,
  links: { parents, children },
});
const read = (t: BoardTask, parents: string[], children: string[], linked: LinkRead["linked"] = []): [string, LinkRead] => [
  t.id,
  { key: readKey(t), links: { parents, children }, linked },
];

describe("the Work graph", () => {
  it("reads only linked cards, and again only when their counts or status change", () => {
    const a = card("a", 0, 1);
    const b = card("b", 1, 0);
    const c = card("c");
    expect(toRead([a, b, c], new Map())).toEqual(["a", "b"]);
    const reads = new Map([read(a, [], ["b"]), read(b, ["a"], [])]);
    expect(toRead([a, b, c], reads)).toEqual([]);
    expect(toRead([a, { ...b, status: "ready" }, c], reads)).toEqual(["b"]);
    expect(toRead([{ ...a, links: { parents: 0, children: 2 } }, b, c], reads)).toEqual(["a"]);
  });

  it("draws each link once, puts unlinked cards apart, and names a linked task not on the board from the reads", () => {
    const a = card("a", 0, 1);
    const b = card("b", 2, 0);
    const c = card("c");
    const reads = new Map([read(a, [], ["b"]), read(b, ["a", "gone"], [], [{ id: "gone", title: "Archived plan", status: "archived" }])]);
    const g = graphOf([a, b, c], reads);
    expect(g.edges).toEqual([
      { parent: "a", child: "b" },
      { parent: "gone", child: "b" },
    ]);
    expect(g.nodes.map((n) => [n.id, n.title, !!n.task])).toEqual([
      ["a", "Card a", true],
      ["b", "Card b", true],
      ["gone", "Archived plan", false],
    ]);
    expect(g.loose).toEqual([c]);
  });

  it("names a ghost by its id when Hermes no longer has it", () => {
    const b = card("b", 1, 0);
    expect(graphOf([b], new Map([read(b, ["t_gone"], [])])).nodes.at(-1)).toEqual({ id: "t_gone", title: "t_gone", status: "" });
  });

  it("keeps a linked card not read yet in the graph, and drops the links of one the board shows unlinked now", () => {
    const a = card("a", 0, 1);
    const g = graphOf([a, card("b", 0, 0)], new Map([read(card("b", 1, 0), ["a"], [])]));
    expect(g.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(g.edges).toEqual([]);
  });

  it("puts each card one layer past the furthest card it waits on", () => {
    const edges = [
      { parent: "a", child: "b" },
      { parent: "b", child: "c" },
      { parent: "a", child: "c" },
      { parent: "x", child: "c" },
    ];
    expect(layout(["c", "b", "a", "x"], edges)).toEqual([["a", "x"], ["b"], ["c"]]);
  });

  it("orders a layer by where its cards' parents sit", () => {
    const edges = [
      { parent: "p1", child: "k2" },
      { parent: "p2", child: "k1" },
    ];
    expect(layout(["p1", "p2", "k1", "k2"], edges)).toEqual([
      ["p1", "p2"],
      ["k2", "k1"],
    ]);
  });

  it("puts the cards of a loop in a last layer instead of going round it", () => {
    const edges = [
      { parent: "a", child: "b" },
      { parent: "b", child: "c" },
      { parent: "c", child: "b" },
    ];
    expect(layout(["a", "b", "c"], edges)).toEqual([["a"], ["b", "c"]]);
  });

  it("places layers left to right and draws an arrow from a parent's right side to its child's left", () => {
    const { at, width, height } = place([["a"], ["b", "c"]]);
    expect(at.get("c")).toEqual({ x: NODE.width + NODE.gapX, y: NODE.height + NODE.gapY });
    expect(width).toBe(2 * NODE.width + NODE.gapX);
    expect(height).toBe(2 * NODE.height + NODE.gapY);
    expect(arrow(at.get("a")!, at.get("b")!)).toMatch(new RegExp(`^M ${NODE.width} ${NODE.height / 2} C .* ${NODE.width + NODE.gapX} ${NODE.height / 2}$`));
  });

  it("runs an arrow that skips a layer between that layer's cards, over no card but its own two", () => {
    const edges = [
      { parent: "a", child: "b" },
      { parent: "a", child: "c" },
      { parent: "b", child: "d" },
      { parent: "a", child: "d" },
    ];
    const layers = layout(["a", "b", "c", "d"], edges);
    expect(layers).toEqual([["a"], ["b", "c"], ["d"]]);
    const { at } = place(layers);
    const card = (id: string) => ({ ...at.get(id)!, w: NODE.width, h: NODE.height });
    for (const e of edges) {
      const others = [...at.keys()].filter((id) => id !== e.parent && id !== e.child).map(card);
      const crossed = points(arrow(at.get(e.parent)!, at.get(e.child)!)).filter((p) => others.some((o) => p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h));
      expect(crossed, `${e.parent} → ${e.child}`).toEqual([]);
    }
  });
});

/** Points along an SVG path made of `M`, `L` and `C` commands, every few pixels. */
function points(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let at = { x: 0, y: 0 };
  for (const [, cmd, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = args.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const ps = Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i], y: n[2 * i + 1] }));
    const end = ps.at(-1)!;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      if (cmd === "L") out.push({ x: at.x + (end.x - at.x) * t, y: at.y + (end.y - at.y) * t });
      if (cmd === "C") {
        const [p1, p2] = ps;
        const mix = (a: number, b: number, c: number, e: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * e;
        out.push({ x: mix(at.x, p1.x, p2.x, end.x), y: mix(at.y, p1.y, p2.y, end.y) });
      }
    }
    at = end;
  }
  return out;
}
