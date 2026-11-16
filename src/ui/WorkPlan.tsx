// Planning on the Work page (issue #604, ADR 0177): a card's face, the dispatch line, the token guess, and the task
// sheet's links and bot and model pickers. Every write here is previewed, refused when the task changed since the sheet
// showed it, sent once, and read back before the section unlocks (ADR 0014, ADR 0171).
import { useEffect, useRef, useState } from "react";
import { Cpu, TriangleAlert, User, X } from "lucide-react";
import {
  isOpen,
  refused,
  sameLinks,
  type BoardTask,
  type BotProfile,
  type Estimate,
  type KanbanApi,
  type LinkedTask,
  type ModelPick,
  type ModelProvider,
  type Orchestration,
  type TaskDetail,
  type TaskLinks,
} from "../hermes/kanban";
import { errorText } from "../hermes/values";
import { Spinner } from "./bits";

/** The parts of the page that each need a route an older kanban plugin may lack. */
export type WorkFeature = "links" | "pickers" | "estimate" | "dispatch";

/** A card as the board and the graph show it. */
export function CardFace({ t }: { t: BoardTask }) {
  return (
    <>
      <div className="work-meta">
        <code>{t.id}</code>
        {t.priority !== 0 && <span>P{t.priority}</span>}
        {t.tenant && <span>{t.tenant}</span>}
      </div>
      <b className="work-title">{t.title}</b>
      {t.status === "blocked" && t.summary ? (
        <p className="work-why">
          <TriangleAlert size={13} /> {t.summary}
        </p>
      ) : (
        t.body && <p className="work-body">{t.body}</p>
      )}
      {(t.assignee || t.model) && (
        <small className="work-assignee">
          {t.assignee && (
            <>
              <User size={13} /> <span>{t.assignee}</span>
            </>
          )}
          {t.model && (
            <span className="work-model" title={t.provider ? `${t.model} from ${t.provider}` : t.model}>
              <Cpu size={13} /> <span>{t.model}</span>
            </span>
          )}
        </small>
      )}
    </>
  );
}

/** The dispatch settings as last read: hidden when the plugin has no such route. */
export type DispatchRead = { kind: "reading" } | { kind: "read"; o: Orchestration } | { kind: "unsupported" } | { kind: "failed"; why: string };

/**
 * What this server does with cards on its own, from `GET orchestration`. It never says cards wait for the owner: the
 * dispatcher starts any ready card with a bot, whatever these settings say.
 */
export function DispatchLine({ read }: { read: DispatchRead }) {
  if (read.kind === "unsupported") return null;
  const said =
    read.kind === "read"
      ? [
          read.o.autoDecompose ? "Hermes splits triage cards into linked cards on its own." : "Triage cards wait until someone moves them.",
          read.o.autoPromoteChildren ? "A split's cards that wait on no other open card are made ready at once; the rest wait until those cards are done." : "A split's cards wait in todo until the dispatcher's next tick, which makes ready those that wait on no open card.",
        ]
      : [read.kind === "reading" ? "Reading how this server dispatches…" : `Couldn't read how this server dispatches: ${read.why}`];
  return (
    <p className="work-dispatch" role="status" title="From kanban.auto_decompose and kanban.auto_promote_children in the server's config">
      <b>Dispatch</b> {said.join(" ")} A ready card with a bot starts on the dispatcher's next tick (every 60 s by default) while the server's gateway
      runs it. <small className="muted">Set by kanban.auto_decompose and kanban.auto_promote_children.</small>
    </p>
  );
}

type Guess = { kind: "idle" } | { kind: "asking" } | { kind: "answered"; e: Estimate } | { kind: "failed"; why: string };

/**
 * Asks Hermes for a token guess and shows it. `text`: what it guesses from, so a guess for other text isn't shown. It
 * writes nothing, so it can be asked again at any time.
 */
export function EstimateBox({ ask, text, disabled }: { ask: () => Promise<Estimate>; text: string; disabled?: boolean }) {
  const [guess, setGuess] = useState<Guess>({ kind: "idle" });
  const asked = useRef(0);
  useEffect(() => {
    asked.current++;
    setGuess({ kind: "idle" });
  }, [text]);
  const run = async () => {
    const mine = ++asked.current;
    setGuess({ kind: "asking" });
    let next: Guess;
    try {
      next = { kind: "answered", e: await ask() };
    } catch (e) {
      next = { kind: "failed", why: errorText(e) };
    }
    if (mine === asked.current) setGuess(next);
  };
  return (
    <div className="work-estimate" aria-live="polite">
      {/* Not `disabled` while asking: a button that disables itself under focus drops focus out of the dialog, and Escape stops closing it. */}
      <button
        type="button"
        className="btn"
        disabled={disabled}
        aria-disabled={guess.kind === "asking"}
        onClick={() => guess.kind !== "asking" && void run()}
      >
        {guess.kind === "answered" ? "Estimate again" : "Estimate"}
      </button>
      {guess.kind === "asking" && (
        <span className="muted">
          <Spinner /> Asking Hermes for a token guess…
        </span>
      )}
      {guess.kind === "answered" &&
        (guess.e.ok ? (
          <div>
            <b>
              Token guess: about {guess.e.tokens.toLocaleString("en-US")} tokens{guess.e.size && `, size ${guess.e.size}`}
            </b>
            {guess.e.rationale && <p className="work-text">{guess.e.rationale}</p>}
            <small className="muted">A model's rough guess of tokens, not a cost.</small>
          </div>
        ) : (
          <span className="work-err">No token guess: {guess.e.reason}</span>
        ))}
      {guess.kind === "failed" && <span className="work-err">Couldn't ask for a token guess: {guess.why}</span>}
    </div>
  );
}

/**
 * One write from the sheet, from the owner's pick to Hermes's word on it. `unconfirmed`: it may have landed, so the
 * section stays locked until a read shows it did, or the owner sends it again, which can't do it twice.
 */
type Write<C> =
  | { kind: "idle"; note?: string }
  | { kind: "confirming"; change: C; preview?: string[] }
  | { kind: "writing"; change: C }
  | { kind: "unconfirmed"; change: C; why: string }
  | { kind: "failed"; why: string };

const busy = (w: Write<unknown>) => w.kind === "writing" || w.kind === "unconfirmed";

/** What the sheet hands its sections: the task as it shows it, and how to show a newer read of it. */
type SheetLink = {
  task: BoardTask;
  api: SheetApi;
  /** A read of the task taken here, for the sheet to show. */
  onRead: (d: TaskDetail) => void;
  /** A write landed: the board and the sheet read again. */
  onSaved: () => void;
  /** A write is on its way, so the board isn't read under it. */
  onWriting: (writing: boolean) => void;
};
export type SheetApi = Pick<KanbanApi, "loadTask" | "addLink" | "removeLink" | "editTask" | "setModel" | "assignees" | "profiles" | "modelOptions">;

/**
 * `child` waits on `parent`; the sheet's task is one of the two. `seen`: its links as the sheet showed them. `starts`:
 * the confirm said that removing the link makes `child` ready, so the dispatcher may start it.
 */
type LinkChange = { op: "add" | "remove"; parent: string; child: string; seen: TaskLinks; starts?: boolean };

/**
 * Whether removing `parent` makes a todo card ready at once: Hermes's `recompute_ready` promotes it when every other
 * card it waits on is done or archived. A card missing from `linked` is gone, and holds nothing up.
 */
const startsOnRemove = (childStatus: string, parents: string[], linked: LinkedTask[], parent: string) =>
  childStatus === "todo" && !parents.some((p) => p !== parent && isOpen(linked.find((l) => l.id === p)?.status ?? "done"));

/** Whether the task's read links show `c` done, from the side of the sheet's task `id`. */
const shows = (c: LinkChange, id: string, links: TaskLinks) => {
  const there = c.child === id ? links.parents.includes(c.parent) : links.children.includes(c.child);
  return c.op === "add" ? there : !there;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The sheet's links: the cards it waits on and the cards that wait on it, with Remove, and Add for a card to wait on.
 * Removing a todo card's last open parent makes Hermes set it ready at once, and the dispatcher may then start it, so
 * the confirm says so.
 */
export function LinksSection({
  task,
  api,
  onRead,
  onSaved,
  onWriting,
  links,
  linked,
  board,
}: SheetLink & {
  /** The task's links as last read; none before the first read. */
  links?: TaskLinks;
  linked: LinkedTask[];
  /** The board's cards, for titles and the cards to add. */
  board: BoardTask[];
}) {
  const [w, setW] = useState<Write<LinkChange>>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  // A read that shows a write which got no answer landed settles it.
  useEffect(() => {
    if (w.kind === "unconfirmed" && links && shows(w.change, task.id, links)) setW({ kind: "idle" });
  }, [w, links, task.id]);

  const named = (id: string) => board.find((t) => t.id === id) ?? linked.find((t) => t.id === id);
  const title = (id: string) => named(id)?.title || id;
  const status = (id: string) => named(id)?.status ?? "";

  const removePreview = (c: LinkChange) => [
    `${title(c.child)} stops waiting on ${title(c.parent)}.`,
    ...(c.starts
      ? [
          `${title(c.child)} waits on nothing else after this. Hermes makes it ready at once, and the dispatcher starts it on its next tick, about a minute, if it has a bot or this server sets kanban.default_assignee.`,
        ]
      : []),
  ];

  const confirm = async (op: "add" | "remove", parent: string, child: string) => {
    if (!links) return;
    if (op === "add") {
      const gate = task.status === "ready" && isOpen(status(parent)) ? [`${title(child)} is ready, so it goes back to todo until ${title(parent)} is done.`] : [];
      setW({ kind: "confirming", change: { op, parent, child, seen: links }, preview: [`${title(child)} will wait on ${title(parent)}.`, ...gate] });
      return;
    }
    if (child === task.id) {
      const change = { op, parent, child, seen: links, starts: startsOnRemove(task.status, links.parents, linked, parent) };
      setW({ kind: "confirming", change, preview: removePreview(change) });
      return;
    }
    // The other card's own read says whether this was the last card it waited on.
    const pending = { op, parent, child, seen: links };
    setW({ kind: "confirming", change: pending });
    try {
      const d = await api.loadTask(child);
      const change = { ...pending, starts: startsOnRemove(d.task.status, d.links.parents, d.linked, parent) };
      if (live.current) setW((was) => (was.kind === "confirming" && was.change === pending ? { kind: "confirming", change, preview: removePreview(change) } : was));
    } catch (e) {
      if (live.current) setW((was) => (was.kind === "confirming" && was.change === pending ? { kind: "failed", why: `Couldn't read ${title(child)}: ${errorText(e)}` } : was));
    }
  };

  // Set at once, before React re-renders: a second click on Confirm or Try again must not send a second write.
  const sending = useRef(false);
  const send = async (change: LinkChange) => {
    if (sending.current) return;
    sending.current = true;
    setW({ kind: "writing", change });
    onWriting(true);
    let sent = false;
    try {
      const before = await api.loadTask(task.id);
      if (!live.current) return;
      onRead(before);
      if (shows(change, task.id, before.links)) return setW({ kind: "idle", note: "That change is already there." });
      if (!sameLinks(before.links, change.seen)) return setW({ kind: "failed", why: "This card's links changed since the sheet showed them, so nothing was sent. Here they are now." });
      if (change.op === "remove") {
        // A parent may have finished since the confirm: if the card would now start, the owner hasn't been told.
        const child = change.child === task.id ? before : await api.loadTask(change.child);
        if (!live.current) return;
        const starts = startsOnRemove(child.task.status, child.links.parents, child.linked, change.parent);
        if (starts !== !!change.starts) {
          const now = { ...change, starts };
          return setW({ kind: "confirming", change: now, preview: [...removePreview(now), "This changed since you confirmed, so nothing was sent yet."] });
        }
      }
      sent = true;
      let note: string | undefined;
      if (change.op === "add") {
        if ((await api.addLink(change.parent, change.child)).gated) note = `${title(change.child)} went back to todo until ${title(change.parent)} is done.`;
      } else if (!(await api.removeLink(change.parent, change.child))) note = "That link was already gone.";
      for (let i = 0; i < 3; i++) {
        const after = await api.loadTask(task.id);
        if (!live.current) return;
        onRead(after);
        if (shows(change, task.id, after.links)) {
          setW({ kind: "idle", note });
          onSaved();
          return;
        }
        await pause(500);
      }
      setW({ kind: "unconfirmed", change, why: "Hermes took the change, but the card doesn't show it yet. Refresh to check." });
    } catch (e) {
      if (!live.current) return;
      if (!sent || refused(e)) setW({ kind: "failed", why: errorText(e) });
      else setW({ kind: "unconfirmed", change, why: `${errorText(e)}. It may have gone through: Refresh to check, or Try again, which can't make it twice.` });
    } finally {
      sending.current = false;
      onWriting(false);
    }
  };

  const locked = !links || busy(w) || w.kind === "confirming";
  const parents = links?.parents ?? [];
  const children = links?.children ?? [];
  const addable = board.filter((t) => t.id !== task.id && !parents.includes(t.id));
  const row = (id: string, parent: string, child: string) => (
    <li key={id}>
      <span className="work-link-title">{title(id)}</span>
      {status(id) && <span className="work-status">{status(id)}</span>}
      {!named(id) && <span className="muted small">not on this board</span>}
      <button className="icon-btn" title="Remove" aria-label={`Remove ${title(id)}`} disabled={locked} onClick={() => void confirm("remove", parent, child)}>
        <X size={14} />
      </button>
    </li>
  );

  return (
    <section className="work-plan" aria-label="Links">
      <h3 className="work-sub">Waits on</h3>
      {parents.length ? <ul className="work-links">{parents.map((p) => row(p, p, task.id))}</ul> : <p className="muted">{links ? "Nothing" : "Loading…"}</p>}
      <h3 className="work-sub">Then</h3>
      {children.length ? <ul className="work-links">{children.map((c) => row(c, task.id, c))}</ul> : <p className="muted">{links ? "Nothing waits on it" : "Loading…"}</p>}
      {task.status === "running" ? (
        <p className="muted small">A running card can't be made to wait on another card.</p>
      ) : (
        <select
          aria-label="Add a card it waits on"
          value=""
          disabled={locked || !addable.length}
          onChange={(e) => e.target.value && void confirm("add", e.target.value, task.id)}
        >
          <option value="">Add a card it waits on…</option>
          {addable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.status})
            </option>
          ))}
        </select>
      )}
      <WriteStatus
        w={w}
        onConfirm={(c) => void send(c)}
        onCancel={() => setW({ kind: "idle" })}
        verb={(c) => (c.op === "add" ? "Add link" : "Remove link")}
      />
    </section>
  );
}

/** A write's preview with Save and Cancel, its progress, and what came of it. */
function WriteStatus<C>({ w, verb, onConfirm, onCancel }: { w: Write<C>; verb: (c: C) => string; onConfirm: (c: C) => void; onCancel: () => void }) {
  if (w.kind === "confirming")
    return (
      <div className="work-confirm" role="group" aria-label="Confirm the change">
        {w.preview ? (
          w.preview.map((line) => (
            <p key={line} className="work-text">
              {line}
            </p>
          ))
        ) : (
          <p className="muted">
            <Spinner /> Checking what this changes…
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!w.preview} onClick={() => onConfirm(w.change)}>
            {verb(w.change)}
          </button>
        </div>
      </div>
    );
  if (w.kind === "writing")
    return (
      <p className="muted" role="status">
        <Spinner /> Saving…
      </p>
    );
  if (w.kind === "unconfirmed")
    return (
      <div className="work-confirm" role="alert">
        <p className="work-err">{w.why}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={() => onConfirm(w.change)}>
            Try again
          </button>
        </div>
      </div>
    );
  if (w.kind === "failed")
    return (
      <p className="work-err" role="alert">
        {w.why}
      </p>
    );
  return w.note ? <p className="muted">{w.note}</p> : null;
}

/** Statuses whose bot and model can still change: the card hasn't started, or waits to. */
export const PICKABLE = new Set(["triage", "todo", "ready", "blocked"]);

/** A pick: a bot (`""` unassigns), or a model (none for the bot's own). */
type BotModelChange = { kind: "bot"; bot: string; was: string } | { kind: "model"; pick?: ModelPick; was?: ModelPick };

const modelOf = (t: BoardTask): ModelPick | undefined => (t.model ? { model: t.model, ...(t.provider && { provider: t.provider }) } : undefined);
const sameModel = (a?: ModelPick, b?: ModelPick) => a?.model === b?.model && (a?.provider ?? "") === (b?.provider ?? "");
const has = (c: BotModelChange, t: BoardTask) => (c.kind === "bot" ? t.assignee === c.bot : sameModel(modelOf(t), c.pick));
const SEP = "\n";

type Choices = { bots: string[]; profiles: BotProfile[]; models: ModelProvider[] };

/**
 * The bot and the model a card that hasn't started runs with. The lists come from Hermes once per sheet; a model
 * catalog Hermes can't build leaves a text field instead.
 */
export function BotModelSection({ task, api, onRead, onSaved, onWriting, assignees }: SheetLink & { assignees: string[] }) {
  const [choices, setChoices] = useState<Choices>();
  const [typed, setTyped] = useState("");
  const [w, setW] = useState<Write<BotModelChange>>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const settle = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    void Promise.all([settle(api.assignees(), assignees), settle(api.profiles(), []), settle(api.modelOptions(), [])]).then(
      ([bots, profiles, models]) => live.current && setChoices({ bots, profiles, models }),
    );
    return () => void (live.current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per sheet; `api` is the same Hermes throughout
  }, []);
  useEffect(() => {
    if (w.kind === "unconfirmed" && has(w.change, task)) setW({ kind: "idle" });
  }, [w, task]);

  const sending = useRef(false);
  const send = async (change: BotModelChange) => {
    if (sending.current) return;
    sending.current = true;
    setW({ kind: "writing", change });
    onWriting(true);
    let sent = false;
    try {
      const before = await api.loadTask(task.id);
      if (!live.current) return;
      onRead(before);
      if (has(change, before.task)) return setW({ kind: "idle", note: "That's already set." });
      const now = change.kind === "bot" ? before.task.assignee === change.was : sameModel(modelOf(before.task), change.was);
      if (!now) return setW({ kind: "failed", why: "This card changed since the sheet showed it, so nothing was sent. Here it is now." });
      sent = true;
      const saved = change.kind === "bot" ? await api.editTask(task.id, { assignee: change.bot }) : await api.setModel(task.id, change.pick);
      if (!live.current) return;
      if (saved && has(change, saved)) {
        onRead({ ...before, task: { ...saved, summary: before.task.summary, links: before.task.links } });
        setW({ kind: "idle" });
        onSaved();
      } else setW({ kind: "unconfirmed", change, why: "Hermes answered without the change. Refresh to check." });
    } catch (e) {
      if (!live.current) return;
      if (!sent || refused(e)) setW({ kind: "failed", why: errorText(e) });
      else setW({ kind: "unconfirmed", change, why: `${errorText(e)}. It may have gone through: Refresh to check, or Try again, which sets the same thing.` });
    } finally {
      sending.current = false;
      onWriting(false);
    }
  };

  const locked = !choices || busy(w) || w.kind === "confirming";
  const ask = (change: BotModelChange) => setW({ kind: "confirming", change, preview: preview(task, change, choices) });
  const bots = choices ? [...new Set([...(task.assignee ? [task.assignee] : []), ...choices.bots])] : [];
  const botModel = (name: string) => choices?.profiles.find((p) => p.name === name)?.model;
  const current = modelOf(task);
  const listed = !!current && !!choices?.models.some((p) => p.slug === current.provider && p.models.includes(current.model));

  return (
    <section className="work-plan" aria-label="Bot and model">
      <h3 className="work-sub">Bot and model</h3>
      <div className="work-fields-row">
        <label>
          Bot
          <select value={task.assignee} disabled={locked} onChange={(e) => ask({ kind: "bot", bot: e.target.value, was: task.assignee })}>
            <option value="">Unassigned</option>
            {bots.map((b) => (
              <option key={b} value={b}>
                {botModel(b) ? `${b} (${botModel(b)})` : b}
              </option>
            ))}
          </select>
        </label>
        {choices && !choices.models.length ? (
          <form
            className="work-model-typed"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim() && !locked) ask({ kind: "model", pick: { model: typed.trim() }, was: current });
            }}
          >
            <label>
              Model
              <input value={typed} disabled={locked} placeholder={current?.model ?? "Bot's default model"} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button className="btn" disabled={locked || !typed.trim()}>
              Use
            </button>
            {current && (
              <button type="button" className="btn" disabled={locked} onClick={() => ask({ kind: "model", was: current })}>
                Bot's default
              </button>
            )}
          </form>
        ) : (
          <label>
            Model
            <select
              value={current ? `${current.provider ?? ""}${SEP}${current.model}` : ""}
              disabled={locked}
              onChange={(e) => {
                const [provider, model] = e.target.value.split(SEP);
                ask({ kind: "model", pick: e.target.value ? { model, ...(provider && { provider }) } : undefined, was: current });
              }}
            >
              <option value="">Bot's default model</option>
              {current && !listed && <option value={`${current.provider ?? ""}${SEP}${current.model}`}>{current.model}</option>}
              {choices?.models.map((p) => (
                <optgroup key={p.slug} label={p.label}>
                  {p.models.map((m) => (
                    <option key={m} value={`${p.slug}${SEP}${m}`}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>
      <WriteStatus w={w} onConfirm={(c) => void send(c)} onCancel={() => setW({ kind: "idle" })} verb={() => "Save"} />
    </section>
  );
}

function preview(t: BoardTask, c: BotModelChange, choices?: Choices): string[] {
  if (c.kind === "bot") {
    // A server with `kanban.default_assignee` set gives an unassigned ready card to that bot, so "nothing runs it" would be wrong there.
    if (!c.bot) return [`${t.title} will have no bot. The dispatcher skips it, unless this server sets kanban.default_assignee, which then takes it.`];
    const starts =
      t.status === "ready"
        ? [`It's ready, so the dispatcher starts it on its next tick, about a minute.`]
        : t.status === "todo"
          ? [`Once it's ready, the dispatcher starts it on its next tick.`]
          : [];
    return [`${t.title} goes to ${c.bot}.`, ...starts];
  }
  if (!c.pick) return [`${t.title} goes back to its bot's own model.`];
  const from = choices?.models.find((p) => p.slug === c.pick!.provider)?.label;
  return [`${t.title} runs on ${c.pick.model}${from ? ` from ${from}` : ""} instead of its bot's model.`];
}
