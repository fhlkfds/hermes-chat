// Standing missions (issue #603, ADR 0187): a chat's goal as Hermes keeps it, and the calls that set and change it.
// Read in Hermes's source at `b200f5bc`, `bf0203a` and `f0d9488`, where every file below is the same:
// `tui_gateway/methods_session_control.py` (session.control.read, session.control and their snapshot),
// `hermes_cli/goal_command.py` (the /goal grammar), `hermes_cli/goals.py` (contract lines, checks and the judge) and
// `tui_gateway/methods_tools.py` `_cmd_goal`.
import type { Rpc } from "./commands";
import { errorText, isObj } from "./values";

/** A check's limits, fixed in Hermes (`DEFAULT_GATE_TIMEOUT_SECONDS`, `DEFAULT_GATE_MAX_RETRIES`): /goal can't change them. */
export const CHECK_TIMEOUT_SECONDS = 300;
export const CHECK_MAX_RETRIES = 3;
/** The profile's `goals.max_turns` when it doesn't set one (`hermes_cli/config_defaults.py`). */
export const DEFAULT_MAX_TURNS = 20;

export const CONTRACT_FIELDS = ["outcome", "verification", "constraints", "boundaries", "stop_when"] as const;
export type Contract = Record<(typeof CONTRACT_FIELDS)[number], string>;

/** A check (Hermes's "gate"): a shell command that must exit 0 before the judge is asked whether the goal is done. */
export type Check = { command: string; timeoutSeconds: number; maxRetries: number; attempts: number; lastExitCode: number | null };

export type WaitBarrier = { kind: "until"; until: number; reason: string } | { kind: "session" | "process"; target: string; reason: string };

export type Goal = {
  title: string;
  status: "active" | "paused" | "done";
  turnsUsed: number;
  maxTurns: number;
  contract: Contract;
  subgoals: string[];
  checks: Check[];
  pausedReason?: string;
  lastVerdict?: string;
  lastReason?: string;
  waitBarrier?: WaitBarrier;
};

/** A chat's `session.control` snapshot, as far as this app reads it: its goal, none when cleared, and its revision. */
export type Control = { goal: Goal | null; revision: string };

const text = (v: unknown) => (typeof v === "string" ? v : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined);
const optional = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function checkOf(raw: unknown): Check | undefined {
  if (!isObj(raw) || typeof raw.command !== "string") return undefined;
  return {
    command: raw.command,
    timeoutSeconds: int(raw.timeout_seconds) ?? CHECK_TIMEOUT_SECONDS,
    maxRetries: int(raw.max_retries) ?? CHECK_MAX_RETRIES,
    attempts: int(raw.attempts) ?? 0,
    lastExitCode: int(raw.last_exit_code) ?? null,
  };
}

function barrierOf(raw: unknown): WaitBarrier | undefined {
  if (!isObj(raw)) return undefined;
  const reason = text(raw.reason);
  if (raw.type === "until" && typeof raw.until_at === "number") return { kind: "until", until: raw.until_at * 1000, reason };
  if ((raw.type === "session" || raw.type === "pid") && (typeof raw.target === "string" || typeof raw.target === "number"))
    return { kind: raw.type === "pid" ? "process" : "session", target: String(raw.target), reason };
  return undefined;
}

function goalOf(raw: unknown): Goal | undefined {
  if (!isObj(raw) || typeof raw.title !== "string") return undefined;
  if (raw.status !== "active" && raw.status !== "paused" && raw.status !== "done") return undefined;
  const contract = isObj(raw.contract) ? raw.contract : {};
  const checks = (Array.isArray(raw.gates) ? raw.gates : []).map(checkOf);
  if (checks.some((c) => !c)) return undefined;
  const barrier = barrierOf(raw.wait_barrier);
  return {
    title: raw.title,
    status: raw.status,
    turnsUsed: int(raw.turns_used) ?? 0,
    maxTurns: int(raw.max_turns) ?? DEFAULT_MAX_TURNS,
    contract: Object.fromEntries(CONTRACT_FIELDS.map((f) => [f, text(contract[f])])) as Contract,
    subgoals: (Array.isArray(raw.subgoals) ? raw.subgoals : []).filter((s): s is string => typeof s === "string"),
    checks: checks as Check[],
    ...(optional(raw.paused_reason) && { pausedReason: raw.paused_reason as string }),
    ...(optional(raw.last_verdict) && { lastVerdict: raw.last_verdict as string }),
    ...(optional(raw.last_reason) && { lastReason: raw.last_reason as string }),
    ...(barrier && { waitBarrier: barrier }),
  };
}

/**
 * The control snapshot in an answer or event that carries `{control}`: `session.control.read`, `session.control` and
 * `session.control.update`. Undefined when it isn't one this app can read, such as a goal with a status it doesn't know.
 */
export function controlOf(answer: unknown): Control | undefined {
  const c = isObj(answer) ? answer.control : undefined;
  if (!isObj(c)) return undefined;
  if (c.goal === null || c.goal === undefined) return { goal: null, revision: text(c.revision) };
  const goal = goalOf(c.goal);
  return goal && { goal, revision: text(c.revision) };
}

/** The profile's turn budget from a `GET /api/config` answer (`goals.max_turns`), undefined when it doesn't say. */
export function maxTurnsOf(config: unknown): number | undefined {
  const goals = isObj(config) && isObj(config.goals) ? config.goals : undefined;
  const n = int(goals?.max_turns);
  return n !== undefined && n > 0 ? n : undefined;
}

/** What the owner fills in Set a goal. `check` is empty for a goal the judge alone decides. */
export type GoalDraft = { outcome: string; mustNot: string; check: string };

/** Line prefixes Hermes reads as a contract field rather than the goal's title (`_CONTRACT_ALIASES`). */
const CONTRACT_PREFIXES = new Set([
  "outcome", "goal", "done", "done when", "verification", "verify", "verified by", "evidence", "proof", "constraints", "constraint",
  "preserve", "must not", "do not change", "boundaries", "boundary", "scope", "allowed", "files", "stop when", "stop_when", "blocked",
  "stop if blocked", "give up when",
]);

/** Hermes splits the goal text by line, so each field goes as one line with its inner whitespace collapsed. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The argument of the `/goal` that sets the draft: `--` so an outcome starting with a control word such as "pause" is
 * still the goal's text, the outcome as the first line, then `must not: …` for what must not change.
 */
export function goalArg(d: GoalDraft): string {
  const mustNot = oneLine(d.mustNot);
  return [`-- ${oneLine(d.outcome)}`, ...(mustNot ? [`must not: ${mustNot}`] : [])].join("\n");
}

/** The argument of the `/goal` that adds the draft's check: the rest of the line is the command, as typed. */
export const checkArg = (d: GoalDraft) => `gate add ${d.check.trim()}`;

/** Why the draft can't be set as it is, or undefined when it can. */
export function draftProblem(d: GoalDraft): string | undefined {
  const outcome = oneLine(d.outcome);
  if (!outcome) return "Say what done looks like.";
  const [prefix, value] = [outcome.slice(0, outcome.indexOf(":")), outcome.slice(outcome.indexOf(":") + 1)];
  if (outcome.includes(":") && CONTRACT_PREFIXES.has(prefix.trim().toLowerCase()) && value.trim())
    return `Hermes would read “${prefix.trim()}:” at the start as a contract line, not as the goal. Reword the start of the outcome.`;
  if (/[\r\n]/.test(d.check)) return "The check has to be one line.";
  return undefined;
}

/** What Hermes stores for the draft, as `parse_contract` and `add_gate` read its two `/goal` lines. */
export function expectedGoal(d: GoalDraft): { title: string; contract: Contract; checks: string[] } {
  const contract = Object.fromEntries(CONTRACT_FIELDS.map((f) => [f, ""])) as Contract;
  contract.constraints = oneLine(d.mustNot);
  return { title: oneLine(d.outcome), contract, checks: d.check.trim() ? [d.check.trim()] : [] };
}

/** How the goal read back differs from the draft, in the owner's words, or undefined when it is what was sent. */
export function readBackProblem(control: Control, d: GoalDraft): string | undefined {
  const goal = control.goal;
  if (!goal) return "Hermes shows no goal for this chat after setting it.";
  const want = expectedGoal(d);
  if (goal.title !== want.title) return `Hermes saved the goal as “${goal.title}”, not as you wrote it.`;
  if (CONTRACT_FIELDS.some((f) => goal.contract[f] !== want.contract[f])) return "Hermes saved a different contract from the one you wrote.";
  const got = goal.checks.map((c) => c.command);
  if (got.length !== want.checks.length || got.some((c, i) => c !== want.checks[i]))
    return got.length ? `Hermes saved the check as ${got.map((c) => `“${c}”`).join(", ")}, not as you wrote it.` : "Hermes saved the goal without its check.";
  return undefined;
}

/** A write that Hermes made but that didn't come out as asked: `control` is what Hermes shows now. */
export class GoalWriteError extends Error {
  constructor(
    message: string,
    readonly control?: Control,
  ) {
    super(message);
  }
}

/** The chat's control snapshot, from its live session `sid`. */
export async function readControl(rpc: Rpc, sid: string): Promise<Control> {
  const control = controlOf(await rpc("session.control.read", { session_id: sid }));
  if (!control) throw new Error("Hermes answered with a goal Highwing can't read.");
  return control;
}

/**
 * Sets the draft as the chat's goal, in its live session `sid`: refused when the chat's goal changed since `seen` (the
 * revision the owner looked at), then `/goal` with the outcome and what must not change, then `/goal gate add` with the
 * check, then a read back that must match what was sent. `refusal` is asked before each write, and says why it mustn't
 * go now. Resolves with that read and the message Hermes wants sent as the chat's next turn, which is what starts the
 * goal. Rejects saying what happened, with no turn started.
 */
export async function setGoal(rpc: Rpc, sid: string, d: GoalDraft, seen: string, refusal: () => string | undefined = () => undefined): Promise<{ control: Control; kickoff: string }> {
  const problem = draftProblem(d) ?? refusal();
  if (problem) throw new Error(problem);
  const before = await readControl(rpc, sid);
  if (before.revision !== seen)
    throw new GoalWriteError("This chat's goal changed since you opened Set a goal, so nothing was saved. Look at the goal, then set it again.", before);
  const now = refusal();
  if (now) throw new Error(`${now} Nothing was saved.`);
  const set = await rpc("command.dispatch", { name: "goal", arg: goalArg(d), session_id: sid });
  if (!isObj(set) || set.type !== "send" || typeof set.message !== "string" || !set.message)
    throw new GoalWriteError("Hermes didn't answer /goal as it does when it sets a goal, so nothing was started.", await readControl(rpc, sid).catch(() => undefined));
  if (d.check.trim()) {
    try {
      const late = refusal();
      if (late) throw new Error(late);
      await rpc("command.dispatch", { name: "goal", arg: checkArg(d), session_id: sid });
    } catch (e) {
      throw new GoalWriteError(`Hermes set the goal but didn't add its check: ${errorText(e).replace(/\.?$/, ".")} Nothing was started.`, await readControl(rpc, sid).catch(() => undefined));
    }
  }
  const after = await readControl(rpc, sid);
  const wrong = readBackProblem(after, d);
  if (wrong) throw new GoalWriteError(`${wrong} Nothing was started.`, after);
  return { control: after, kickoff: set.message };
}

export type GoalAction = "goal.pause" | "goal.resume" | "goal.clear";

const SETTLES: Record<GoalAction, { done: (c: Control) => boolean; shown: string }> = {
  "goal.pause": { done: (c) => c.goal?.status === "paused", shown: "paused" },
  "goal.resume": { done: (c) => c.goal?.status === "active", shown: "running" },
  "goal.clear": { done: (c) => c.goal === null, shown: "cleared" },
};

/**
 * Pauses, resumes or clears the chat's goal in its live session `sid` (`session.control`), then reads it back. Resolves
 * with that read and, for a resume, the message Hermes wants sent as the chat's next turn: a resume starts nothing
 * until it goes. Rejects when the read back doesn't show the goal so.
 */
export async function goalAction(rpc: Rpc, sid: string, action: GoalAction): Promise<{ control: Control; next?: string }> {
  const res = await rpc("session.control", { session_id: sid, action });
  const dispatch = isObj(res) && isObj(res.dispatch) ? res.dispatch : undefined;
  const after = await readControl(rpc, sid);
  if (!SETTLES[action].done(after)) throw new GoalWriteError(`Hermes took it, but the goal doesn't show as ${SETTLES[action].shown}.`, after);
  const next = action === "goal.resume" && dispatch?.type === "send" && typeof dispatch.message === "string" && dispatch.message ? dispatch.message : undefined;
  return { control: after, ...(next && { next }) };
}

/** Each chat's goal as last read or sent by Hermes, by chat id, for the goal bar. */
export class GoalBoard {
  private byChat = new Map<string, Control>();
  private listeners = new Set<() => void>();

  get = (chatId: string): Control | undefined => this.byChat.get(chatId);

  put(chatId: string, control: Control) {
    this.byChat.set(chatId, control);
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
}
