// Where a dragged chat lands (tabMoves.ts), case by case, without the app around it.
import { describe, expect, it } from "vitest";
import { dropLabel, insertTab, moveTab, type MovedChat, type TabDrop, type TabPane } from "./tabMoves";
import { zoneAt } from "./Tabs";
import type { SplitDir } from "./Split";

const pane = (key: string, tabs: (string | null)[], chatId = tabs[0]): TabPane => ({ key, tabs, chatId });
const newPane = (chatId: string) => pane("N", [chatId]);
const move = (panes: TabPane[], moved: MovedChat, drop: TabDrop, dir: SplitDir = "row") => moveTab(panes, dir, moved, drop, newPane);
/** The panes as `key:tab,tab*` with the shown tab starred, for short expectations. */
const show = (out: ReturnType<typeof move>) =>
  out && { dir: out.dir, active: out.active, panes: out.panes.map((p) => `${p.key}:${p.tabs.map((t) => `${t ?? "new"}${t === p.chatId ? "*" : ""}`).join(",")}`) };

describe("insertTab", () => {
  it("puts a tab before an index, moving one that is in already", () => {
    expect(insertTab(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(insertTab(["a", "b", "c"], "a", 3)).toEqual(["b", "c", "a"]);
    expect(insertTab(["a", "b", "c"], "a", 2)).toEqual(["b", "a", "c"]);
    expect(insertTab(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
    expect(insertTab(["a", "b"], "x")).toEqual(["a", "b", "x"]);
    expect(insertTab(["a", "b"], "b")).toEqual(["a", "b"]);
  });
});

describe("a tab along its own strip", () => {
  const one = [pane("A", ["a", "b", "c"])];
  it("moves to where it is dropped and is shown", () => {
    expect(show(move(one, { id: "c", from: "A" }, { pane: "A", zone: "tab", index: 0 }))).toEqual({ dir: "row", active: "A", panes: ["A:c*,a,b"] });
    expect(show(move(one, { id: "a", from: "A" }, { pane: "A", zone: "tab", index: 3 }))!.panes).toEqual(["A:b,c,a*"]);
  });
  it("does nothing dropped where it is, or on its own pane's middle", () => {
    expect(move(one, { id: "a", from: "A" }, { pane: "A", zone: "tab", index: 0 })).toBeNull();
    expect(move(one, { id: "a", from: "A" }, { pane: "A", zone: "tab", index: 1 })).toBeNull();
    expect(move(one, { id: "b", from: "A" }, { pane: "A", zone: "tab" })).toBeNull();
    // Past the end is the end: the last tab stays, and a tab not shown isn't picked by it.
    expect(move(one, { id: "c", from: "A" }, { pane: "A", zone: "tab", index: 4 })).toBeNull();
  });
  it("lets the New chat tab move along its strip, and nowhere else", () => {
    const withNew = [pane("A", ["a", null], null), pane("B", ["b"])];
    expect(show(move(withNew, { id: null, from: "A" }, { pane: "A", zone: "tab", index: 0 }))!.panes).toEqual(["A:new*,a", "B:b*"]);
    expect(move(withNew, { id: null, from: "A" }, { pane: "B", zone: "tab" })).toBeNull();
    expect(move(withNew, { id: null, from: "A" }, { pane: "A", zone: "right" })).toBeNull();
  });
});

describe("a tab out of the only pane", () => {
  const one = [pane("A", ["a", "b", "c"], "b")];
  it.each([
    ["right", "row", ["A:a,c*", "N:b*"]],
    ["left", "row", ["N:b*", "A:a,c*"]],
    ["bottom", "column", ["A:a,c*", "N:b*"]],
    ["top", "column", ["N:b*", "A:a,c*"]],
  ] as const)("splits %s, and the tab moves into the new pane", (zone, dir, panes) => {
    expect(show(move(one, { id: "b", from: "A" }, { pane: "A", zone }))).toEqual({ dir, active: "N", panes });
  });
  it("leaves a New chat tab behind when it was the pane's only tab", () => {
    expect(show(move([pane("A", ["a"])], { id: "a", from: "A" }, { pane: "A", zone: "right" }))!.panes).toEqual(["A:new*", "N:a*"]);
  });
  it("keeps the pane's tabs for a chat from the list, which opens beside it", () => {
    expect(show(move(one, { id: "x" }, { pane: "A", zone: "left" }))!.panes).toEqual(["N:x*", "A:a,b*,c"]);
    expect(show(move(one, { id: "x" }, { pane: "A", zone: "tab", index: 1 }))!.panes).toEqual(["A:a,x*,b,c"]);
  });
});

describe("a tab between two panes", () => {
  const two = () => [pane("A", ["a", "b"], "b"), pane("B", ["c"])];
  it("moves onto the other pane's strip, before the tab it is dropped at", () => {
    expect(show(move(two(), { id: "b", from: "A" }, { pane: "B", zone: "tab", index: 0 }))).toEqual({ dir: "row", active: "B", panes: ["A:a*", "B:b*,c"] });
  });
  it("closes the pane it leaves empty, merging into the other", () => {
    expect(show(move(two(), { id: "c", from: "B" }, { pane: "A", zone: "tab" }))).toEqual({ dir: "row", active: "A", panes: ["A:a,b,c*"] });
  });
  it("leaves no copy when the other pane has the chat already", () => {
    const both = [pane("A", ["a", "b"], "b"), pane("B", ["b", "c"], "c")];
    expect(show(move(both, { id: "b", from: "A" }, { pane: "B", zone: "tab" }))!.panes).toEqual(["A:a*", "B:b*,c"]);
  });
  it.each([
    ["right", "row", ["A:a*", "B:c,b*"]],
    ["bottom", "column", ["A:a*", "B:c,b*"]],
    ["left", "row", ["B:c,b*", "A:a*"]],
    ["top", "column", ["B:c,b*", "A:a*"]],
  ] as const)("on its own pane's %s edge, goes to the other pane, put on that side", (zone, dir, panes) => {
    expect(show(move(two(), { id: "b", from: "A" }, { pane: "A", zone }))).toEqual({ dir, active: "B", panes });
  });
  it("moves its whole pane to an edge's side when it is the pane's only tab", () => {
    expect(show(move(two(), { id: "c", from: "B" }, { pane: "B", zone: "top" }))).toEqual({ dir: "column", active: "B", panes: ["B:c*", "A:a,b*"] });
    expect(show(move(two(), { id: "c", from: "B" }, { pane: "A", zone: "left" }))).toEqual({ dir: "row", active: "B", panes: ["B:c*", "A:a,b*"] });
    // Already on that side: nothing to do.
    expect(move(two(), { id: "c", from: "B" }, { pane: "B", zone: "right" })).toBeNull();
  });
  it("only turns the panes for a tab dropped on the pane across from its own", () => {
    expect(show(move(two(), { id: "c", from: "B" }, { pane: "A", zone: "bottom" }))).toEqual({ dir: "column", active: "B", panes: ["A:a,b*", "B:c*"] });
    expect(move(two(), { id: "c", from: "B" }, { pane: "A", zone: "right" })).toBeNull();
  });
  it("opens a chat from the list in the pane on the edge's side", () => {
    expect(show(move(two(), { id: "x" }, { pane: "B", zone: "right" }))).toEqual({ dir: "row", active: "A", panes: ["B:c*", "A:a,b,x*"] });
    expect(show(move(two(), { id: "x" }, { pane: "A", zone: "bottom" }), )!.panes).toEqual(["A:a,b*", "B:c,x*"]);
  });
  it("refuses a tab its pane doesn't have, or an unknown pane", () => {
    expect(move(two(), { id: "c", from: "A" }, { pane: "B", zone: "tab" })).toBeNull();
    expect(move(two(), { id: "x" }, { pane: "Z", zone: "tab" })).toBeNull();
  });
});

describe("the drop hint", () => {
  it("says split with one pane, and with two says where from the pane under the pointer", () => {
    const one = [pane("A", ["a", "b"])];
    expect(["right", "left", "bottom", "top"].map((zone) => dropLabel(one, { id: "b", from: "A" }, { pane: "A", zone: zone as TabDrop["zone"] }))).toEqual([
      "Split right",
      "Split left",
      "Split down",
      "Split up",
    ]);
    const two = [pane("A", ["a", "b"]), pane("B", ["c"])];
    expect(dropLabel(two, { id: "b", from: "A" }, { pane: "A", zone: "left" })).toBe("Move left of this pane");
    expect(dropLabel(two, { id: "b", from: "A" }, { pane: "B", zone: "bottom" })).toBe("Move below this pane");
    expect(dropLabel(two, { id: "x" }, { pane: "B", zone: "top" })).toBe("Open above this pane");
    // A pane's only tab on its own pane's edge moves the pane.
    expect(dropLabel(two, { id: "c", from: "B" }, { pane: "B", zone: "top" })).toBe("Move this pane up");
    expect(dropLabel(two, { id: "c", from: "B" }, { pane: "A", zone: "right" })).toBe("Move right of this pane");
    expect(dropLabel(two, { id: "b", from: "A" }, { pane: "B", zone: "tab" })).toBe("Move to this pane");
    expect(dropLabel(two, { id: "x" }, { pane: "B", zone: "tab" })).toBe("Open in a new tab");
  });
});

describe("drop zones over a pane", () => {
  it("are the quarter by each edge, the nearest edge at a corner, and the middle", () => {
    expect(zoneAt(0.1, 0.5)).toBe("left");
    expect(zoneAt(0.9, 0.5)).toBe("right");
    expect(zoneAt(0.5, 0.1)).toBe("top");
    expect(zoneAt(0.5, 0.9)).toBe("bottom");
    expect(zoneAt(0.5, 0.5)).toBe("tab");
    expect(zoneAt(0.74, 0.26)).toBe("tab");
    expect(zoneAt(0.95, 0.85)).toBe("right");
    expect(zoneAt(0.85, 0.95)).toBe("bottom");
    expect(zoneAt(0.05, 0.1)).toBe("left");
  });
});
