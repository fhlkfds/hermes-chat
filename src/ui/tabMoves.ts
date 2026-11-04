// Where a chat goes when it is dragged onto a pane, from the chat list or from a tab, or moved there from a tab's menu
// or the keyboard. One function decides every case, so a drag, its hint and its keyboard way can't disagree (ADR 0051).
import type { SplitDir } from "./Split";

export type Edge = "left" | "right" | "top" | "bottom";
/** "tab": the pane's tab strip, or its middle. An edge: that side of the pane. */
export type DropZone = "tab" | Edge;
export const EDGES: readonly Edge[] = ["right", "bottom", "left", "top"];
/** Where an edge puts something, said from the pane it is on. */
export const EDGE_SIDE: Record<Edge, string> = { right: "right of", left: "left of", bottom: "below", top: "above" };

/** What `moveTab` needs of a pane. Anything else on it is kept as it is. */
export type TabPane = { key: string; chatId: string | null; tabs: (string | null)[] };
/** The chat moved: `id`, from a tab in pane `from`, or from the chat list when `from` is left out. */
export type MovedChat = { id: string | null; from?: string };
/** Where it is dropped: on pane `pane`, at `zone`; on the tab strip, before the tab at `index` (the end if left out). */
export type TabDrop = { pane: string; zone: DropZone; index?: number };
/** The panes after a move, in order (left or top first), which way they are split, and the pane that becomes active. */
export type Moved<P> = { panes: P[]; dir: SplitDir; active: string };

const edgeDir = (e: Edge): SplitDir => (e === "left" || e === "right" ? "row" : "column");
const afterEdge = (e: Edge) => e === "right" || e === "bottom";

/** `tabs` with `id` put before the tab at `at`, moved there if it is in already. Left out, `at` keeps a tab that's in
 * where it is and puts a new one at the end. */
export const insertTab = (tabs: (string | null)[], id: string | null, at?: number) => {
  const was = tabs.indexOf(id);
  if (at === undefined) return was < 0 ? [...tabs, id] : tabs;
  const rest = tabs.filter((t) => t !== id);
  const to = Math.max(0, Math.min(rest.length, was >= 0 && was < at ? at - 1 : at));
  return [...rest.slice(0, to), id, ...rest.slice(to)];
};

/** The pane once `id`'s tab leaves it: it shows the tab after, or before; with none left, a New chat tab. */
const without = <P extends TabPane>(p: P, id: string | null): P => {
  const at = p.tabs.indexOf(id);
  const tabs = p.tabs.filter((t) => t !== id);
  if (!tabs.length) return { ...p, tabs: [null], chatId: null };
  return { ...p, tabs, chatId: p.chatId === id ? tabs[Math.min(at, tabs.length - 1)] : p.chatId };
};

const sameLayout = <P extends TabPane>(a: P[], dirA: SplitDir, b: Moved<P>) =>
  a.length === b.panes.length &&
  (a.length === 1 || dirA === b.dir) &&
  a.every((p, i) => {
    const q = b.panes[i];
    return p.key === q.key && p.chatId === q.chatId && p.tabs.length === q.tabs.length && p.tabs.every((t, j) => t === q.tabs[j]);
  });

/**
 * The panes once `moved` is dropped at `drop`, or `null` when the drop would change nothing or isn't allowed.
 *
 * - A tab is moved, never copied: it leaves the pane it was in. A chat from the list is opened.
 * - On a tab strip, the chat gets a tab before `index`, or keeps the one it has there; on its own strip a tab moves
 *   along it. A pane left without tabs closes when there are two; the only pane keeps a New chat tab.
 * - On an edge with one pane, the chat area splits that way with the chat in the new pane on that side.
 * - On an edge with two panes, the panes turn that way, and the chat is shown in the pane on that side of the one it
 *   was dropped on: the other pane. A pane's only tab dropped on an edge moves its whole pane to that side instead.
 * - The New chat tab only moves along its own strip. The moved chat is shown, and its pane becomes the active one.
 *
 * `newPane` makes the pane a split opens, showing the chat.
 */
export function moveTab<P extends TabPane>(panes: P[], dir: SplitDir, moved: MovedChat, drop: TabDrop, newPane: (chatId: string) => P): Moved<P> | null {
  const { id, from } = moved;
  const target = panes.find((p) => p.key === drop.pane);
  const source = from === undefined ? undefined : panes.find((p) => p.key === from);
  if (!target || (from !== undefined && !source?.tabs.includes(id))) return null;
  const show = (p: P, tabs: (string | null)[]): P => ({ ...p, tabs, chatId: id });
  const swap = (a: P, b: P) => panes.map((p) => (p.key === a.key ? b : p));
  let out: Moved<P>;

  if (drop.zone === "tab") {
    if (source === target) {
      // Along its own strip. Dropped where it is, or on its own pane's middle, it stays, and isn't picked either.
      if (drop.index === undefined) return null;
      const tabs = insertTab(target.tabs, id, drop.index);
      if (tabs.every((t, i) => t === target.tabs[i])) return null;
      out = { panes: swap(target, show(target, tabs)), dir, active: target.key };
    } else {
      if (id === null) return null;
      let ps = panes;
      // Its last tab gone, the other pane closes: the chat merges into the pane it was dropped on.
      if (source) ps = source.tabs.length === 1 ? ps.filter((p) => p !== source) : ps.map((p) => (p === source ? without(source, id) : p));
      const t = ps.find((p) => p.key === target.key)!;
      out = { panes: ps.map((p) => (p === t ? show(t, insertTab(t.tabs, id, drop.index)) : p)), dir, active: t.key };
    }
  } else {
    if (id === null) return null;
    const edge = drop.zone;
    const d = edgeDir(edge);
    // The pane showing the chat goes on the edge's side of the other one.
    const place = (shows: P, other: P) => (afterEdge(edge) ? [other, shows] : [shows, other]);
    if (panes.length === 1) {
      const n = newPane(id);
      out = { panes: place(n, source ? without(target, id) : target), dir: d, active: n.key };
    } else {
      const other = panes.find((p) => p !== target)!;
      if (source === target && target.tabs.length === 1) {
        // Its only tab: the pane itself moves to that side.
        out = { panes: place(target, other), dir: d, active: target.key };
      } else {
        const left = source === target ? without(target, id) : target;
        out = { panes: place(show(other, insertTab(other.tabs, id)), left), dir: d, active: other.key };
      }
    }
  }
  return sameLayout(panes, dir, out) ? null : out;
}

/** What the hint over a pane says a drop will do. With two panes an edge is said from the pane under the pointer, as
 * the hint covers that pane's half on that side: the chat goes beside it there, or its pane goes there when the chat
 * is the pane's only tab. `before`: the panes before the drop. */
export function dropLabel<P extends TabPane>(before: P[], moved: MovedChat, drop: TabDrop) {
  if (drop.zone === "tab") return moved.from === undefined ? "Open in a new tab" : moved.from === drop.pane ? "Move the tab here" : "Move to this pane";
  const way = { right: "right", left: "left", bottom: "down", top: "up" }[drop.zone];
  if (before.length === 1) return `Split ${way}`;
  const source = before.find((p) => p.key === moved.from);
  if (source?.key === drop.pane && source.tabs.length === 1) return `Move this pane ${way}`;
  const side = EDGE_SIDE[drop.zone];
  return `${moved.from === undefined ? "Open" : "Move"} ${side} this pane`;
}

/** Two layouts that look the same: the same panes, in the same order and direction, with the same tabs shown. */
export const sameMove = <P extends TabPane>(a: Moved<P>, b: Moved<P>) => sameLayout(a.panes, a.dir, b);
