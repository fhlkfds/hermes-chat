// @vitest-environment jsdom
// The Graph view's link reads (issue #604, ADR 0179): no more than four out at once, one per card, and a card whose
// counts change while its read is out, or whose read was out at a Refresh or a remount, is read again. Each card is
// tall enough for its rows, and a column's cards don't overlap, at every interface size.
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BoardTask, TaskDetail } from "../hermes/kanban";
import { UI_SIZES } from "./appearance";
import { WorkGraph } from "./WorkGraph";

afterEach(cleanup);

const card = (id: string, children: number, status = "todo"): BoardTask => ({
  id,
  title: id,
  body: "",
  assignee: "",
  status,
  priority: 0,
  comments: 0,
  links: { parents: 0, children },
});

/** A `loadTask` whose answers the test hands out one at a time, newest first for a card asked twice. */
function held() {
  const asked: string[] = [];
  const waiting: { id: string; answer: () => void }[] = [];
  const loadTask = (id: string) =>
    new Promise<TaskDetail>((done) => {
      asked.push(id);
      waiting.push({ id, answer: () => done({ task: card(id, 1), comments: [], links: { parents: [], children: id === "a" ? ["b"] : [] }, linked: [] }) });
    });
  const answer = async (id: string) => {
    const i = waiting.map((w) => w.id).lastIndexOf(id);
    const [w] = waiting.splice(i, 1);
    await act(async () => w.answer());
  };
  return { asked, loadTask, answer };
}

describe("the Graph view's link reads", () => {
  it("reads each linked card once, at most four at a time", async () => {
    const api = held();
    const tasks = ["a", "b", "c", "d", "e", "f"].map((id) => card(id, 1));
    render(<WorkGraph tasks={tasks} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a", "b", "c", "d"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "b", "c", "d", "e"]);
    await api.answer("b");
    await api.answer("c");
    expect(api.asked).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("reads a card again when its counts change while its read is out", async () => {
    const api = held();
    const { rerender } = render(<WorkGraph tasks={[card("a", 1)]} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    rerender(<WorkGraph tasks={[card("a", 2)]} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "a"]);
    await api.answer("a");
    expect(api.asked).toEqual(["a", "a"]);
  });

  it("asks again for a read that was out when React remounted the view, as StrictMode does", async () => {
    const api = held();
    render(
      <StrictMode>
        <WorkGraph tasks={[card("a", 1), card("b", 0)]} api={api} refreshed={0} onOpen={() => {}} />
      </StrictMode>,
    );
    expect(api.asked.at(-1)).toBe("a");
    await api.answer("a");
    expect(document.querySelectorAll("[data-edge]")).toHaveLength(1);
  });

  it("asks again for reads that were out when the owner pressed Refresh", async () => {
    const api = held();
    const tasks = [card("a", 1), card("b", 0)];
    const { rerender } = render(<WorkGraph tasks={tasks} api={api} refreshed={0} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a"]);
    rerender(<WorkGraph tasks={tasks} api={api} refreshed={1} onOpen={() => {}} />);
    expect(api.asked).toEqual(["a", "a"]);
    await api.answer("a");
    expect(document.querySelectorAll("[data-edge]")).toHaveLength(1);
  });
});

// jsdom lays nothing out, so the rows' heights come from styles.css: a card's box must hold each row's lines at the
// line height the stylesheet sets, plus the padding, the gaps between the rows and the border.
const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rules whose selector list includes `selector`. */
const rule = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(",").map((s) => s.trim()).includes(selector))
    .map((m) => m[2])
    .join(";");
const value = (decls: string, prop: string) => decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
/** A stylesheet length in px at the interface size `px`: `Npx`, or `calc(Nrem / 14)`, which scales with it. */
function length(v: string | undefined, px: number): number {
  const fixed = v?.match(/^(\d+(?:\.\d+)?)px\b/);
  if (fixed) return Number(fixed[1]);
  const scaled = v?.match(/^calc\((\d+(?:\.\d+)?)rem \/ 14\)$/);
  if (scaled) return (Number(scaled[1]) * px) / 14;
  throw new Error(`not a length this test reads: ${v}`);
}

/** A length the graph sets on a card, `calc(Npx * var(--ui-scale, 1))`, in px at the interface size `px`. */
function atSize(v: string, px: number): number {
  const n = v.match(/^calc\((\d+(?:\.\d+)?)px \* var\(--ui-scale, 1\)\)$/);
  if (!n) throw new Error(`not a length that grows with the interface size: ${v}`);
  return (Number(n[1]) * px) / 14;
}

const NODE_RULE = ".settings .work-card.work-node";
/** The rows of a graph card, top to bottom. A row takes the lines its `line-clamp` allows, or one line it doesn't wrap. */
const rows = [
  { name: "meta", selector: `${NODE_RULE} .work-meta` },
  { name: "title", selector: `${NODE_RULE} .work-title` },
  { name: "body or blocked summary", selector: `${NODE_RULE} p` },
  { name: "assignee", selector: `${NODE_RULE} .work-assignee`, icon: 13 },
];

/** The least height a card's box needs at the interface size `px`. */
function needed(px: number) {
  const node = rule(NODE_RULE);
  const frame = 2 * length(value(rule(".work-card"), "border"), px) + 2 * length(value(node, "padding"), px) + (rows.length - 1) * length(value(node, "gap"), px);
  return rows.reduce((sum, row) => {
    const d = rule(row.selector);
    expect(value(d, "line-height"), `the ${row.name} row sets its line height, so the card's height doesn't hang on the font`).toBeDefined();
    const clamp = value(d, "line-clamp");
    if (!clamp) expect([value(d, "white-space"), value(d, "flex-wrap")], `the ${row.name} row keeps to one line`).toContain("nowrap");
    expect(value(d, "flex") ?? value(rule(`${NODE_RULE} > *`), "flex"), `the ${row.name} row doesn't shrink`).toBe("none");
    if (row.icon) expect(length(value(d, "line-height"), px), `the ${row.name} row is as tall as its icon`).toBeGreaterThanOrEqual((row.icon * px) / 14);
    return sum + Number(clamp ?? 1) * length(value(d, "line-height"), px);
  }, frame);
}

describe("the Graph view's cards", () => {
  const face = (id: string, links: BoardTask["links"]): BoardTask => ({
    ...card(id, 0),
    title: "Build and validate the detection rule pack for the lab firewall",
    body: "## Objective Compare every switch against the vendor's latest firmware.",
    assignee: "threat-detection-engineer",
    priority: 10,
    tenant: "homelab",
    links,
  });
  const tasks = [face("a", { parents: 0, children: 2 }), face("b", { parents: 1, children: 0 }), face("c", { parents: 1, children: 0 })];
  const loadTask = async (id: string): Promise<TaskDetail> => ({
    task: tasks.find((t) => t.id === id)!,
    comments: [],
    links: id === "a" ? { parents: [], children: ["b", "c"] } : { parents: ["a"], children: [] },
    linked: [],
  });

  it.each(UI_SIZES)("hold every row of text whole, one above another, at the %ipx interface size", async (px) => {
    render(<WorkGraph tasks={tasks} api={{ loadTask }} refreshed={0} onOpen={() => {}} />);
    await act(async () => {});
    const box = (id: string) => {
      const el = [...document.querySelectorAll<HTMLElement>(".work-node")].find((n) => n.querySelector("code")?.textContent === id)!;
      return { top: atSize(el.style.top, px), height: atSize(el.style.height, px) };
    };
    const [b, c] = [box("b"), box("c")];
    expect(b.height).toBeGreaterThanOrEqual(needed(px));
    expect(c.top - b.top, "the next card in the column starts below this one").toBeGreaterThanOrEqual(b.height);
  });
});
