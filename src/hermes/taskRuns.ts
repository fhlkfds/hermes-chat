// What the owner can ask of a running card's task run on the Work page (issue #604, ADR 0188): Stop it for good,
// Reclaim it, or Reassign it. Hermes has no write that takes an idempotency key here, and none that stops a run and
// blocks its card in one step, so each ask is carried out as a loop: read the card, plan one write from that read
// alone, send it, read again. `plan` is the whole policy. Nothing here knows a route: `KanbanApi.changeRun` sends.
import type { BoardTask, RunId, TaskDetail, TaskRun } from "./kanban";
import { errorText } from "./values";

/** The run Hermes shows working now: the newest task run whose row is still open. */
export const liveRun = (runs: readonly TaskRun[]): TaskRun | undefined => runs.filter((r) => !r.ended).at(-1);

/**
 * What the owner asked of a running card. `stop`: its bot stops and the card is blocked with `reason`, so nothing
 * starts it again. `reclaim`: this run stops, and the card goes back to be run again. `reassign`: this run stops and
 * `bot` takes the card.
 */
export type RunAction = { kind: "stop"; reason: string } | { kind: "reclaim" } | { kind: "reassign"; bot: string };

/** What the confirm showed: the run it acts on, and the bot the card was with. */
export type Seen = { run: RunId; assignee: string };

/** `sent`: a write of this order was answered, or got no answer and may have landed. Until then any difference from `seen` refuses. */
export type Progress = { sent: boolean };
export const NOTHING_SENT: Progress = { sent: false };

/** One owner action on `task`. Sent again with the progress it came back with, it carries on from what Hermes shows. */
export type RunOrder = { task: string; action: RunAction; seen: Seen; progress: Progress };

/**
 * One write toward an order. `reassign` always stops the card's run first (`reclaim_first`); `to: ""` leaves the card
 * with no bot. `stops`: the run the read showed working, so stopping a newer run is a different write from a repeat.
 */
export type RunWrite =
  | { kind: "terminate"; run: RunId; reason: string }
  | { kind: "reassign"; to: string; stops?: RunId; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "assign"; to: string };

/** How Hermes answered a write. `refused`: certainly not written. `lost`: no answer, so it may have landed. */
export type Sent = { kind: "ok"; warning?: string } | { kind: "refused"; why: string } | { kind: "lost"; why: string };

export type RunIO = { read: () => Promise<TaskDetail>; send: (w: RunWrite) => Promise<Sent> };

/**
 * How an order ended, in the owner's words. `done`: a read shows it. `raced`: Stop blocked the card, but the
 * dispatcher had started `stray` first, and blocking doesn't stop a bot. `changed`: the card wasn't as the confirm
 * showed it, so nothing was sent. `failed`: Hermes refused and nothing landed. `unsettled`: part of it landed or may
 * have, and the same order sent again carries on.
 */
export type Outcome =
  | { kind: "done"; note?: string }
  | { kind: "raced"; stray: TaskRun; why: string }
  | { kind: "changed"; why: string }
  | { kind: "failed"; why: string }
  | { kind: "unsettled"; why: string };

type Read = Pick<TaskDetail, "task" | "runs">;
type Step = RunWrite | { kind: "over"; outcome: Outcome };

/** Statuses a card with no bot at work waits in, which Hermes lets a person block. */
const WAITING = new Set(["triage", "todo", "scheduled", "ready"]);

const TICK = "on its next tick (every 60 s by default)";

function plan(order: RunOrder, d: Read): Step {
  const { action, seen } = order;
  const { status, assignee } = d.task;
  const live = liveRun(d.runs);
  const over = (outcome: Outcome): Step => ({ kind: "over", outcome });

  if (!order.progress.sent && (status !== "running" || live?.id !== seen.run || assignee !== seen.assignee)) {
    if (action.kind === "reassign" && assignee === action.bot && live?.id !== seen.run) return over({ kind: "done", note: "That's already so." });
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
      // Also after a reassign that stopped the run and didn't assign: sent again, it stops whatever runs now and assigns.
      return { kind: "reassign", to: bot, ...(live && { stops: live.id }), reason: `Reassigned to ${bot} from Highwing` };
    }
    case "stop": {
      // Park: with no bot the dispatcher has nothing to start it with. A newer run is one it started since, and parking again stops that too.
      if (live) return { kind: "reassign", to: "", stops: live.id, reason: action.reason };
      if (status === "blocked") {
        if (assignee !== seen.assignee) return { kind: "assign", to: seen.assignee };
        // Blocking a running card ends its run's row and leaves its bot working: a run claimed after the one confirmed and ended that way got past the block.
        const stray = d.runs.filter((r) => r.id > seen.run && r.ended?.outcome === "blocked").at(-1);
        if (!stray) return over({ kind: "done", note: `Run ${seen.run} stopped, and the card is blocked.` });
        return over({
          kind: "raced",
          stray,
          why: `The card is blocked, but the dispatcher started run ${stray.id} just before the block landed. Its bot works on to the end of its turn, and Hermes can't stop it now. The card stays blocked.`,
        });
      }
      if (WAITING.has(status)) return { kind: "block", reason: action.reason };
      // Hermes refuses a block from review, and giving the bot back would start the review again.
      if (status === "review") return over({ kind: "done", note: `Run ${seen.run} stopped. The card waits in Review with no bot, so no bot reviewer takes it. Pick a bot to have it reviewed.` });
      return over({ kind: "unsettled", why: `Run ${seen.run} stopped, then the card went to ${status} before it was blocked. Nothing more was sent.` });
    }
  }
}

/** What a read shows `order` came to, when it shows it finished: for a section still waiting on a lost answer. */
export const settles = (order: RunOrder, d: Read): Outcome | undefined => {
  const step = plan(order, d);
  return step.kind === "over" && (step.outcome.kind === "done" || step.outcome.kind === "raced") ? step.outcome : undefined;
};

/** The confirm's lines for `action` on `task`'s live `run`. `defaultAssignee`: the server's `kanban.default_assignee` when it was read, `""` for none. */
export function previewOf(action: RunAction, task: BoardTask, run: TaskRun, defaultAssignee?: string): string[] {
  const bot = run.profile || task.assignee || "Its bot";
  const stops = `${bot} stops working on ${task.title} (run ${run.id})`;
  if (action.kind === "reclaim")
    return [`${stops}. The card goes back to ready, or to review if this run was a review.`, `From ready, the dispatcher starts it again with ${task.assignee || "its bot"} ${TICK}.`];
  if (action.kind === "reassign") return [`${stops}, and the card goes to ${action.bot}.`, `The dispatcher starts it with ${action.bot} ${TICK}.`];
  const chased = "The app stops that run too, and says so if one gets past the block.";
  return [
    `${stops}, and the card is blocked with your reason, so the dispatcher doesn't start it again.`,
    `Hermes has no single step for this. The app takes the card from ${bot}, which stops the run, then blocks the card, then gives it back to ${bot}.`,
    defaultAssignee === undefined
      ? `If this server sets kanban.default_assignee, the dispatcher can start the card between those steps. ${chased}`
      : defaultAssignee
        ? `This server gives a card with no bot to ${defaultAssignee} (kanban.default_assignee), so the dispatcher can start the card between those steps. ${chased}`
        : "This server sets no kanban.default_assignee, so nothing starts the card between those steps.",
  ];
}

/** Stop's give-back makes three writes, and each run the dispatcher starts in a gap costs one more. */
const MAX_WRITES = 5;

/** Where a Stop that didn't finish left the card. */
function stands(order: RunOrder, d: Read): string {
  if (order.action.kind !== "stop") return "";
  const { status, assignee } = d.task;
  if (status === "blocked") return ` The card is blocked, but ${order.seen.assignee} isn't back on it.`;
  return ` Run ${order.seen.run} stopped, and the card is in ${status} with ${assignee || "no bot"}, not blocked yet.`;
}

/**
 * Carries out `order`: read, plan one write, send it, read again, until the plan says it is over. A write is never
 * sent twice in one call, and a lost answer ends the call, so the owner's Try again starts from a fresh read.
 */
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
