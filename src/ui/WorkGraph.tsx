// The Work page's Graph view (issue #604, ADR 0179): the current board's cards with an arrow from each card to the
// cards that wait on it. Each linked card's links are read from its task (workGraph.ts says when), and a link to a
// task not on the board ends at a dashed ghost.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { BoardTask, KanbanApi } from "../hermes/kanban";
import { NODE, arrow, graphOf, layout, place, readKey, toRead, type LinkRead } from "../hermes/workGraph";
import { errorText, plural } from "../hermes/values";
import { CardFace } from "./WorkPlan";

/** How many tasks are read at once. */
const AT_ONCE = 4;

/** A length in the graph's own pixels, grown with the interface size as the cards' text is. */
const scaled = (n: number) => `calc(${n}px * var(--ui-scale, 1))`;

/** Enter and Space open a card that is a `div` with the button role. */
export const opensOnKey = (open: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    open();
  }
};

/**
 * `refreshed`: counts the owner's Refreshes, each of which drops every read, since a link swapped for another keeps
 * the board's counts as they were.
 */
export function WorkGraph({ tasks, api, refreshed, onOpen }: { tasks: BoardTask[]; api: Pick<KanbanApi, "loadTask">; refreshed: number; onOpen: (id: string) => void }) {
  const [reads, setReads] = useState<ReadonlyMap<string, LinkRead>>(new Map());
  /** Each card whose read failed: the board values it failed under, and why. */
  const [failed, setFailed] = useState<ReadonlyMap<string, { key: string; why: string }>>(new Map());
  const gen = useRef(0);
  const marker = useId();
  const apiRef = useRef(api);
  apiRef.current = api;

  // One queue for the whole view, at most `AT_ONCE` reads out and one per card. A card whose counts or status change
  // while its read is out is read again once that read ends, under its new values.
  const queue = useRef<{ id: string; key: string }[]>([]);
  /** Each card with a read out in this generation, and the values it was asked under. */
  const out = useRef(new Map<string, string>());
  /** Drops every read, and every read still out: their answers are ignored, and their cards are asked again. */
  const restart = () => {
    gen.current++;
    queue.current = [];
    out.current = new Map();
  };

  useEffect(() => {
    restart();
    setReads(new Map());
    setFailed(new Map());
  }, [refreshed]);
  useEffect(() => restart, []);

  // A card whose read failed waits for its counts or status to change, or for Refresh.
  const failing = tasks.filter((t) => failed.get(t.id)?.key === readKey(t));
  const due = toRead(tasks, reads)
    .filter((id) => !failing.some((t) => t.id === id))
    .map((id) => ({ id, key: readKey(tasks.find((t) => t.id === id)!) }));
  const dueKey = due.map((d) => `${d.id}@${d.key}`).join(" ");

  const pump = () => {
    while (out.current.size < AT_ONCE) {
      const next = queue.current.findIndex((q) => !out.current.has(q.id));
      if (next < 0) return;
      const [{ id, key }] = queue.current.splice(next, 1);
      const mine = gen.current;
      out.current.set(id, key);
      apiRef.current
        .loadTask(id)
        .then(
          (d) => mine === gen.current && setReads((r) => new Map(r).set(id, { key, links: d.links, linked: d.linked })),
          (e) => mine === gen.current && setFailed((f) => new Map(f).set(id, { key, why: errorText(e) })),
        )
        .finally(() => {
          if (mine !== gen.current) return;
          out.current.delete(id);
          queue.current = queue.current.filter((q) => q.id !== id || q.key !== key);
          pump();
        });
    }
  };
  useEffect(() => {
    queue.current = due.filter((d) => out.current.get(d.id) !== d.key);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dueKey` names each card to read and the values it's read under
  }, [dueKey, refreshed]);

  const g = graphOf(tasks, reads);
  const layers = layout(
    g.nodes.map((n) => n.id),
    g.edges,
  );
  const { at, width, height: drawn } = place(layers);
  // Room under the last row for an arrow that skips a layer in a graph one row tall.
  const height = drawn + NODE.gapY;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;

  return (
    <div className="work-graph-view">
      {failing.length > 0 && (
        <p className="work-err" role="alert">
          Couldn't read the links of {plural(failing.length, "card")}: {failed.get(failing[0].id)!.why}. Refresh to try again.
        </p>
      )}
      {g.nodes.length ? (
        <div className="work-graph-scroll">
          <div className="work-graph" style={{ width: scaled(width), height: scaled(height) }}>
            <svg className="work-edges" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              <defs>
                <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {g.edges.map((e) => (
                <path key={`${e.parent} ${e.child}`} data-edge={`${e.parent} ${e.child}`} d={arrow(at.get(e.parent)!, at.get(e.child)!)} markerEnd={`url(#${marker})`} />
              ))}
            </svg>
            {layers.flat().map((id) => {
              const n = byId.get(id)!;
              const pos = at.get(id)!;
              const waits = g.edges.filter((e) => e.child === id).map((e) => titleOf(e.parent));
              const then = g.edges.filter((e) => e.parent === id).map((e) => titleOf(e.child));
              const said = [waits.length && `Waits on ${waits.join(", ")}.`, then.length && `Then ${then.join(", ")}.`].filter(Boolean).join(" ");
              const style = { left: scaled(pos.x), top: scaled(pos.y), width: scaled(NODE.width), height: scaled(NODE.height) };
              return n.task ? (
                <div key={id} className="work-card work-node" role="button" tabIndex={0} style={style} title={n.task.body || n.task.title} onClick={() => onOpen(id)} onKeyDown={opensOnKey(() => onOpen(id))}>
                  <CardFace t={n.task} status={n.status} />
                  {said && <span className="sr-only">{said}</span>}
                </div>
              ) : (
                <div key={id} className="work-card work-node ghost" style={style} title="Not on this board, such as an archived card">
                  <div className="work-meta">
                    <code>{id}</code>
                  </div>
                  <b className="work-title">{n.title}</b>
                  <small className="muted">{n.status ? `${n.status}, not on this board` : "Not on this board"}</small>
                  {said && <span className="sr-only">{said}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="work-empty">No card on this board waits on another yet. Open a card to link it.</p>
      )}
      {g.loose.length > 0 && (
        <section className="work-loose" aria-label="Not linked">
          <h2 className="work-column-head">
            <span>Not linked</span>
            <span className="work-count">{g.loose.length}</span>
          </h2>
          <div className="work-loose-cards">
            {g.loose.map((t) => (
              <div key={t.id} className="work-card" role="button" tabIndex={0} title={t.body || t.title} onClick={() => onOpen(t.id)} onKeyDown={opensOnKey(() => onOpen(t.id))}>
                <CardFace t={t} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
