// The Run view (ADR 0177): one reply's turn drawn as a timeline of steps, each with how long it took and whether it
// failed. Research doc `docs/research/fleet-features-server-support.md`, "Flight recorder".
//
// Two sources, never mixed:
// - A watched run: the `/api/ws` events this app heard for the turn, each kept with its arrival time. No Hermes event
//   carries a server time, so every start and end is an arrival time. Only `tool.complete` `duration_s` is measured, by
//   Hermes. A model call has no event of its own: it is the time between tool calls. Its tokens come from the
//   `session.usage` counters, matched to it by their `calls` count, since a tick can arrive after the next tool started.
//   A turn's events pair by order: `message.start` has no `turn_id` at Hermes `bf0203a`.
// - A stored run: the turn's rows from `GET /api/sessions/{id}/messages`. A row has one time, when its step ended, so a
//   step's length is the gap since the row before it.
// Nothing here is written to disk.

import { countersOf, replyUsage, type ChatUsage, type ReplyUsage, type UsageCounters } from "./usage";
import { isObj } from "./values";

/** One event of a run as this app heard it. Streamed text of one kind in a row is one event, from `at` to `until`. */
export type RunEvent = { type: string; at: number; until?: number; payload: Record<string, unknown> };

/**
 * What this app heard of one turn, from `message.start` to its `message.complete` or `error`. `replyId`: the reply the
 * turn ended with. `rowId`: that reply's stored row, from `persisted_turn`, which finds it again after a reload of the
 * chat. `from`: the session's counters where the turn started. `costBefore` / `costAfter`: the chat's stored usage read
 * before the turn and the first read after it.
 */
export type Recording = {
  startedAt: number;
  endedAt?: number;
  replyId?: string;
  rowId?: number;
  from?: UsageCounters;
  costBefore?: ChatUsage;
  costAfter?: ChatUsage;
  events: RunEvent[];
};

/** How long a step took: `measured` by Hermes, or inferred here from arrival or stored times. */
export type Length = { ms: number; measured: boolean };

export type StepKind = "model" | "tool" | "question" | "compaction" | "status" | "error";

/**
 * One step of a run. `start` and `end` are Unix ms: arrival times for a watched run, stored row times for a stored one.
 * An instant (a status line, an error) has `end === start` and no length. `failed`: why the step looks failed. `judged`:
 * that was worked out from the result's words, since Hermes sends no failure flag for a tool. `tokens`: inferred.
 */
export type Step = {
  id: string;
  kind: StepKind;
  name: string;
  start: number;
  end: number;
  length?: Length;
  failed?: string;
  judged?: boolean;
  tokens?: ReplyUsage;
  args?: unknown;
  result?: string;
  text?: string;
  reasoning?: string;
  /** What to know about this step's figures. */
  note?: string;
};

/**
 * A run, ready to draw. `tokens`: the turn's, from Hermes's counters at its start and end. `cost`: the turn's cost in US
 * dollars, inferred from two reads of the chat's stored cost; `costWhy` says why there is none. `outcome`: how the turn
 * ended, when not plainly. `turnIds`: whether Hermes sent a turn id (unknown for a stored run).
 */
export type Run = {
  source: "watched" | "stored";
  start: number;
  end: number;
  steps: Step[];
  tokens?: ReplyUsage;
  cost?: number;
  costWhy?: string;
  outcome?: string;
  turnIds?: boolean;
};

/** The longest tool result or argument text kept per step, so one huge output can't hold the app's memory. */
export const KEPT_TEXT = 20_000;

const clip = (s: string) => (s.length > KEPT_TEXT ? `${s.slice(0, KEPT_TEXT)}\n… (cut at ${KEPT_TEXT} characters)` : s);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : v === undefined || v === null ? undefined : JSON.stringify(v));

/** Streamed events whose chunks join into one event. */
const STREAMED = new Set(["message.delta", "reasoning.delta"]);

/** The events a run is drawn from. Anything else Hermes sends for the chat is no step. */
const RECORDED = new Set([
  "message.start",
  "message.delta",
  "message.interim",
  "reasoning.delta",
  "reasoning.available",
  "tool.start",
  "tool.complete",
  "session.usage",
  "status.update",
  "error",
  "request.cancel",
  "approval.cancelled",
  "message.complete",
  // Not Hermes events: a Question Hermes asked (`request`) and the owner's answer from here (`answer`).
  "request",
  "answer",
]);

/** What is kept of a payload: only what a step shows, with long texts cut. */
function kept(type: string, p: Record<string, unknown>): Record<string, unknown> {
  if (STREAMED.has(type) || type === "reasoning.available") return { text: typeof p.text === "string" ? p.text : "" };
  if (type === "message.interim") return { text: typeof p.text === "string" ? p.text : "", already_streamed: p.already_streamed === true };
  if (type === "tool.start") return { tool_id: p.tool_id, name: p.name, ...(p.args !== undefined && { args: p.args }) };
  if (type === "tool.complete") {
    const result = text(p.result) ?? text(p.result_text);
    return { tool_id: p.tool_id, name: p.name, duration_s: p.duration_s, ...(p.args !== undefined && { args: p.args }), ...(result !== undefined && { result: clip(result) }) };
  }
  if (type === "message.complete") {
    const said = typeof p.text === "string" ? clip(p.text) : undefined;
    const reasoning = typeof p.reasoning === "string" ? clip(p.reasoning) : undefined;
    return { usage: p.usage, status: p.status, failure_reason: p.failure_reason, error: p.error, response_reused: p.response_reused === true, ...(said && { text: said }), ...(reasoning && { reasoning }) };
  }
  if (type === "message.start") return typeof p.turn_id === "string" ? { turn_id: p.turn_id } : {};
  return p;
}

/**
 * Adds one event to a recording, and returns it. Consecutive chunks of streamed text of one kind join into one event,
 * so a long reply keeps a handful of events, not thousands.
 */
export function record(rec: Recording, type: string, at: number, payload: Record<string, unknown>): Recording {
  if (!RECORDED.has(type)) return rec;
  const p = kept(type, payload);
  const last = rec.events.at(-1);
  if (STREAMED.has(type) && last?.type === type) {
    const joined: RunEvent = { ...last, until: at, payload: { text: `${last.payload.text as string}${p.text as string}` } };
    return { ...rec, events: [...rec.events.slice(0, -1), joined] };
  }
  return { ...rec, events: [...rec.events, { type, at, payload: p }] };
}

/**
 * Whether a tool's result looks failed, and why, from its words alone: Hermes's `tool.complete` and stored tool rows have
 * no failure flag. An `error`, `success: false`, a non-zero `exit_code` or an error `status` in a JSON result, or a
 * result that starts by saying it failed.
 */
export function judgeFailure(result: string | undefined): string | undefined {
  if (!result) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = undefined;
  }
  if (isObj(parsed)) {
    if (typeof parsed.error === "string" && parsed.error.trim()) return firstLine(parsed.error);
    if (isObj(parsed.error) && typeof parsed.error.message === "string") return firstLine(parsed.error.message);
    if (parsed.success === false) return "The result says success: false.";
    if (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) return `It exited with code ${parsed.exit_code}.`;
    if (parsed.status === "error" || parsed.status === "failed") return `The result says status: ${parsed.status}.`;
    return undefined;
  }
  return /^\s*(error|failed|exception|traceback)\b/i.test(result) ? firstLine(result) : undefined;
}

const firstLine = (s: string) => {
  const line = s.trim().split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/** The cost of a turn: how far the chat's stored cost moved between a read before it and one after it. */
function turnCost(before: ChatUsage | undefined, after: ChatUsage | undefined): Pick<Run, "cost" | "costWhy"> {
  if (!before || !after) return { costWhy: "This app didn't read the chat's cost both before and after this reply." };
  const b = before.cost;
  const a = after.cost;
  if (!("usd" in a) || !("usd" in b)) return { costWhy: "Hermes recorded no price for this chat." };
  const cost = a.usd - b.usd;
  return cost < 0 ? { costWhy: "The chat's cost went down during this reply, so it can't be told apart." } : { cost };
}

const QUESTION_NAMES: Record<string, string> = { approval: "Approval", clarify: "Question", sudo: "Sudo password", secret: "Secret" };

/** A watched run's steps, from what this app heard of the turn. */
export function watchedRun(rec: Recording): Run {
  const steps: Step[] = [];
  const end = rec.endedAt ?? rec.events.at(-1)?.until ?? rec.events.at(-1)?.at ?? rec.startedAt;
  let latest = rec.from;
  let outcome: string | undefined;
  let n = 0;
  type Open = { start: number; text: string; reasoning: string };
  let model: Open | undefined = { start: rec.startedAt, text: "", reasoning: "" };
  // Hermes's counters after each model call, by its `calls` count: the latest heard with that count.
  const after = new Map<number, UsageCounters>(rec.from ? [[rec.from.calls, rec.from]] : []);
  const heard = (c: UsageCounters | undefined) => {
    if (c) after.set(c.calls, c);
    return c;
  };
  const tools = new Map<string, { start: number; name: string; args?: unknown }>();
  // The compaction whose progress lines are still coming: anything but a status line or a usage tick ends it.
  let compacting: Step | undefined;
  const questions = new Map<string, { start: number; kind: string; name: string; answer?: string; answeredAt?: number; ended?: string; endedAt?: number }>();

  const closeModel = (at: number) => {
    if (!model) return;
    if (at > model.start || model.text.trim() || model.reasoning.trim())
      steps.push({
        id: `s${n++}`,
        kind: "model",
        name: "Model call",
        start: model.start,
        end: at,
        length: { ms: at - model.start, measured: false },
        ...(model.text.trim() && { text: model.text }),
        ...(model.reasoning.trim() && { reasoning: model.reasoning }),
      });
    model = undefined;
  };
  const openModel = (at: number) => (model ??= { start: at, text: "", reasoning: "" });

  for (const e of rec.events) {
    const p = e.payload;
    const at = e.until ?? e.at;
    if (e.type !== "status.update" && e.type !== "session.usage") compacting = undefined;
    switch (e.type) {
      case "message.delta":
        openModel(e.at).text += typeof p.text === "string" ? p.text : "";
        break;
      case "message.interim":
        // Text beside tool calls, sealed: already in the deltas when Hermes streamed it.
        if (p.already_streamed !== true) openModel(e.at).text += typeof p.text === "string" ? p.text : "";
        break;
      case "reasoning.delta":
      case "reasoning.available":
        openModel(e.at).reasoning += typeof p.text === "string" ? p.text : "";
        break;
      case "session.usage":
        latest = heard(countersOf(p.usage)) ?? latest;
        break;
      case "tool.start": {
        closeModel(e.at);
        const id = typeof p.tool_id === "string" ? p.tool_id : `t${n}`;
        tools.set(id, { start: e.at, name: typeof p.name === "string" ? p.name : "tool", args: p.args });
        break;
      }
      case "tool.complete": {
        const id = typeof p.tool_id === "string" ? p.tool_id : "";
        const started = tools.get(id);
        tools.delete(id);
        const measured = typeof p.duration_s === "number" && Number.isFinite(p.duration_s) && p.duration_s >= 0 ? p.duration_s * 1000 : undefined;
        const start = started?.start ?? (measured !== undefined ? at - measured : at);
        // With `display.tool_progress: off`, Hermes still sends some tools' completion without their start (a result
        // that needs the owner): the model call ended when the tool began.
        if (!started && model) closeModel(Math.max(model.start, start));
        const result = typeof p.result === "string" ? p.result : undefined;
        const failed = judgeFailure(result);
        steps.push({
          id: `s${n++}`,
          kind: "tool",
          name: started?.name ?? (typeof p.name === "string" ? p.name : "tool"),
          start,
          end: at,
          length: measured !== undefined ? { ms: measured, measured: true } : { ms: at - start, measured: false },
          ...(failed && { failed, judged: true }),
          ...((started?.args ?? p.args) !== undefined && { args: started?.args ?? p.args }),
          ...(result !== undefined && { result }),
        });
        // The next model call starts once every tool it asked for is done.
        if (!tools.size) openModel(at);
        break;
      }
      case "request": {
        const id = typeof p.id === "string" ? p.id : `q${n}`;
        const kind = typeof p.kind === "string" ? p.kind : "question";
        // Hermes lists a waiting Question again after a reconnect: it began when first asked.
        if (!questions.has(id)) questions.set(id, { start: e.at, kind, name: typeof p.name === "string" && p.name ? p.name : (QUESTION_NAMES[kind] ?? "Question") });
        break;
      }
      case "answer": {
        const q = questions.get(typeof p.id === "string" ? p.id : "");
        if (q) Object.assign(q, { answer: typeof p.answer === "string" ? p.answer : "answered", answeredAt: e.at });
        break;
      }
      case "request.cancel": {
        const q = questions.get(typeof p.id === "string" ? p.id : "");
        if (q && !q.answeredAt) Object.assign(q, { ended: typeof p.reason === "string" ? p.reason : "cancelled", endedAt: e.at });
        break;
      }
      case "approval.cancelled":
        for (const id of Array.isArray(p.request_ids) ? p.request_ids : []) {
          const q = questions.get(String(id));
          if (q && !q.answeredAt) Object.assign(q, { ended: typeof p.reason === "string" ? p.reason : "cancelled", endedAt: e.at });
        }
        break;
      case "status.update": {
        const kind = typeof p.kind === "string" ? p.kind : "status";
        const compaction = kind === "compacting" || kind === "compressing" || kind === "compacted";
        // Hermes repeats a compaction's progress line, and only a turn-isolated one sends `compacted` at the end
        // (`tui_gateway/compute_host_bridge.py`): one compaction spans its lines in a row, to `compacted` when that comes.
        if (compaction && compacting) {
          compacting.end = e.at;
          compacting.length = { ms: e.at - compacting.start, measured: false };
          if (typeof p.text === "string") compacting.text = `${compacting.text ?? ""}\n${p.text}`.trim();
          if (kind === "compacted") {
            compacting.note = "Ended when Hermes said the compaction was complete.";
            compacting = undefined;
          }
          break;
        }
        steps.push({
          id: `s${n++}`,
          kind: compaction ? "compaction" : "status",
          name: compaction ? "Compaction" : `Status (${kind})`,
          start: e.at,
          end: e.at,
          ...(typeof p.text === "string" && { text: p.text }),
        });
        compacting = compaction && kind !== "compacted" ? steps.at(-1) : undefined;
        break;
      }
      case "error":
        steps.push({ id: `s${n++}`, kind: "error", name: "Error", start: e.at, end: e.at, failed: typeof p.message === "string" ? p.message : "Hermes reported an error." });
        break;
      case "message.complete": {
        latest = heard(countersOf(p.usage)) ?? latest;
        // A provider that doesn't stream sends the last call's words only here. `response_reused`: they were delivered
        // already, in this call or an earlier one.
        if (model && !model.text.trim() && p.response_reused !== true && typeof p.text === "string") model.text = p.text;
        if (model && !model.reasoning.trim() && typeof p.reasoning === "string") model.reasoning = p.reasoning;
        const failure = typeof p.failure_reason === "string" && p.failure_reason ? p.failure_reason : typeof p.error === "string" && p.error ? p.error : undefined;
        if (p.status === "interrupted") outcome = "Stopped before it finished.";
        else if (p.status === "error" || failure) outcome = failure ? `Failed: ${failure}` : "Failed.";
        break;
      }
    }
  }
  closeModel(end);
  for (const [, t] of tools)
    steps.push({ id: `s${n++}`, kind: "tool", name: t.name, start: t.start, end, length: { ms: end - t.start, measured: false }, args: t.args, note: "No tool.complete arrived for this tool before the turn ended." });
  for (const [, q] of questions) {
    const stop = q.answeredAt ?? q.endedAt ?? end;
    steps.push({
      id: `s${n++}`,
      kind: "question",
      name: q.name,
      start: q.start,
      end: stop,
      length: { ms: stop - q.start, measured: false },
      text: q.answer ? `Answered from here: ${q.answer}` : q.ended ? `Hermes stopped waiting: ${q.ended}` : "No answer from here before the turn ended.",
      ...(q.ended && !q.answer && { failed: `Hermes stopped waiting: ${q.ended}` }),
    });
  }
  const calls = steps.filter((s) => s.kind === "model");
  // No counters heard during the turn: nothing to say of its calls.
  if (latest === rec.from) latest = undefined;
  const base = rec.from?.calls ?? (latest ? latest.calls - calls.length : undefined);
  if (latest && base !== undefined && latest.calls - base === calls.length)
    calls.forEach((s, i) => {
      const before = after.get(base + i);
      const now = after.get(base + i + 1);
      const tokens = before && now ? replyUsage(before, now) : undefined;
      if (tokens) s.tokens = tokens;
    });
  else if (latest && base !== undefined)
    for (const s of calls)
      s.note = `Hermes counted ${latest.calls - base} model calls in this reply, and this app saw ${calls.length} between tool calls, so tokens aren't given per call.`;
  const tokens = rec.from && latest ? replyUsage(rec.from, latest) : undefined;
  steps.sort((a, b) => a.start - b.start || a.end - b.end);
  return { source: "watched", start: rec.startedAt, end, steps, ...(tokens && { tokens }), ...turnCost(rec.costBefore, rec.costAfter), ...(outcome && { outcome }), turnIds: rec.events.some((e) => e.type === "message.start" && typeof e.payload.turn_id === "string") };
}

/** One row of `GET /api/sessions/{id}/messages`, as far as a stored run reads it. `tool_calls` comes decoded, or as JSON text. */
export type StoredRunRow = {
  id: number;
  role: string;
  content?: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
};

type ToolCall = { id: string; name: string; args?: unknown };

/** The tool calls an assistant row asked for, in the OpenAI shape Hermes stores. */
function toolCallsOf(raw: unknown): ToolCall[] {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((c): ToolCall[] => {
    if (!isObj(c) || typeof c.id !== "string") return [];
    const f = isObj(c.function) ? c.function : {};
    let args: unknown = f.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // Kept as the text Hermes stored.
      }
    }
    return [{ id: c.id, name: typeof f.name === "string" ? f.name : "tool", ...(args !== undefined && { args }) }];
  });
}

/** A stored Hermes time (Unix seconds) in ms. */
const msOf = (s: unknown) => (typeof s === "number" && s > 0 && s * 1000 <= 8.64e15 ? s * 1000 : undefined);

/**
 * A stored run: the turn holding row `rowId`, from the user row that began it to the row before the next one. Each
 * step's length is the gap since the row before it: a row is stamped when its step ended. Undefined when the rows
 * don't hold that row.
 */
export function storedRun(rows: StoredRunRow[], rowId: number): Run | undefined {
  const at = rows.findIndex((r) => r.id === rowId);
  if (at < 0) return undefined;
  let from = at;
  while (from > 0 && rows[from].role !== "user") from--;
  let to = at + 1;
  while (to < rows.length && rows[to].role !== "user") to++;
  const calls = new Map<string, ToolCall & { together: number }>();
  const steps: Step[] = [];
  const first = msOf(rows[from].timestamp);
  let prev = first;
  for (const row of rows.slice(rows[from].role === "user" ? from + 1 : from, to)) {
    const end = msOf(row.timestamp);
    const start = prev ?? end;
    const length = start !== undefined && end !== undefined ? { ms: Math.max(0, end - start), measured: false } : undefined;
    const content = typeof row.content === "string" ? row.content : text(row.content);
    if (row.role === "assistant") {
      const asked = toolCallsOf(row.tool_calls);
      for (const c of asked) calls.set(c.id, { ...c, together: asked.length });
      steps.push({
        id: `r${row.id}`,
        kind: "model",
        name: "Model call",
        start: start ?? 0,
        end: end ?? start ?? 0,
        ...(length && { length }),
        ...(content?.trim() && { text: content }),
        ...(row.reasoning?.trim() && { reasoning: row.reasoning }),
        ...(asked.length && { note: `Asked for ${asked.map((c) => c.name).join(", ")}.` }),
      });
    } else if (row.role === "tool") {
      const call = row.tool_call_id ? calls.get(row.tool_call_id) : undefined;
      const result = content === undefined ? undefined : clip(content);
      const failed = judgeFailure(result);
      steps.push({
        id: `r${row.id}`,
        kind: "tool",
        name: row.tool_name || call?.name || "tool",
        start: start ?? 0,
        end: end ?? start ?? 0,
        ...(length && { length }),
        ...(failed && { failed, judged: true }),
        ...(call?.args !== undefined && { args: call.args }),
        ...(result !== undefined && { result }),
        ...(call && call.together > 1 && { note: `Run together with ${call.together - 1} other tool call${call.together > 2 ? "s" : ""}: Hermes adds their results after all of them ran, so this gap isn't this tool's own length.` }),
      });
    } else continue;
    if (end !== undefined) prev = end;
  }
  const times = steps.map((s) => s.end).filter((t) => t > 0);
  const start = first ?? steps[0]?.start ?? 0;
  return { source: "stored", start, end: times.length ? Math.max(start, ...times) : start, steps, costWhy: "This app didn't watch this reply, so it has no read of the chat's cost from before and after it." };
}

/** How many finished runs this app keeps per chat, in memory, for the Run view. */
export const RUNS_KEPT = 30;

/**
 * Whether Hermes sends ordinary tool steps, as `display.tool_progress` in the profile's config sets it: `mode` as Hermes
 * reads it, or `why` it couldn't be read. With `off`, only file edits, `delegate_task`, `clarify` and a few card tools
 * send tool events (`tui_gateway/agent_factory.py` `_TOOL_LIFECYCLE_UI_TOOLS`).
 */
export type ToolProgress = { mode: "off" | "new" | "all" | "verbose" } | { why: string };

/** What the Run view shows: the run, and whether Hermes sends ordinary tool steps for the profile. */
export type RunView = { run: Run; toolProgress: ToolProgress };

const MODES = ["off", "new", "all", "verbose"] as const;

/**
 * `display.tool_progress` in a `GET /api/config` answer, read as Hermes `_load_tool_progress_mode` reads it: a boolean
 * is `all` or `off`, an unknown or missing value is `all`. Undefined when the answer isn't a config. The
 * `HERMES_TUI_TOOL_PROGRESS` environment variable on the server overrides it, and no route shows that.
 */
export function toolProgressOf(config: unknown): (typeof MODES)[number] | undefined {
  if (!isObj(config)) return undefined;
  const raw = isObj(config.display) ? config.display.tool_progress : undefined;
  if (typeof raw === "boolean") return raw ? "all" : "off";
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return MODES.find((m) => m === mode) ?? "all";
}
