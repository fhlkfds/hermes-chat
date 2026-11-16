// The Work page's graph of the current board (issue #604, ADR 0179): which cards wait on which, laid out from the
// cards Hermes waits on at the left to the cards that wait on them at the right. No route lists a board's links, so
// each linked card's own links come from `GET tasks/{id}`, read again only when the board's counts or status for that
// card change. Everything here is pure; the page does the reads.
import type { BoardTask, LinkedTask, TaskLinks } from "./kanban";

/** A dependency link: `child` waits on `parent`. */
export type Edge = { parent: string; child: string };

/** One card's links as `GET tasks/{id}` read them, under the board values `key` names (`readKey`). */
export type LinkRead = { key: string; links: TaskLinks; linked: LinkedTask[] };

/**
 * The board values a link read stays good for. A link added or removed changes both ends' counts, so a read is kept
 * until they change. A link swapped for another elsewhere keeps the counts, and shows only after Refresh.
 */
export const readKey = (t: BoardTask) => `${t.links.parents}:${t.links.children}:${t.status}`;

const linked = (t: BoardTask) => t.links.parents + t.links.children > 0;

/** The cards whose links need reading: linked on the board, with no read under their present values. */
export const toRead = (tasks: readonly BoardTask[], reads: ReadonlyMap<string, LinkRead>): string[] =>
  tasks.filter((t) => linked(t) && reads.get(t.id)?.key !== readKey(t)).map((t) => t.id);

/** A card in the graph. `task` is none for a ghost: a linked task not on this board, such as an archived one. */
export type GraphNode = { id: string; title: string; status: string; task?: BoardTask };

/** `nodes`: board order, then ghosts by id. `loose`: the board's cards with no links, shown apart. */
export type Graph = { nodes: GraphNode[]; edges: Edge[]; loose: BoardTask[] };

/**
 * The graph the reads draw. A card's read counts while the board still shows it linked, so a read under older values
 * stands until the next one lands rather than the card jumping out and back. A linked card not read yet is a node
 * with no edges.
 */
export function graphOf(tasks: readonly BoardTask[], reads: ReadonlyMap<string, LinkRead>): Graph {
  const edges = new Map<string, Edge>();
  const names = new Map<string, LinkedTask>();
  const add = (parent: string, child: string) => edges.set(`${parent}\n${child}`, { parent, child });
  for (const t of tasks) {
    const read = linked(t) ? reads.get(t.id) : undefined;
    if (!read) continue;
    for (const p of read.links.parents) add(p, t.id);
    for (const c of read.links.children) add(t.id, c);
    for (const l of read.linked) names.set(l.id, l);
  }
  const ends = new Set([...edges.values()].flatMap((e) => [e.parent, e.child]));
  const onBoard = new Set(tasks.map((t) => t.id));
  const nodes: GraphNode[] = tasks.filter((t) => linked(t) || ends.has(t.id)).map((t) => ({ id: t.id, title: t.title, status: t.status, task: t }));
  for (const id of [...ends].filter((id) => !onBoard.has(id)).sort()) {
    const named = names.get(id);
    nodes.push({ id, title: named?.title ?? id, status: named?.status ?? "" });
  }
  return { nodes, edges: [...edges.values()], loose: tasks.filter((t) => !linked(t) && !ends.has(t.id)) };
}

/**
 * Layers, left to right: each card one past the furthest card it waits on, and each layer ordered once by the mean
 * place of its cards' parents. Hermes refuses a loop, but should one come, its cards go in a last layer of their own.
 */
export function layout(ids: readonly string[], edges: readonly Edge[]): string[][] {
  const known = new Set(ids);
  const parents = new Map(ids.map((id) => [id, [] as string[]]));
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges)
    if (known.has(e.parent) && known.has(e.child) && e.parent !== e.child) {
      parents.get(e.child)!.push(e.parent);
      children.get(e.parent)!.push(e.child);
    }
  const depth = new Map<string, number>();
  const waiting = new Map(ids.map((id) => [id, parents.get(id)!.length]));
  const queue = ids.filter((id) => !waiting.get(id));
  for (const id of queue) depth.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const at = depth.get(queue[i])!;
    for (const c of children.get(queue[i])!) {
      depth.set(c, Math.max(depth.get(c) ?? 0, at + 1));
      waiting.set(c, waiting.get(c)! - 1);
      if (!waiting.get(c)) queue.push(c);
    }
  }
  const ordered = new Set(queue);
  const last = queue.length ? Math.max(...queue.map((id) => depth.get(id)!)) + 1 : 0;
  const layers: string[][] = [];
  for (const id of ids) (layers[ordered.has(id) ? depth.get(id)! : last] ??= []).push(id);
  const placed = new Map<string, number>();
  layers.forEach((layer, i) => {
    const keyed = layer.map((id, j) => {
      const ps = i ? parents.get(id)!.filter((p) => placed.has(p)) : [];
      return { id, key: ps.length ? ps.reduce((sum, p) => sum + placed.get(p)!, 0) / ps.length : j };
    });
    keyed.sort((a, b) => a.key - b.key);
    layer.splice(0, layer.length, ...keyed.map((k) => k.id));
    layer.forEach((id, j) => placed.set(id, j));
  });
  return layers.filter(Boolean);
}

/** A card's size and the gaps between cards in the drawn graph, in CSS pixels. */
export const NODE = { width: 184, height: 84, gapX: 44, gapY: 16 };

/** Where each card sits, its top left corner, and the size of the whole drawing. */
export function place(layers: readonly string[][]): { at: Map<string, { x: number; y: number }>; width: number; height: number } {
  const at = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, i) => layer.forEach((id, j) => at.set(id, { x: i * (NODE.width + NODE.gapX), y: j * (NODE.height + NODE.gapY) })));
  const tallest = Math.max(0, ...layers.map((l) => l.length));
  return {
    at,
    width: layers.length ? layers.length * NODE.width + (layers.length - 1) * NODE.gapX : 0,
    height: tallest ? tallest * NODE.height + (tallest - 1) * NODE.gapY : 0,
  };
}

/** The SVG path of an arrow from the right of `from` to the left of `to`. */
export function arrow(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const x1 = from.x + NODE.width;
  const y1 = from.y + NODE.height / 2;
  const x2 = to.x;
  const y2 = to.y + NODE.height / 2;
  const bend = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
