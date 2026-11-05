// The Subagents a chat's reply started (Hermes's `delegate_task`), as one tree per chat on this connection (ADR 0069).
// Hermes reports them two ways: `subagent.*` events on the chat's session while they run
// (`tui_gateway/contracts/events.py` SubagentEventPayload), and `subagent.list`, its live roster plus recently failed
// background delegations (`tui_gateway/methods_subagents.py`). Both go through the pure functions here, so events in any
// order, repeats, and a reconnect's roster all end in the same tree. Nothing here is kept on this computer.

export type SubagentId = string & { readonly __subagent: unique symbol };

/**
 * Hermes's own lifecycle (`SubagentStatus`), plus `unknown`: the app knows the subagent was there but not how it is
 * now, as when it ended while the app was disconnected and Hermes no longer lists it.
 */
export type SubagentState = "queued" | "running" | "completed" | "failed" | "error" | "timeout" | "interrupted" | "unknown";

const HERMES_STATES = new Set<string>(["queued", "running", "completed", "failed", "error", "timeout", "interrupted"]);
const ENDED = new Set<SubagentState>(["completed", "failed", "error", "timeout", "interrupted"]);
/** Hermes's last word on it: no later event or roster changes its state. */
export const hasEnded = (s: SubagentState) => ENDED.has(s);
export const isFailure = (s: SubagentState) => s === "failed" || s === "error" || s === "timeout";

/** One thing a subagent did. `seq`: its tool call's number, which Hermes counts per subagent. */
export type SubagentActivity =
  | { kind: "tool"; at: number; seq?: number; tool: string; preview?: string }
  | { kind: "thinking"; at: number; text: string }
  | { kind: "ended"; at: number; text: string };

export type Subagent = {
  id: SubagentId;
  /** The subagent that started it; none for one the chat's own reply started. */
  parent?: SubagentId;
  depth: number;
  /** Its goal, as the agent that started it wrote it. Empty while only its own subagents have been heard from. */
  goal: string;
  model?: string;
  /** Its `delegate_task` call, shared by the subagents one call started, and its place among them. */
  delegationId?: string;
  taskIndex?: number;
  taskCount?: number;
  state: SubagentState;
  startedAt?: number;
  /** When the app last heard of it doing something, and what. */
  lastActivity?: { at: number; text: string };
  toolCount?: number;
  /** Hermes takes a steer for it now. Only `subagent.list` says; undefined until it has. */
  acceptingSteer?: boolean;
  /** How it ended, in Hermes's words: its summary, or the error. */
  summary?: string;
  durationS?: number;
  /** What it did that the app heard of, oldest first, at most `ACTIVITY_MAX`. */
  activity: SubagentActivity[];
  /** The app heard of it only part way: what it did before isn't in `activity`. */
  partial?: boolean;
  /** Known only from Hermes's store of failed background delegations: there's no running subagent to steer or stop. */
  stored?: boolean;
};

/**
 * Whether the tree is current. `live`: this connection hears its events, and Hermes's roster agreed. `lost`: the
 * connection dropped at `since`, so states are as last heard. `unchecked`: connected again, but Hermes couldn't say what
 * happened meanwhile (`why`).
 */
export type SubagentSync = { kind: "live" } | { kind: "lost"; since: number } | { kind: "unchecked"; why: string };

export type SubagentTree = { subagents: Subagent[]; sync: SubagentSync };

export const ACTIVITY_MAX = 200;
export const SUBAGENTS_MAX = 100;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** A Hermes time (Unix seconds) in ms. */
const secondsAt = (v: unknown) => {
  const s = num(v);
  return s !== undefined && s > 0 && s * 1000 <= 8.64e15 ? s * 1000 : undefined;
};

/**
 * The id an event names it by. An older Hermes sends no `subagent_id`; its subagents are told apart by their
 * `delegate_task` call and place in it, and can't be steered or stopped, since Hermes has no id to take.
 */
function idOf(p: Record<string, unknown>): SubagentId | undefined {
  const id = str(p.subagent_id);
  if (id) return id as SubagentId;
  const index = int(p.task_index);
  return index === undefined ? undefined : (`task:${str(p.delegation_id) ?? ""}:${index}` as SubagentId);
}
export const isSteerable = (s: Subagent) => !s.stored && !s.id.startsWith("task:");

/** Hermes's `status`, as this app's state; `fallback` for a status Hermes doesn't define. */
function stateOf(v: unknown, fallback: SubagentState): SubagentState {
  const s = str(v)?.toLowerCase();
  return s && HERMES_STATES.has(s) ? (s as SubagentState) : fallback;
}

/** What an event or roster row says about a subagent, before it meets the tree. */
type Report = Partial<Omit<Subagent, "id" | "activity">> & { id: SubagentId; activity?: SubagentActivity };

function identity(p: Record<string, unknown>, id: SubagentId): Report {
  const parent = str(p.parent_id);
  return {
    id,
    ...(parent && { parent: parent as SubagentId }),
    ...(int(p.depth) !== undefined && { depth: int(p.depth) }),
    ...(str(p.goal) && { goal: str(p.goal)!.trim() }),
    ...(str(p.model) && { model: str(p.model) }),
    ...(str(p.delegation_id) && { delegationId: str(p.delegation_id) }),
    ...(int(p.task_index) !== undefined && { taskIndex: int(p.task_index) }),
    ...(int(p.task_count) !== undefined && { taskCount: int(p.task_count) }),
    ...(int(p.tool_count) !== undefined && { toolCount: int(p.tool_count) }),
  };
}

/** One `subagent.*` event as a report, or none for one this app doesn't follow or can't place. */
function eventReport(type: string, payload: unknown, at: number): Report | undefined {
  const p = obj(payload);
  const id = p && idOf(p);
  if (!p || !id) return undefined;
  const base = identity(p, id);
  switch (type) {
    case "subagent.spawn_requested":
      return { ...base, state: "queued", partial: false };
    case "subagent.start":
      return { ...base, state: "running", partial: false, lastActivity: { at, text: "Started" } };
    // Batched tool names, which `subagent.tool` has already reported one by one.
    case "subagent.progress":
      return { ...base, state: "running" };
    case "subagent.tool": {
      const tool = str(p.tool_name) ?? "tool";
      const preview = str(p.tool_preview) ?? str(p.text);
      const seq = int(p.tool_count);
      return {
        ...base,
        state: "running",
        lastActivity: { at, text: preview ? `${tool}: ${preview}` : tool },
        activity: { kind: "tool", at, tool, ...(seq !== undefined && { seq }), ...(preview && { preview }) },
      };
    }
    // Its reasoning, which Hermes leaves out unless the chat shows reasoning.
    case "subagent.thinking": {
      const text = str(p.text);
      return { ...base, state: "running", ...(text && { activity: { kind: "thinking", at, text } }) };
    }
    case "subagent.complete": {
      // A completion without a status Hermes defines says it ended, not how.
      const state = stateOf(p.status, "unknown");
      const summary = str(p.summary)?.trim();
      return {
        ...base,
        state: state === "running" || state === "queued" ? "unknown" : state,
        ...(summary && { summary }),
        ...(num(p.duration_seconds) !== undefined && { durationS: num(p.duration_seconds) }),
        lastActivity: { at, text: ENDED_TEXT[state] ?? "Ended" },
        activity: { kind: "ended", at, text: ENDED_TEXT[state] ?? "Ended" },
      };
    }
    default:
      return undefined;
  }
}

const ENDED_TEXT: Partial<Record<SubagentState, string>> = {
  completed: "Finished",
  failed: "Failed",
  error: "Failed with an error",
  timeout: "Timed out",
  interrupted: "Stopped",
};

const blank = (id: SubagentId): Subagent => ({ id, depth: 0, goal: "", state: "unknown", activity: [] });

/**
 * Keeps the activity in order, once each: a tool call Hermes numbered goes in its place, a repeat is dropped, and
 * the end stays last, since anything heard after it happened before it.
 */
function withActivity(log: SubagentActivity[], a: SubagentActivity): SubagentActivity[] {
  const end = log.findIndex((x) => x.kind === "ended");
  if (a.kind === "ended") return end >= 0 ? log : [...log, a].slice(-ACTIVITY_MAX);
  if (a.kind === "tool" && a.seq !== undefined && log.some((x) => x.kind === "tool" && x.seq === a.seq)) return log;
  const later = a.kind === "tool" && a.seq !== undefined ? log.findIndex((x) => x.kind === "tool" && x.seq !== undefined && x.seq > a.seq!) : -1;
  const at = later >= 0 ? later : end >= 0 ? end : log.length;
  return [...log.slice(0, at), a, ...log.slice(at)].slice(-ACTIVITY_MAX);
}

/**
 * The state after a report. Once Hermes has said how it ended, nothing later changes it, so a late event from before
 * the end can't bring it back. Queued is the earliest state, so a request heard after the start doesn't undo it.
 */
function nextState(was: SubagentState, reported?: SubagentState): SubagentState {
  if (!reported || hasEnded(was)) return was;
  if (reported === "queued") return was === "unknown" ? "queued" : was;
  return reported;
}

function merged(s: Subagent, r: Report): Subagent {
  const { activity, state, lastActivity, ...fields } = r;
  return {
    ...s,
    ...fields,
    state: nextState(s.state, state),
    lastActivity: lastActivity && (!s.lastActivity || lastActivity.at >= s.lastActivity.at) ? lastActivity : s.lastActivity,
    activity: activity ? withActivity(s.activity, activity) : s.activity,
  };
}

/** The tree with `reports` applied, in the order the app first heard of each subagent, at most `SUBAGENTS_MAX`. */
function applied(tree: SubagentTree | undefined, reports: Report[], fresh: (r: Report) => Partial<Subagent> = () => ({})): SubagentTree {
  const subagents = [...(tree?.subagents ?? [])];
  const at = new Map(subagents.map((s, i) => [s.id, i]));
  const place = (id: SubagentId, make: () => Subagent) => {
    if (!at.has(id)) {
      at.set(id, subagents.length);
      subagents.push(make());
    }
    return at.get(id)!;
  };
  for (const r of reports) {
    // A subagent heard from before the one that started it: the parent shows, undescribed, until it is.
    if (r.parent) place(r.parent, () => ({ ...blank(r.parent!), depth: Math.max(0, (r.depth ?? 1) - 1), partial: true }));
    const i = place(r.id, () => ({ ...blank(r.id), ...fresh(r) }));
    subagents[i] = merged(subagents[i], r);
  }
  return { subagents: bounded(subagents), sync: tree?.sync ?? { kind: "live" } };
}

/** Lets go of the subagents first heard of longest ago that have ended, past `SUBAGENTS_MAX`, and their ended children. */
function bounded(subagents: Subagent[]): Subagent[] {
  let extra = subagents.length - SUBAGENTS_MAX;
  if (extra <= 0) return subagents;
  const drop = new Set<SubagentId>();
  for (const s of subagents) {
    if (extra <= 0) break;
    if (hasEnded(s.state) && !subagents.some((c) => c.parent === s.id && !hasEnded(c.state) && !drop.has(c.id))) {
      drop.add(s.id);
      extra--;
    }
  }
  return subagents.filter((s) => !drop.has(s.id));
}

/** The tree with one `subagent.*` event applied; the tree as it was for an event this app doesn't follow. */
export function onSubagentEvent(tree: SubagentTree | undefined, type: string, payload: unknown, at: number): SubagentTree | undefined {
  const r = eventReport(type, payload, at);
  // One first heard of after it started has done things the app didn't hear, until its start turns up.
  return r ? applied(tree, [r], () => ({ partial: true })) : tree;
}

/**
 * The tree with Hermes's roster (`subagent.list`) applied, now `live`. Hermes lists the subagents still running, and
 * background delegations that failed lately. A running subagent the roster leaves out has ended without the app
 * hearing how, so it's `unknown`. The roster is also how the app hears of a nested subagent's tools: Hermes relays only
 * its start and end (`delegate_tool_progress._normalize_event` drops the rest). Undefined when there's no tree and
 * nothing listed.
 */
export function onRoster(tree: SubagentTree | undefined, result: unknown, at: number): SubagentTree | undefined {
  const res = obj(result);
  const rows = Array.isArray(res?.subagents) ? res.subagents.map(obj).filter((r) => !!r) : [];
  const failed = Array.isArray(res?.delegations) ? res.delegations.map(obj).filter((r) => !!r) : [];
  const listed: Report[] = [];
  for (const row of rows) {
    const id = str(row.subagent_id);
    if (!id) continue;
    const last = str(row.last_tool);
    const was = tree?.subagents.find((s) => s.id === id);
    // Only the tool's name: it replaces what the events said only when it is news, by Hermes's count of its tools.
    const newer = !was?.lastActivity || (int(row.tool_count) ?? 0) > (was.toolCount ?? 0);
    listed.push({
      ...identity(row, id as SubagentId),
      state: stateOf(row.status, "running"),
      ...(secondsAt(row.started_at) !== undefined && { startedAt: secondsAt(row.started_at) }),
      ...(typeof row.accepting_steer === "boolean" && { acceptingSteer: row.accepting_steer }),
      ...(last && newer && { lastActivity: { at, text: last } }),
    });
  }
  const known = tree?.subagents ?? [];
  const failures: Report[] = [];
  for (const row of failed) {
    const index = int(row.task_index) ?? 0;
    const delegationId = str(row.delegation_id);
    // The live subagent this failure was, when the app knew it; otherwise it stands on its own.
    const match = delegationId && known.find((s) => s.delegationId === delegationId && (s.taskIndex ?? 0) === index);
    const error = str(row.error)?.trim();
    const ended = secondsAt(row.completed_at) ?? at;
    failures.push({
      ...(match ? { id: match.id } : { ...identity(row, `task:${delegationId ?? ""}:${index}` as SubagentId), stored: true }),
      state: stateOf(row.status, "failed"),
      ...(error && { summary: error }),
      ...(!match && secondsAt(row.dispatched_at) !== undefined && { startedAt: secondsAt(row.dispatched_at) }),
      lastActivity: { at: ended, text: "Failed" },
      activity: { kind: "ended", at: ended, text: "Failed" },
    });
  }
  if (!tree && !listed.length && !failures.length) return undefined;
  const ids = new Set([...listed, ...failures].map((r) => r.id));
  // Hermes lists a subagent once it runs. A queued one missing from a roster read while connected throughout just hasn't
  // started; after a drop, it may have come and gone unheard.
  const recovering = tree?.sync.kind !== "live";
  const gone: Report[] = known
    .filter((s) => (s.state === "running" || (s.state === "queued" && recovering)) && !ids.has(s.id))
    .map((s) => ({ id: s.id, state: "unknown" }));
  // One the roster brings that the app hadn't heard of was running before the app could hear it.
  const next = applied(tree, [...listed, ...failures, ...gone], (r) => (r.stored ? {} : { partial: true }));
  return { ...next, sync: { kind: "live" } };
}

/** The connection dropped: the tree stays as last heard until Hermes's roster can be read again. */
export function onLost(tree: SubagentTree | undefined, since: number): SubagentTree | undefined {
  if (!tree || tree.sync.kind === "lost") return tree;
  return { ...tree, sync: { kind: "lost", since } };
}

/** Connected again, but Hermes's roster couldn't be read: the tree's states are as last heard, for `why`. */
export function onUnchecked(tree: SubagentTree | undefined, why: string): SubagentTree | undefined {
  return tree && { ...tree, sync: { kind: "unchecked", why } };
}

/** The subagents `parent` started, or those the chat's reply started for none, in the order first heard of. */
export function childrenOf(tree: SubagentTree, parent?: SubagentId): Subagent[] {
  const ids = new Set(tree.subagents.map((s) => s.id));
  // One whose parent isn't in the tree (let go past the limit) shows at the top rather than not at all.
  return tree.subagents.filter((s) => (parent === undefined ? !s.parent || !ids.has(s.parent) : s.parent === parent));
}

/** Every subagent under `id`, at any depth. */
export function descendantsOf(tree: SubagentTree, id: SubagentId): Subagent[] {
  const out: Subagent[] = [];
  const seen = new Set<SubagentId>([id]);
  for (const parents = [id]; parents.length; ) {
    const p = parents.shift();
    for (const c of tree.subagents)
      if (c.parent === p && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
        parents.push(c.id);
      }
  }
  return out;
}

/** How many are queued or running, and how many failed. */
export function tally(tree: SubagentTree): { running: number; failed: number; total: number } {
  let running = 0;
  let failed = 0;
  for (const s of tree.subagents) {
    if (s.state === "running" || s.state === "queued") running++;
    if (isFailure(s.state)) failed++;
  }
  return { running, failed, total: tree.subagents.length };
}

/** `subagent.tail`: the end of the subagent's live transcript, which Hermes shares only for one it runs for this connection. */
export type SubagentOutput = { available: true; text: string; truncated: boolean } | { available: false };

export function parseOutput(result: unknown): SubagentOutput {
  const r = obj(result);
  if (r?.available !== true || typeof r.text !== "string") return { available: false };
  return { available: true, text: r.text, truncated: r.truncated === true };
}
