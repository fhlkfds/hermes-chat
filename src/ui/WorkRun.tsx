import { useEffect, useRef, useState } from "react";
import { canMove, type BoardTask, type RunChat, type RunId, type RunLine, type TaskDetail, type TaskRun, type Workflow } from "../hermes/kanban";
import { NOTHING_SENT, liveRun, previewOf, settles, type Outcome, type RunAction, type RunOrder } from "../hermes/taskRuns";
import { errorText, plural } from "../hermes/values";
import { WriteStatus, busy, type SheetLink, type WorkFeature, type Write } from "./WorkPlan";

export const manualMoves = (wf: Workflow, task: Pick<BoardTask, "status">, lacks: ReadonlySet<WorkFeature>) =>
  task.status === "running" && !lacks.has("reassign") ? [] : wf.columns.filter((c) => canMove(wf, task.status, c.key));

function since(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

const count = (n?: number) => (n === undefined ? "unknown" : n.toLocaleString("en-US"));

const SAID_BY: Record<RunLine["role"], string> = { user: "Asked", assistant: "Bot", tool: "Tool" };

const writeOf = (outcome: Outcome, order: RunOrder): Write<RunOrder> => {
  if (outcome.kind === "done") return { kind: "idle", note: outcome.note };
  if (outcome.kind === "raced") return { kind: "idle", alert: outcome.why };
  if (outcome.kind === "unsettled") return { kind: "unconfirmed", change: order, why: outcome.why };
  return { kind: "failed", why: outcome.why };
};

const verbOf = ({ action }: RunOrder) => (action.kind === "stop" ? "Stop" : action.kind === "reclaim" ? "Reclaim" : `Reassign to ${action.bot}`);

type ChatRead = { run: RunId; read?: RunChat; err?: string };

export function RunSection({
  task,
  api,
  onRead,
  onSaved,
  onWriting,
  runs,
  assignees,
  can,
  watchMs,
  refresh,
  defaultAssignee,
}: SheetLink & {
  runs: TaskRun[];
  assignees: string[];
  can: { reclaim: boolean; reassign: boolean };
  watchMs: number;
  refresh: () => Promise<TaskDetail | undefined>;
  defaultAssignee?: string;
}) {
  const [w, setW] = useState<Write<RunOrder>>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const [bots, setBots] = useState(assignees);
  const [chat, setChat] = useState<ChatRead>();
  const [stale, setStale] = useState<string>();
  const box = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const live = liveRun(runs);
  const shown = live ?? runs.at(-1);

  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const reassigns = can.reassign;
  useEffect(() => {
    if (reassigns) api.assignees().then((names) => alive.current && setBots(names), () => {});
  }, [api, reassigns]);

  const chatNow = useRef(chat);
  chatNow.current = chat;
  const chatAsk = useRef(0);
  const readChat = async (run: TaskRun) => {
    if (!run.chat) return;
    const mine = ++chatAsk.current;
    const was = chatNow.current?.run === run.id ? chatNow.current.read : undefined;
    const next: ChatRead = await api.runChat({ ...run, chat: run.chat }, was).then(
      (read) => ({ run: run.id, read }),
      (e) => ({ run: run.id, read: was, err: errorText(e) }),
    );
    if (alive.current && mine === chatAsk.current) setChat(next);
  };
  const readChatRef = useRef(readChat);
  readChatRef.current = readChat;

  const shownNow = useRef(shown);
  shownNow.current = shown;
  const ended = !!shown?.ended;
  useEffect(() => {
    if (shownNow.current) void readChatRef.current(shownNow.current);
  }, [shown?.id, shown?.chat, ended]);

  const busyNow = useRef(false);
  busyNow.current = busy(w);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const liveId = live?.id;
  useEffect(() => {
    if (liveId === undefined) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden && !busyNow.current) {
        try {
          const d = await refreshRef.current();
          const run = d && liveRun(d.runs);
          if (on) setStale(undefined);
          if (on && run) await readChatRef.current(run);
        } catch (e) {
          if (on) setStale(errorText(e));
        }
      }
      if (on) timer = setTimeout(() => void tick(), watchMs);
    };
    timer = setTimeout(() => void tick(), watchMs);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [liveId, watchMs]);

  useEffect(() => {
    if (w.kind !== "unconfirmed") return;
    const outcome = settles(w.change, { task, runs });
    if (outcome) setW(writeOf(outcome, w.change));
  }, [w, task, runs]);

  // The control that had focus is gone by now (the confirm, or the buttons of a run that ended). Left on the page's
  // body, focus is out of the dialog, and Escape stops closing it.
  useEffect(() => {
    if (document.activeElement === document.body) box.current?.focus();
  }, [w]);

  const sending = useRef(false);
  const send = async (order: RunOrder) => {
    if (sending.current) return;
    sending.current = true;
    setW({ kind: "writing", change: order });
    onWriting(true);
    try {
      const { outcome, order: after } = await api.changeRun(order, (d) => alive.current && onRead(d));
      if (!alive.current) return;
      setW(writeOf(outcome, after));
      if (outcome.kind === "done" || outcome.kind === "raced") setReason("");
      onSaved();
    } finally {
      sending.current = false;
      onWriting(false);
    }
  };

  if (!shown) return null;
  const locked = busy(w) || w.kind === "confirming";
  const ask = (action: RunAction) => {
    if (!live || locked) return;
    const order: RunOrder = { task: task.id, action, seen: { run: live.id, assignee: task.assignee }, progress: NOTHING_SENT };
    setW({ kind: "confirming", change: order, preview: previewOf(action, task, live, defaultAssignee) });
  };
  const stopping = w.kind === "confirming" && w.change.action.kind === "stop";
  const others = bots.filter((b) => b !== task.assignee);
  const now = Date.now();
  const read = chat?.run === shown.id ? chat : undefined;
  const usage = read?.read?.usage;

  return (
    <section ref={box} tabIndex={-1} className="work-plan work-run" aria-label="Bot run">
      <h3 className="work-sub">{live ? "Bot at work" : "Last run"}</h3>
      <p className="work-run-meta">
        {[
          `Run ${shown.id}`,
          shown.profile,
          shown.startedAt && `started ${since(shown.startedAt, now)}`,
          shown.ended ? `ended ${since(shown.ended.at, now)} (${shown.ended.outcome})` : shown.heartbeatAt ? `heartbeat ${since(shown.heartbeatAt, now)}` : "no heartbeat yet",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {shown.ended?.outcome === "blocked" && <p className="muted small">Blocking a card doesn't stop its bot. This run's bot may still be working, to the end of its turn.</p>}
      {!shown.chat ? (
        <p className="muted">{live ? "Hermes hasn't named this run's chat yet." : "Hermes named no chat for this run."}</p>
      ) : read?.read ? (
        <p className="work-run-meta">
          {usage ? `${live ? "Tokens so far" : "Tokens"}: ${count(usage.input)} in · ${count(usage.output)} out` : "Hermes gave no token counts for this chat"} ·{" "}
          {plural(read.read.messages, "message")}
        </p>
      ) : (
        !read?.err && <p className="muted">Reading the bot's chat…</p>
      )}
      {read?.err && (
        <p className="muted small">
          Couldn't read the bot's chat: {read.err}
          {read.read && " Shown as last read."}
        </p>
      )}
      {!!read?.read?.latest.length && (
        <ul className="work-run-lines" aria-label="Latest in its chat">
          {read.read.latest.map((line, i) => (
            <li key={i} title={line.text}>
              <span className="work-run-role">{SAID_BY[line.role]}</span>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {stale && <p className="muted small">Couldn't read the card just now: {stale} Shown as last read.</p>}
      {live && (can.reclaim || can.reassign) && (
        // Not `disabled` while a confirm shows: a control that disables itself under focus drops focus out of the dialog.
        <div className="work-run-actions">
          {can.reassign && (
            <button type="button" className="btn" aria-disabled={locked} onClick={() => ask({ kind: "stop", reason: "" })}>
              Stop…
            </button>
          )}
          {can.reclaim && (
            <button type="button" className="btn" aria-disabled={locked} onClick={() => ask({ kind: "reclaim" })}>
              Reclaim
            </button>
          )}
          {can.reassign && (
            <select aria-label="Reassign to" value="" aria-disabled={locked} disabled={!others.length} onChange={(e) => e.target.value && ask({ kind: "reassign", bot: e.target.value })}>
              <option value="">Reassign to…</option>
              {others.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <WriteStatus
        w={w}
        verb={verbOf}
        field={
          stopping && (
            <label>
              Why stop it?
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown on the card as why it's blocked" />
            </label>
          )
        }
        ready={!stopping || !!reason.trim()}
        onConfirm={(c) => void send(stopping ? { ...c, action: { kind: "stop", reason: reason.trim() } } : c)}
        onCancel={() => setW({ kind: "idle" })}
      />
    </section>
  );
}
