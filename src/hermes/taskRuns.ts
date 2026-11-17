// Hermes has no write that takes an idempotency key here, and none that stops a run and blocks its card in one step
// (ADR 0192), so each ask is carried out as a loop: read the card, plan one write from that read alone, send it, read
// again.
import type { BoardTask, RunId, TaskDetail, TaskRun } from "./kanban";
import { errorText } from "./values";

export const liveRun = (runs: readonly TaskRun[]): TaskRun | undefined => runs.filter((r) => !r.ended).at(-1);

export type RunAction = { kind: "stop"; reason: string } | { kind: "reclaim" } | { kind: "reassign"; bot: string };

export type Seen = { run: RunId; assignee: string };

export type Progress = { sent: boolean };
export const NOTHING_SENT: Progress = { sent: false };

export type RunOrder = { task: string; action: RunAction; seen: Seen; progress: Progress };

export type RunWrite =
  | { kind: "terminate"; run: RunId; reason: string }
  | { kind: "reassign"; to: string; stops?: RunId; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "assign"; to: string };

export type Sent = { kind: "ok"; warning?: string } | { kind: "refused"; why: string } | { kind: "lost"; why: string };

export type RunIO = { read: () => Promise<TaskDetail>; send: (w: RunWrite) => Promise<Sent> };

export type Outcome =
  | { kind: "done"; note?: string }
  | { kind: "raced"; stray: TaskRun; why: string }
  | { kind: "changed"; why: string }
  | { kind: "failed"; why: string }
  | { kind: "unsettled"; why: string };

type Read = Pick<TaskDetail, "task" | "runs">;
type Step = RunWrite | { kind: "over"; outcome: Outcome };

const TICK = "on its next tick (every 60 s by default)";

function plan(order: RunOrder, d: Read): Step {
  const { action, seen } = order;
  const { status, assignee } = d.task;
  const live = liveRun(d.runs);
  const over = (outcome: Outcome): Step => ({ kind: "over", outcome });

  if (!order.progress.sent && (status !== "running" || live?.id !== seen.run || assignee !== seen.assignee)) {
    return over({ kind: "changed", why: "This card changed since you confirmed, so nothing was sent. Here it is now." });
  }

  switch (action.kind) {
    case "reclaim": {
      if (live?.id === seen.run) return { kind: "terminate", run: seen.run, reason: "Reclaimed from Highwing" };
      const note = live
        ? `Run ${seen.run} stopped, and the dispatcher has started the card again as run ${live.id}.`
        : status === "ready"
          ? `Run ${seen.run} stopped. The card is ready, and the dispatcher starts it again ${TICK}.`
          : `Run ${seen.run} stopped. The card is in ${status}.`;
      return over({ kind: "done", note });
    }
    case "reassign": {
      const { bot } = action;
      if (assignee === bot && live?.id !== seen.run)
        return over({ kind: "done", note: live ? `${bot} has started it as run ${live.id}.` : status === "ready" ? `It's ${bot}'s. The dispatcher starts it ${TICK}.` : `It's ${bot}'s, in ${status}.` });
      if (status === "done" || status === "archived") return over({ kind: "unsettled", why: `The card went to ${status} before it changed hands. Nothing more was sent.` });
      return { kind: "reassign", to: bot, ...(live && { stops: live.id }), reason: `Reassigned to ${bot} from Highwing` };
    }
    case "stop": {
      if (live) return { kind: "reassign", to: "", stops: live.id, reason: action.reason };
      if (status === "blocked") {
        if (assignee !== seen.assignee) return { kind: "assign", to: seen.assignee };
        const startedThenEndedByTheBlock = (r: TaskRun) => r.id > seen.run && r.ended?.outcome === "blocked";
        const stray = d.runs.filter(startedThenEndedByTheBlock).at(-1);
        if (!stray) return over({ kind: "done", note: `Run ${seen.run} stopped, and the card is blocked.` });
        return over({
          kind: "raced",
          stray,
          why: `The card is blocked, but the dispatcher started run ${stray.id} just before the block landed. Its bot works on to the end of its turn, and Hermes can't stop it now. The card stays blocked.`,
        });
      }
      if (status === "ready") return { kind: "block", reason: action.reason };
      // Hermes refuses a block from review, and giving the bot back would start the review again.
      if (status === "review") return over({ kind: "done", note: `Run ${seen.run} stopped. The card waits in Review with no bot, so no bot reviewer takes it. Pick a bot to have it reviewed.` });
      return over({ kind: "unsettled", why: `Run ${seen.run} stopped, then the card went to ${status} before it was blocked. Nothing more was sent.` });
    }
  }
}

export const settles = (order: RunOrder, d: Read): Outcome | undefined => {
  const step = plan(order, d);
  return step.kind === "over" && (step.outcome.kind === "done" || step.outcome.kind === "raced") ? step.outcome : undefined;
};

export function previewOf(action: RunAction, task: BoardTask, run: TaskRun, defaultAssignee?: string): string[] {
  const bot = run.profile || task.assignee || "Its bot";
  const stops = `${bot} stops working on ${task.title} (run ${run.id})`;
  if (action.kind === "reclaim")
    return [`${stops}. The card goes back to ready, or to review if this run was a review.`, `From ready, the dispatcher starts it again with ${task.assignee || "its bot"} ${TICK}.`];
  if (action.kind === "reassign")
    return [`${stops}, and the card goes to ${action.bot}.`, `From ready, the dispatcher starts it with ${action.bot} ${TICK}. If this run was a review, the card goes back to Review with ${action.bot}.`];
  const chased = "The app stops that run too, and says so if one gets past the block.";
  return [
    `${stops}, and the card is blocked with your reason, so the dispatcher doesn't start it again.`,
    `Hermes has no single step for this. The app takes the card from ${bot}, which stops the run, then blocks the card, then gives it back to ${bot}.`,
    "If this run was a review, the card goes back to Review with no bot instead, and isn't blocked, since Hermes doesn't block a card in Review. Your reason is kept with the stopped run either way.",
    defaultAssignee === undefined
      ? `If this server sets kanban.default_assignee, the dispatcher can start the card between those steps. ${chased}`
      : defaultAssignee
        ? `This server gives a card with no bot to ${defaultAssignee} (kanban.default_assignee), so the dispatcher can start the card between those steps. ${chased}`
        : "This server sets no kanban.default_assignee, so nothing starts the card between those steps.",
  ];
}

const MAX_WRITES = 5;

function stands(order: RunOrder, d: Read): string {
  if (order.action.kind !== "stop") return "";
  const { status, assignee } = d.task;
  if (status === "blocked") return ` The card is blocked, but ${order.seen.assignee} isn't back on it.`;
  return ` Run ${order.seen.run} stopped, and the card is in ${status} with ${assignee || "no bot"}, not blocked yet.`;
}

export async function perform(io: RunIO, order: RunOrder, onRead: (d: TaskDetail) => void): Promise<{ outcome: Outcome; order: RunOrder }> {
  let progress = order.progress;
  let last: { write: RunWrite; sent: Sent } | undefined;
  let warning: string | undefined;
  const end = (outcome: Outcome) => ({ outcome, order: { ...order, progress } });
  for (let writes = 0; ; writes++) {
    let d: TaskDetail;
    try {
      d = await io.read();
    } catch (e) {
      const why = errorText(e);
      return end(progress.sent ? { kind: "unsettled", why: `Couldn't read the card: ${why}. Part of this may have gone through. Try again reads the card first.` } : { kind: "failed", why });
    }
    onRead(d);
    const now = { ...order, progress };
    const step = plan(now, d);
    if (step.kind === "over") {
      const { outcome } = step;
      return end(warning && outcome.kind === "done" ? { kind: "done", note: [outcome.note, warning].filter(Boolean).join(" ") } : outcome);
    }
    if (last && JSON.stringify(last.write) === JSON.stringify(step)) {
      if (last.sent.kind === "ok") return end({ kind: "unsettled", why: "Hermes took the change, but the card doesn't show it yet. Try again reads the card first." });
      const { why } = last.sent;
      return end(progress.sent ? { kind: "unsettled", why: `Hermes refused the next step: ${why}.${stands(now, d)} Try again carries on from what Hermes shows.` } : { kind: "failed", why });
    }
    if (writes === MAX_WRITES) return end({ kind: "unsettled", why: `This still isn't done after ${MAX_WRITES} changes, so nothing more was sent.${stands(now, d)}` });
    const sent = await io.send(step);
    last = { write: step, sent };
    if (sent.kind === "refused") continue;
    progress = { sent: true };
    if (sent.kind === "lost") return end({ kind: "unsettled", why: `${sent.why}. It may have gone through. Try again reads the card first, and sends nothing twice.` });
    warning = sent.warning ?? warning;
  }
}
