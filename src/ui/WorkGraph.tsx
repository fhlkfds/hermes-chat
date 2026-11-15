// The Work page's Graph view (issue #604, ADR 0177): the current board's cards with an arrow from each card to the
// cards that wait on it. Each linked card's links are read from its task (workGraph.ts says when), and a link to a
// task not on the board ends at a dashed ghost.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { BoardTask, KanbanApi } from "../hermes/kanban";
import { arrow, graphOf, layout, place, readKey, toRead, type LinkRead } from "../hermes/workGraph";
import { errorText, plural } from "../hermes/values";
import { CardFace } from "./WorkPlan";

/** How many tasks are read at once. */
const AT_ONCE = 4;

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

  useEffect(() => {
    gen.current++;
    setReads(new Map());
    setFailed(new Map());
  }, [refreshed]);

  // A card whose read failed waits for its counts or status to change, or for Refresh.
  const failing = tasks.filter((t) => failed.get(t.id)?.key === readKey(t));
  const due = toRead(tasks, reads).filter((id) => !failing.some((t) => t.id === id));
  const dueKey = due.join(" ");
  useEffect(() => {
    if (!due.length) return;
    const mine = gen.current;
    const keys = new Map(due.map((id) => [id, readKey(tasks.find((t) => t.id === id)!)]));
    const queue = [...keys.keys()];
    const one = async (): Promise<void> => {
      const id = queue.shift();
      if (!id) return;
      const key = keys.get(id)!;
      try {
        const d = await apiRef.current.loadTask(id);
        if (mine === gen.current) setReads((r) => new Map(r).set(id, { key, links: d.links, linked: d.linked }));
      } catch (e) {
        if (mine === gen.current) setFailed((f) => new Map(f).set(id, { key, why: errorText(e) }));
      }
      return one();
    };
    void Promise.all(Array.from({ length: AT_ONCE }, one));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dueKey` names the cards to read; the rest is read as of now
  }, [dueKey, refreshed]);

  const g = graphOf(tasks, reads);
  const layers = layout(
    g.nodes.map((n) => n.id),
    g.edges,
  );
  const { at, width, height } = place(layers);
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
          <div className="work-graph" style={{ width, height }}>
            <svg className="work-edges" width={width} height={height} aria-hidden="true">
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
              const style = { left: pos.x, top: pos.y };
              return n.task ? (
                <div key={id} className="work-card work-node" role="button" tabIndex={0} style={style} title={n.task.body || n.task.title} onClick={() => onOpen(id)} onKeyDown={opensOnKey(() => onOpen(id))}>
                  <CardFace t={n.task} />
                  <span className="work-status work-node-status">{n.status}</span>
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
