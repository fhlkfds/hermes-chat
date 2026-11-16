// FakeHermes's goals (standing missions, ADR 0187): `/goal` through `command.dispatch`, `session.control.read`,
// `session.control` and the judge after a turn, with the shapes Hermes has at `b200f5bc`, `bf0203a` and `f0d9488`
// (`tui_gateway/methods_session_control.py`, `hermes_cli/goal_command.py`, `hermes_cli/goals.py`). Checks don't run
// anything: `exitOf` says what a command would exit with.

type Status = "active" | "paused" | "done";
type Gate = { command: string; timeout_seconds: number; max_retries: number; attempts: number; last_exit_code: number | null };
type GoalRow = {
  title: string;
  status: Status;
  turns_used: number;
  max_turns: number;
  contract: Record<string, string>;
  subgoals: string[];
  gates: Gate[];
  created_at: number;
  updated_at?: number;
  paused_reason?: string;
  last_verdict?: string;
  last_reason?: string;
};

const FIELDS = ["outcome", "verification", "constraints", "boundaries", "stop_when"];
const ALIASES: Record<string, string> = {
  outcome: "outcome", goal: "outcome", done: "outcome", "done when": "outcome",
  verification: "verification", verify: "verification", "verified by": "verification", evidence: "verification", proof: "verification",
  constraints: "constraints", constraint: "constraints", preserve: "constraints", "must not": "constraints", "do not change": "constraints",
  boundaries: "boundaries", boundary: "boundaries", scope: "boundaries", allowed: "boundaries", files: "boundaries",
  "stop when": "stop_when", stop_when: "stop_when", blocked: "stop_when", "stop if blocked": "stop_when", "give up when": "stop_when",
};

/** `parse_contract`: lines `field: value` go to the contract, every other line joins the title. */
function parseContract(text: string): { title: string; contract: Record<string, string> } {
  const title: string[] = [];
  const fields: Record<string, string[]> = Object.fromEntries(FIELDS.map((f) => [f, []]));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    const key = at >= 0 ? ALIASES[line.slice(0, at).trim().toLowerCase()] : undefined;
    const value = at >= 0 ? line.slice(at + 1).trim() : "";
    if (key && value) fields[key].push(value);
    else title.push(line);
  }
  return { title: title.join(" ").trim(), contract: Object.fromEntries(FIELDS.map((f) => [f, fields[f].join(" ").trim()])) };
}

const now = () => Date.now() / 1000;

/** A stand-in for `sha256` of the visible state: equal states, equal revisions. */
function revisionOf(goal: unknown): string {
  if (goal === null) return "";
  let h = 2166136261;
  for (const ch of JSON.stringify(goal)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `rev-${h.toString(16)}`;
}

export type GoalAnswer = { result: Record<string, unknown> } | { error: { code: number; message: string } };

export class FakeGoals {
  /** Each chat's goal by its stored session id, as `state_meta` keeps `goal:<key>` rows. */
  readonly rows = new Map<string, GoalRow>();
  /** The profile's `goals.max_turns`. */
  maxTurns = 20;
  /** What a check's command exits with: 0 unless it says `false` or `exit <n>` for some other n. */
  exitOf: (command: string) => number = (command) => (/\bfalse\b/.test(command) ? 1 : Number(/\bexit\s+(\d+)/.exec(command)?.[1] ?? 0));
  /** What the judge says once every check passes. */
  judge: () => { verdict: "done" | "continue" | "blocked"; reason: string } = () => ({ verdict: "done", reason: "The stand-in judge saw the outcome." });

  /** `_safe_goal_snapshot` and `_snapshot_control`: no loop or heartbeat here. */
  control(stored: string): Record<string, unknown> {
    const row = this.rows.get(stored);
    const goal = row ? { ...row, contract: { ...row.contract }, subgoals: [...row.subgoals], gates: row.gates.map((g) => ({ ...g })) } : null;
    return { goal, loop: null, heartbeat: null, revision: revisionOf(goal), updated_at: row?.updated_at ?? row?.created_at ?? null };
  }

  /** `/goal <arg>` (`dispatch_goal_command` through `_cmd_goal`). */
  command(stored: string, arg: string): GoalAnswer {
    const text = arg.trim();
    const [verb = "", rest = ""] = [text.split(/\s+/, 1)[0]?.toLowerCase(), text.replace(/^\S+\s*/, "")];
    const row = this.rows.get(stored);
    if (verb === "gate") {
      const command = rest.replace(/^add\s*/i, "").trim();
      if (!/^add\b/i.test(rest) || !command) return { error: { code: 4004, message: "Usage: /goal gate [list | add <command> | remove <N> | clear]" } };
      if (!row) return { error: { code: 4004, message: "/goal gate add: no active goal" } };
      row.gates.push({ command, timeout_seconds: 300, max_retries: 3, attempts: 0, last_exit_code: null });
      return { result: { type: "exec", output: `⚿ Gate added: $ ${command} (3 retries, 300s timeout). It must pass before the goal can complete.` } };
    }
    if (verb === "pause" || verb === "resume" || verb === "clear") {
      const action = this.action(stored, `goal.${verb}`);
      return "error" in action ? action : { result: action.result.dispatch as Record<string, unknown> };
    }
    if (verb === "" || verb === "status") return { result: { type: "exec", output: row ? `⊙ Goal (${row.status}): ${row.title}` : "No active goal." } };
    const { title, contract } = parseContract(verb === "--" ? rest : text);
    const goal = title || (verb === "--" ? rest : text).trim();
    if (!goal) return { error: { code: 4004, message: "Invalid goal: goal text is empty" } };
    this.rows.set(stored, { title: goal, status: "active", turns_used: 0, max_turns: this.maxTurns, contract, subgoals: [], gates: [], created_at: now() });
    // `goal_kick_prompt`: the goal's own text is the first turn.
    return { result: { type: "send", notice: `⊙ Goal set (${this.maxTurns}-turn budget): ${goal}`, message: goal } };
  }

  /** `session.control` for the goal actions: `{control, dispatch}`, or Hermes's 4004 refusal. */
  action(stored: string, action: string): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
    if (action.startsWith("goal.gate")) return { error: { code: 4004, message: "gate actions are not allowed through session.control" } };
    const row = this.rows.get(stored);
    let dispatch: Record<string, unknown>;
    if (action === "goal.pause") {
      if (!row) return { error: { code: 4004, message: "No goal set." } };
      Object.assign(row, { status: "paused", paused_reason: "user-paused" });
      dispatch = { type: "exec", output: `⏸ Goal paused: ${row.title}` };
    } else if (action === "goal.resume") {
      if (!row) return { error: { code: 4004, message: "No goal to resume." } };
      Object.assign(row, { status: "active", turns_used: 0 });
      delete row.paused_reason;
      dispatch = { type: "send", notice: `▶ Goal resumed: ${row.title}\nContinuing now — taking the next step.`, message: `[Continuing toward your standing goal] ${row.title}`, display: "/goal resume" };
    } else if (action === "goal.clear") {
      this.rows.delete(stored);
      dispatch = { type: "exec", output: row ? "✓ Goal cleared." : "No active goal." };
    } else return { error: { code: 4004, message: `unknown action: ${action}` } };
    return { result: { control: this.control(stored), dispatch } };
  }

  /**
   * `evaluate_after_turn` for an active goal: counts the turn, runs the checks in order, then asks the judge. Returns the
   * prompt of the turn that follows at once, or undefined when the goal stops here; null when there is no active goal.
   */
  afterTurn(stored: string): string | undefined | null {
    const row = this.rows.get(stored);
    if (!row || row.status !== "active") return null;
    row.turns_used += 1;
    row.updated_at = now();
    for (const gate of row.gates) {
      const exit = this.exitOf(gate.command);
      gate.last_exit_code = exit;
      if (exit === 0) {
        gate.attempts = 0;
        continue;
      }
      gate.attempts += 1;
      if (gate.attempts > gate.max_retries) {
        Object.assign(row, { status: "paused", paused_reason: `quality gate exhausted ${gate.attempts - 1} retries: $ ${gate.command}` });
        return undefined;
      }
      if (row.turns_used >= row.max_turns) return this.budgetPause(row);
      return `[Quality gate failed] $ ${gate.command} exited ${exit} (attempt ${gate.attempts}/${gate.max_retries}). Fix it and continue toward: ${row.title}`;
    }
    const { verdict, reason } = this.judge();
    Object.assign(row, { last_verdict: verdict, last_reason: reason });
    if (verdict === "done") {
      row.status = "done";
      return undefined;
    }
    if (verdict === "blocked") {
      Object.assign(row, { status: "paused", paused_reason: `judged unachievable: ${reason}` });
      return undefined;
    }
    if (row.turns_used >= row.max_turns) return this.budgetPause(row);
    return `[Continuing toward your standing goal] ${row.title}`;
  }

  private budgetPause(row: GoalRow): undefined {
    Object.assign(row, { status: "paused", paused_reason: `turn budget exhausted (${row.turns_used}/${row.max_turns})` });
    return undefined;
  }
}
