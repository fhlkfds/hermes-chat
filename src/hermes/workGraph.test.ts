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
});
