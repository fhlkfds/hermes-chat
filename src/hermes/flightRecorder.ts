// The flight recorder (ADR 0177): one reply's turn drawn as a list of steps, each with how long it took and whether it
// failed. A turn the app watched is drawn from the events it heard, each kept in memory with when it arrived. A turn it
// didn't watch is drawn from Hermes's stored rows. Hermes sends no server time and no step cost, so every time and token
// figure here is the app's inference, except a tool's `duration_s`, which Hermes measures itself
// (`tui_gateway/tool_progress.py` `_on_tool_complete` at `bf0203a` and `f0d9488`).
import type { QuestionKind } from "./model";
import type { Cost, UsageCounters } from "./usage";
import { toolResultText } from "./toolResult";

/** One thing the app heard during a watched turn, with when it arrived (Unix ms). */
export type Heard =
  | { kind: "start"; at: number }
  /** Consecutive text or reasoning deltas, merged: the first's arrival, the last's, and how much they held. */
  | { kind: "text"; at: number; last: number; chars: number; reasoning: boolean }
  | { kind: "tool.start"; at: number; id: string; name: string; args?: Record<string, unknown> }
  | { kind: "tool.complete"; at: number; id: string; name: string; args?: Record<string, unknown>; durationS?: number; result?: string }
  | { kind: "usage"; at: number; counters: UsageCounters }
  | { kind: "status"; at: number; status: string; text: string }
  /** `requestId`: an Approval's own id, which `approval.cancelled` may name instead of the request's frame id. */
  | { kind: "ask"; at: number; id: string; requestId?: string; what: QuestionKind; summary: string }
  /** A Question ended: answered from here, or Hermes stopped waiting (`request.cancel`, `approval.cancelled`). */
  | { kind: "settled"; at: number; ids?: string[]; how: string }
  | { kind: "error"; at: number; message: string }
  | { kind: "end"; at: number; status: string; failure?: string; counters?: UsageCounters };

/**
 * A turn the app watched. `from`: the counters at its start, when known. `costBefore` / `costAfter`: the chat's cost
 * from the session reads before and after it. `replies`: its replies' item ids, and `replyRow` the final reply's
 * stored row, so it is found again after the chat is read back from history.
 */
export type WatchedTurn = {
  heard: Heard[];
  from?: UsageCounters;
  costBefore?: Cost;
  costAfter?: Cost;
  replies: string[];
  replyRow?: number;
};

/** The last of `xs` that `ok` picks. */
function lastOf<T, S extends T = T>(xs: readonly T[], ok: ((x: T) => x is S) | ((x: T) => boolean)): S | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i])) return xs[i] as S;
  return undefined;
}

/** The most turns kept per chat. A run older than that is read from Hermes's stored rows instead. */
const TURNS_KEPT = 30;
/** The most events kept per turn; merged deltas make this a very long turn. */
const HEARD_KEPT = 4000;

/**
 * What the app heard of each chat's turns, in memory only: nothing is written to disk. Events pair with a turn by order
 * on the session, from `message.start` to `message.complete` or `error`, since `bf0203a` sends no `turn_id`.
 */
export class FlightRecorder {
  private turns = new Map<string, WatchedTurn[]>();
  private open = new Map<string, WatchedTurn>();

  /** Opens the chat's turn at its `message.start`. One still open, whose end never came, stays as it was heard. */
  begin(chatId: string, at: number, from: UsageCounters | undefined, costBefore: Cost | undefined) {
    const turn: WatchedTurn = { heard: [{ kind: "start", at }], ...(from && { from }), ...(costBefore && { costBefore }), replies: [] };
    this.open.set(chatId, turn);
    const kept = [...(this.turns.get(chatId) ?? []), turn];
    this.turns.set(chatId, kept.slice(-TURNS_KEPT));
  }

  /** Adds to the chat's running turn, if one is open. Text deltas merge into the one before. */
  hear(chatId: string, h: Heard) {
    const turn = this.open.get(chatId);
    if (!turn || turn.heard.length >= HEARD_KEPT) return;
    const last = turn.heard.at(-1);
    if (h.kind === "text" && last?.kind === "text" && last.reasoning === h.reasoning) {
      turn.heard[turn.heard.length - 1] = { ...last, last: h.at, chars: last.chars + h.chars };
      return;
    }
    turn.heard.push(h);
  }

  /** Ends the chat's running turn, with its replies, and returns it for the cost read that follows. */
  end(chatId: string, h: Extract<Heard, { kind: "end" | "error" }>, replies: string[], replyRow: number | undefined): WatchedTurn | undefined {
    const turn = this.open.get(chatId);
    if (!turn) return undefined;
    turn.heard.push(h);
    turn.replies = replies;
    if (replyRow !== undefined) turn.replyRow = replyRow;
    this.open.delete(chatId);
    return turn;
  }

  /** The finished turn a reply belongs to, by its item id or its stored row. */
  find(chatId: string, reply: { id: string; rowId?: number }): WatchedTurn | undefined {
    return lastOf(this.turns.get(chatId) ?? [], (t) => !this.isOpen(chatId, t) && (t.replies.includes(reply.id) || (reply.rowId !== undefined && t.replyRow === reply.rowId)));
  }

  private isOpen(chatId: string, t: WatchedTurn) {
    return this.open.get(chatId) === t;
  }
}

/** How long a step took. `measured`: Hermes timed it; otherwise the app inferred it. */
export type Length = { ms: number; measured: boolean };

type StepBase = { id: string; start: number; end: number; length: Length; failed?: string };

/**
 * One step of a run. `model`: one or more model calls between tool calls, its edges and tokens inferred. `tool`: a tool
 * call; `placed` when its start was worked back from its measured length, `together` when it ran beside others so its
 * stored gap isn't its own length. `question`: an Approval or Question, from when it was asked to when it ended.
 * `status`: a status line Hermes sent, at one moment.
 */
export type Step =
  | (StepBase & { kind: "model"; calls?: number; tokens?: { prompt: number; output: number; reasoning: number }; text?: string; reasoning?: string; chars?: number })
  | (StepBase & { kind: "tool"; name: string; callId: string; args?: Record<string, unknown>; result?: string; placed?: boolean; together?: boolean })
  | (StepBase & { kind: "question"; what: QuestionKind; summary: string; outcome: string })
  | (StepBase & { kind: "status"; status: string; text: string })
  | (StepBase & { kind: "error"; text: string });

/** A run's cost: the change in the chat's cost across the turn, always inferred, or why there is none. */
export type RunCost = { usd: number } | { why: string };

/**
 * One reply's run. `watched`: from the events the app heard; `stored`: from Hermes's stored rows. `calls`: the turn's
 * model calls, from Hermes's counters. `running`: the turn hadn't ended when the run was drawn.
 */
export type Run = {
  source: "watched" | "stored";
  start: number;
  end: number;
  steps: Step[];
  outcome: "complete" | "interrupted" | "failed" | "running";
  calls?: number;
  cost?: RunCost;
};

const counterDiff = (a: UsageCounters, b: UsageCounters) => ({ prompt: b.prompt - a.prompt, output: b.output - a.output, reasoning: b.reasoning - a.reasoning });

/**
 * Whether a tool's result shows the call failed, judged as Hermes judges a failure the owner must see
 * (`_tool_result_needs_user`, `tui_gateway/tool_progress.py` at `bf0203a` and `f0d9488`): a JSON object whose
 * `success` or `ok` is false, whose `error` is text, or whose `exit_code` isn't 0. `tool.complete` carries no failure
 * flag, so this is a judgment from the result. The reason, or undefined.
 */
export function judgeFailure(result: string | undefined): string | undefined {
  if (!result) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(result);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string" && d.error.trim()) return d.error.trim();
  if (d.success === false || d.ok === false) return "The result says it didn't succeed.";
  if (typeof d.exit_code === "number" && Number.isInteger(d.exit_code) && d.exit_code !== 0) return `Exit code ${d.exit_code}.`;
  return undefined;
}

const QUESTION_NAME: Record<QuestionKind, string> = { approval: "Approval", clarify: "Question", sudo: "Sudo password", secret: "Secret" };
export const questionName = (k: QuestionKind) => QUESTION_NAME[k];

/** The cost of a watched turn: the change in the chat's cost between the reads before and after it. */
function turnCost(before: Cost | undefined, after: Cost | undefined): RunCost {
  if (!after) return { why: "The chat's cost wasn't read after this turn." };
  if (!before) return { why: "The chat's cost wasn't read before this turn." };
  if (after.kind === "included") return { why: "The model is in a subscription, and Hermes recorded no charge." };
  if (after.kind === "unknown" || before.kind === "unknown" || before.kind === "included") return { why: "Hermes couldn't price this chat's calls." };
  const usd = after.usd - before.usd;
  if (usd < 0) return { why: "The chat's cost went down during the turn, so another change to it came between the reads." };
  return { usd };
}

/**
 * Draws a watched turn. Tool steps come from `tool.start` and `tool.complete`. Model steps are the gaps between them:
 * one starts at `message.start` or when the last tool running ends, and ends at the next `tool.start` or the turn's end.
 * Each model step's tokens and calls are the change in Hermes's counters from the last reading before it to the last
 * before the next model step, read from `session.usage` (sent at most once a second) and the turn's end.
 */
export function watchedRun(turn: WatchedTurn, now: number): Run {
  const heard = turn.heard;
  const start = heard[0]?.at ?? now;
  const endH = lastOf(heard, (h): h is Extract<Heard, { kind: "end" | "error" }> => h.kind === "end" || h.kind === "error");
  const steps: Step[] = [];
  const running = new Map<string, Extract<Step, { kind: "tool" }>>();
  const asks = new Map<string, { step: Extract<Step, { kind: "question" }>; requestId?: string }>();
  type ModelStep = Extract<Step, { kind: "model" }>;
  let model: ModelStep | undefined;
  const models: ModelStep[] = [];
  let seq = 0;
  const id = (p: string) => `${p}${seq++}`;
  const openModel = (at: number) => {
    model = { kind: "model", id: id("m"), start: at, end: at, length: { ms: 0, measured: false } };
    steps.push(model);
  };
  const closeModel = (at: number) => {
    if (!model) return;
    model.end = at;
    model.length = { ms: at - model.start, measured: false };
    models.push(model);
    model = undefined;
  };
  openModel(start);
  for (const h of heard) {
    if (h.kind === "text" && model) {
      model.chars = (model.chars ?? 0) + h.chars;
      if (h.reasoning) model.reasoning = "reasoning";
    } else if (h.kind === "tool.start") {
      closeModel(h.at);
      const step: Extract<Step, { kind: "tool" }> = { kind: "tool", id: id("t"), name: h.name, callId: h.id, start: h.at, end: h.at, length: { ms: 0, measured: false }, ...(h.args && { args: h.args }) };
      running.set(h.id, step);
      steps.push(step);
    } else if (h.kind === "tool.complete") {
      let step = running.get(h.id);
      running.delete(h.id);
      if (!step) {
        // Sent with no `tool.start`: with `display.tool_progress` off, Hermes still sends a failed call's completion.
        closeModel(h.at);
        const ms = h.durationS !== undefined ? h.durationS * 1000 : 0;
        step = { kind: "tool", id: id("t"), name: h.name, callId: h.id, start: h.at - ms, end: h.at, length: { ms, measured: false }, placed: true };
        steps.push(step);
      }
      step.end = h.at;
      step.length = h.durationS !== undefined ? { ms: h.durationS * 1000, measured: true } : { ms: h.at - step.start, measured: false };
      if (h.args && !step.args) step.args = h.args;
      if (h.result !== undefined) step.result = h.result;
      const failed = judgeFailure(h.result);
      if (failed) step.failed = failed;
      if (!running.size) openModel(h.at);
    } else if (h.kind === "ask") {
      const step: Extract<Step, { kind: "question" }> = { kind: "question", id: id("q"), what: h.what, summary: h.summary, start: h.at, end: h.at, length: { ms: 0, measured: false }, outcome: "Still waiting" };
      asks.set(h.id, { step, requestId: h.requestId });
      steps.push(step);
    } else if (h.kind === "settled") {
      for (const [key, { step, requestId }] of asks) {
        if (h.ids && !h.ids.includes(key) && !(requestId && h.ids.includes(requestId))) continue;
        step.end = h.at;
        step.length = { ms: h.at - step.start, measured: false };
        step.outcome = h.how;
        asks.delete(key);
      }
    } else if (h.kind === "status") {
      steps.push({ kind: "status", id: id("s"), status: h.status, text: h.text, start: h.at, end: h.at, length: { ms: 0, measured: false }, ...(h.status === "warn" && { failed: h.text }) });
    } else if (h.kind === "error") {
      steps.push({ kind: "error", id: id("e"), text: h.message, start: h.at, end: h.at, length: { ms: 0, measured: false }, failed: h.message });
    }
  }
  const end = endH?.at ?? now;
  closeModel(end);
  for (const step of running.values()) {
    step.end = end;
    step.length = { ms: end - step.start, measured: false };
  }
  for (const { step } of asks.values()) {
    step.end = end;
    step.length = { ms: end - step.start, measured: false };
    if (endH) step.outcome = "The turn ended";
  }
  attributeTokens(models, heard, turn.from, endH?.kind === "end" ? endH.counters : undefined);
  // A model step that took no time, held no text and made no call the counters show, as before a turn that only failed, is left out.
  const kept = steps.filter((s) => s.kind !== "model" || s.length.ms > 0 || s.chars || s.calls);
  const outcome = !endH ? "running" : endH.kind === "error" ? "failed" : endH.status === "interrupted" ? "interrupted" : endH.failure || endH.status === "error" ? "failed" : "complete";
  const finalCounters = endH?.kind === "end" ? endH.counters : undefined;
  const calls = turn.from && finalCounters && finalCounters.calls >= turn.from.calls ? finalCounters.calls - turn.from.calls : undefined;
  return {
    source: "watched",
    start,
    end,
    steps: kept,
    outcome,
    ...(calls !== undefined && { calls }),
    ...(endH && { cost: turnCost(turn.costBefore, turn.costAfter) }),
  };
}

/**
 * Gives each model step the change in Hermes's counters across it. Hermes counts a call when it ends, just before the
 * `tool.start` that ends the step, and sends the counters up to a second later, by when the next step may be running
 * (seen at `bf0203a`). So a step's end is read from the first reading after it ended and before the next step ended,
 * and the last step's from the turn's final counters. A step whose end has no such reading is left without tokens, and
 * the step after it is measured from the last reading before it started.
 */
function attributeTokens(models: Extract<Step, { kind: "model" }>[], heard: Heard[], from: UsageCounters | undefined, final: UsageCounters | undefined) {
  const readings = heard.flatMap((h) => (h.kind === "usage" ? [{ at: h.at, counters: h.counters }] : []));
  let before = from;
  for (const [i, step] of models.entries()) {
    const next = models[i + 1];
    const after = next ? readings.find((r) => r.at > step.end && r.at <= next.end)?.counters : (final ?? readings.at(-1)?.counters);
    if (before && after && after.calls >= before.calls) {
      const diff = counterDiff(before, after);
      if (diff.prompt >= 0 && diff.output >= 0 && diff.reasoning >= 0) {
        step.calls = after.calls - before.calls;
        step.tokens = diff;
      }
    }
    before = after ?? (next && lastOf(readings, (r) => r.at <= next.start)?.counters);
  }
}

/** A stored row, as `GET /api/sessions/{id}/messages` sends it, as far as the Run view reads it. */
export type RunRow = {
  id: number;
  role: string;
  content: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: number | null;
  display_kind?: string | null;
  reasoning?: unknown;
};

type StoredCall = { id: string; name: string; args?: Record<string, unknown> };

/** An assistant row's `tool_calls`: JSON text in the stored row, or a list. */
function callsOf(raw: unknown): StoredCall[] {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((c): StoredCall[] => {
    if (!c || typeof c !== "object") return [];
    const { id, function: fn } = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof id !== "string" || !id) return [];
    let args: Record<string, unknown> | undefined;
    if (typeof fn?.arguments === "string") {
      try {
        const parsed = JSON.parse(fn.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      } catch {
        args = { arguments: fn.arguments };
      }
    }
    return [{ id, name: typeof fn?.name === "string" && fn.name ? fn.name : "tool", ...(args && { args }) }];
  });
}

const rowText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ") : "";

/** Whether a stored row began a turn: a user row that wasn't steered into a running reply. */
const beginsTurn = (r: RunRow) => r.role === "user" && r.display_kind !== "steer";

/**
 * The rows of the turn that holds stored row `replyRow`, oldest first: from the row that began it to the row before the
 * next one that begins a turn. Undefined when `rows` (oldest first) doesn't reach back to where the turn began.
 */
export function turnRows(rows: RunRow[], replyRow: number): RunRow[] | undefined {
  const at = rows.findIndex((r) => r.id === replyRow);
  if (at < 0) return undefined;
  let begin = at;
  while (begin >= 0 && !beginsTurn(rows[begin])) begin--;
  if (begin < 0) return undefined;
  let end = at + 1;
  while (end < rows.length && !beginsTurn(rows[end])) end++;
  return rows.slice(begin, end);
}

/** A stored time (Unix seconds) in ms, or undefined. */
const storedMs = (s: unknown) => (typeof s === "number" && s > 0 && s * 1000 <= 8.64e15 ? s * 1000 : undefined);

/**
 * Draws a turn the app didn't watch, from its stored rows, oldest first, starting with the row that began it. A row's
 * `timestamp` is when its step ended, so each step's length is the gap since the row before it, inferred. Tool rows pair
 * with the assistant's `tool_calls` by `tool_call_id`. Tools called together are stored as they finish, in call order,
 * so their gaps aren't each one's own length: they're marked `together`.
 */
export function storedRun(rows: RunRow[]): Run {
  const first = storedMs(rows[0]?.timestamp);
  const steps: Step[] = [];
  const calls = new Map<string, StoredCall & { together: boolean }>();
  let prev = first;
  let seq = 0;
  for (const r of rows.slice(1)) {
    const end = storedMs(r.timestamp) ?? prev;
    if (end === undefined) continue;
    const start = Math.min(prev ?? end, end);
    const length: Length = { ms: end - start, measured: false };
    prev = end;
    if (r.role === "assistant") {
      const asked = callsOf(r.tool_calls);
      for (const c of asked) calls.set(c.id, { ...c, together: asked.length > 1 });
      const text = rowText(r.content).trim();
      const reasoning = typeof r.reasoning === "string" && r.reasoning.trim() ? r.reasoning.trim() : undefined;
      steps.push({ kind: "model", id: `m${seq++}`, start, end, length, ...(text && { text }), ...(reasoning && { reasoning }) });
    } else if (r.role === "tool") {
      const call = typeof r.tool_call_id === "string" ? calls.get(r.tool_call_id) : undefined;
      const result = toolResultText(r.content) ?? "";
      const failed = judgeFailure(result);
      steps.push({
        kind: "tool",
        id: `t${seq++}`,
        name: call?.name ?? (typeof r.tool_name === "string" && r.tool_name ? r.tool_name : "tool"),
        callId: r.tool_call_id ?? "",
        start,
        end,
        length,
        ...(call?.args && { args: call.args }),
        result,
        ...(call?.together && { together: true }),
        ...(failed && { failed }),
      });
    }
  }
  const start = first ?? steps[0]?.start ?? 0;
  return { source: "stored", start, end: Math.max(start, prev ?? start), steps, outcome: "complete" };
}

/**
 * `display.tool_progress` for a profile, from `GET /api/config`, read as Hermes reads it (`_load_tool_progress_mode`,
 * `tui_gateway/agent_factory.py` at `bf0203a` and `f0d9488`): `off`, `new`, `all` or `verbose`, a YAML boolean as `all`
 * or `off`, and anything else as the default, `all`. `HERMES_TUI_TOOL_PROGRESS` on the server overrides it, and this
 * app can't see that.
 */
export type ToolProgress = "off" | "new" | "all" | "verbose";

export function toolProgressOf(config: unknown): ToolProgress {
  const display = config && typeof config === "object" ? (config as { display?: unknown }).display : undefined;
  const raw = display && typeof display === "object" ? (display as { tool_progress?: unknown }).tool_progress : undefined;
  if (typeof raw === "boolean") return raw ? "all" : "off";
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return mode === "off" || mode === "new" || mode === "verbose" ? mode : "all";
}
