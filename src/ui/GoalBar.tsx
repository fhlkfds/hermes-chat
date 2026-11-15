// Standing missions (issue #603, ADR 0178): the goal bar above a chat's message box, and Set a goal. Hermes keeps the
// goal and moves it after each turn; this shows what Hermes last said about it and sends the owner's changes.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, Hourglass, Pause, Play, Target, TriangleAlert, X } from "lucide-react";
import {
  CHECK_MAX_RETRIES,
  CHECK_TIMEOUT_SECONDS,
  DEFAULT_MAX_TURNS,
  draftProblem,
  goalArg,
  type Check,
  type Control,
  type Goal,
  type GoalAction,
  type GoalBoard,
  type GoalDraft,
} from "../hermes/goals";
import { clockTime, errorText } from "../hermes/values";
import { Spinner } from "./bits";
import { useModal } from "./modal";

/** What the bar and the dialog ask of Hermes for one chat. */
export type GoalApi = {
  read: () => Promise<Control>;
  budget: () => Promise<number | undefined>;
  set: (draft: GoalDraft, seen: string) => Promise<void>;
  act: (action: GoalAction) => Promise<void>;
};

/** Said wherever a goal is set or shown: Hermes moves a goal only in a chat live on the server. */
export const LIVE_NOTE =
  "A goal moves only while its chat is live on the server. With Highwing closed, a chat with only a goal and no reply running closes after 20 seconds, and nothing picks the goal up again, even after a server restart, until you open the chat.";

/**
 * The chat's goal as Hermes last showed it, read again each time the chat's live session changes: when it opens, and
 * when a reconnect resumes it. `live` is that session's id, none while the chat isn't open on Hermes.
 */
export function useChatGoal(board: GoalBoard, chatId: string, live: string | undefined, read: (() => Promise<unknown>) | undefined): Control | undefined {
  const control = useSyncExternalStore(board.subscribe, () => board.get(chatId));
  const reading = useRef(read);
  reading.current = read;
  useEffect(() => {
    if (live) void reading.current?.().catch(() => {});
  }, [chatId, live]);
  return control;
}

const STATUS: Record<Goal["status"], string> = { active: "Running", paused: "Paused", done: "Done" };

/** Why Hermes paused the goal, in the owner's words where Hermes's own are a code. */
const pausedWhy = (reason: string) => (reason === "user-paused" ? "You paused it." : `Hermes paused it: ${reason}`);

function checkResult(c: Check): { icon: typeof CircleCheck; text: string; tone: string } {
  if (c.lastExitCode === null) return { icon: CircleDashed, text: "Not run yet", tone: "" };
  if (c.lastExitCode === 0) return { icon: CircleCheck, text: "Passed", tone: "ok" };
  const how = c.lastExitCode === -1 ? "Timed out or couldn't run" : `Failed with exit code ${c.lastExitCode}`;
  return { icon: CircleX, text: `${how} · ${c.attempts} in a row, pauses at ${c.maxRetries + 1}`, tone: "bad" };
}

function barrierText(goal: Goal): string | undefined {
  const b = goal.waitBarrier;
  if (!b) return undefined;
  const why = b.reason ? `: ${b.reason}` : "";
  if (b.kind === "until") return `Waiting until ${clockTime(b.until)}${why}`;
  return `Waiting for ${b.kind === "process" ? `process ${b.target}` : `chat ${b.target}`} to finish${why}`;
}

const CONTRACT_LABELS: [keyof Goal["contract"], string][] = [
  ["outcome", "Done when"],
  ["verification", "Proof"],
  ["constraints", "Must not change"],
  ["boundaries", "In bounds"],
  ["stop_when", "Stop and ask when"],
];

/**
 * The bar above the message box while the chat has a goal. `blocked` says why nothing can be changed now; `resumeBlocked`
 * why Resume can't, since it starts a turn.
 */
export function GoalBar({ goal, blocked, resumeBlocked, act }: { goal: Goal; blocked?: string; resumeBlocked?: string; act: (a: GoalAction) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<GoalAction>();
  const [error, setError] = useState<string>();
  const detailsId = useId();
  const run = (a: GoalAction) => {
    setBusy(a);
    setError(undefined);
    act(a)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(undefined));
  };
  const failing = goal.checks.filter((c) => c.lastExitCode !== null && c.lastExitCode !== 0).length;
  const passing = goal.checks.filter((c) => c.lastExitCode === 0).length;
  const waiting = barrierText(goal);
  const contract = CONTRACT_LABELS.filter(([f]) => goal.contract[f]);
  const button = (a: GoalAction, label: string, Icon: typeof Pause, why?: string) => (
    <button className="btn goal-btn" disabled={!!busy || !!blocked || !!why} title={blocked ?? why} onClick={() => run(a)}>
      {busy === a ? <Spinner /> : <Icon size={13} aria-hidden />} {label}
    </button>
  );
  return (
    <section className={`goal-bar ${goal.status}`} aria-label="Goal">
      <div className="goal-head">
        <button className="goal-toggle" aria-expanded={open} aria-controls={detailsId} title={open ? "Hide the goal's details" : "Show the goal's details"} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <Target size={14} aria-hidden className="goal-icon" />
          <span className="goal-title">{goal.title}</span>
        </button>
        <span className={`goal-state ${goal.status}`}>{STATUS[goal.status]}</span>
        <span className="goal-meta">
          Turn {goal.turnsUsed} of {goal.maxTurns}
          {goal.checks.length > 0 && (
            <>
              {" · "}
              {failing ? `${failing} check${failing > 1 ? "s" : ""} failing` : passing === goal.checks.length ? "Checks pass" : "Checks not run yet"}
            </>
          )}
        </span>
        <span className="goal-actions">
          {goal.status === "active" && button("goal.pause", "Pause", Pause)}
          {goal.status === "paused" && button("goal.resume", "Resume", Play, resumeBlocked)}
          {button("goal.clear", "Clear", X)}
        </span>
      </div>
      {goal.status === "paused" && goal.pausedReason && <p className="goal-why">{pausedWhy(goal.pausedReason)}</p>}
      {waiting && (
        <p className="goal-wait">
          <Hourglass size={12} aria-hidden /> {waiting}
        </p>
      )}
      {error && (
        <p role="alert" className="goal-error">
          <CircleAlert size={12} aria-hidden /> {error}
        </p>
      )}
      {open && (
        <div id={detailsId} className="goal-details">
          {contract.length > 0 && (
            <dl className="goal-contract">
              {contract.map(([f, label]) => (
                <div key={f}>
                  <dt>{label}</dt>
                  <dd>{goal.contract[f]}</dd>
                </div>
              ))}
            </dl>
          )}
          {goal.subgoals.length > 0 && (
            <div className="goal-section">
              <h3>Also needed</h3>
              <ol className="goal-subgoals">
                {goal.subgoals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          <div className="goal-section">
            <h3>Checks</h3>
            {goal.checks.length ? (
              <ul className="goal-checks">
                {goal.checks.map((c, i) => {
                  const r = checkResult(c);
                  return (
                    <li key={i}>
                      <code className="goal-command">$ {c.command}</code>
                      <span className={`goal-result ${r.tone}`}>
                        <r.icon size={12} aria-hidden /> {r.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">None. Hermes's judge model alone decides when it's done.</p>
            )}
          </div>
          {goal.lastVerdict && (
            <div className="goal-section">
              <h3>Judge's last verdict</h3>
              <p>
                <span className="goal-verdict">{goal.lastVerdict}</span>
                {goal.lastReason && <> {goal.lastReason}</>}
              </p>
            </div>
          )}
          <p className="muted small goal-live">{LIVE_NOTE}</p>
        </div>
      )}
    </section>
  );
}

type Loaded = { control: Control; budget?: number };

/**
 * Set a goal: the outcome, what must not change and a check, then a look at exactly what goes to Hermes before anything
 * is saved (ADR 0110, ADR 0171). Saving is refused if the chat's goal changed since it was read here, and it is done
 * only once Hermes's read back matches. `outcome`: what `/goal` was typed with. `blocked`: why it can't be saved now,
 * such as a reply that started meanwhile.
 */
export function SetGoalDialog({
  api,
  outcome: typed = "",
  blocked,
  onClose,
  onDone,
}: {
  api: GoalApi;
  outcome?: string;
  blocked?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const [loaded, setLoaded] = useState<Loaded | { why: string }>();
  const [draft, setDraft] = useState<GoalDraft>({ outcome: typed, mustNot: "", check: "" });
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    Promise.all([api.read(), api.budget().catch(() => undefined)]).then(
      ([control, budget]) => setLoaded({ control, budget }),
      (e) => setLoaded({ why: errorText(e) }),
    );
  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per open dialog
  }, []);

  const ready = loaded && "control" in loaded ? loaded : undefined;
  const current = ready?.control.goal;
  const problem = draftProblem(draft);
  const check = draft.check.trim();
  const close = () => !saving && onClose();
  const save = () => {
    if (!ready || blocked) return;
    setSaving(true);
    setError(undefined);
    api.set(draft, ready.control.revision).then(onDone, (e) => {
      setError(errorText(e));
      setSaving(false);
      void load();
    });
  };
  const field = (key: keyof GoalDraft, label: string, hint: string, opts: { mono?: boolean; placeholder?: string; autoFocus?: boolean } = {}) => (
    <label className="goal-field">
      <span className="field-label">{label}</span>
      <input
        className={`branch-name${opts.mono ? " mono" : ""}`}
        value={draft[key]}
        placeholder={opts.placeholder}
        autoFocus={opts.autoFocus}
        spellCheck={!opts.mono}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
      <span className="muted small">{hint}</span>
    </label>
  );
  const replaces = current && (
    <p className="branch-warning">
      <TriangleAlert size={13} aria-hidden /> This chat already has a goal, “{current.title}” ({STATUS[current.status].toLowerCase()}). Setting this one replaces it.
    </p>
  );

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog branch-dialog goal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={!loaded || saving}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title branch-title">
          <Target size={14} aria-hidden /> {step === "edit" ? "Set a goal" : "Check before saving"}
        </h2>
        {!loaded && (
          <p className="branch-loading" role="status">
            <Spinner /> Reading this chat's goal from Hermes…
          </p>
        )}
        {loaded && "why" in loaded && (
          <p role="alert" className="branch-error">
            <CircleAlert size={13} aria-hidden /> Couldn't read this chat's goal from Hermes: {loaded.why}
          </p>
        )}
        {ready && step === "edit" && (
          <form
            className="goal-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) setStep("review");
            }}
          >
            <p className="muted">Hermes keeps working in this chat, turn after turn, until the goal is done, you pause it, or it runs out of turns.</p>
            {field("outcome", "Outcome", "What done looks like, in a sentence.", { autoFocus: true, placeholder: "Release 2.4 is on the stable channel" })}
            {field("mustNot", "What must not change (optional)", "Hermes's judge reads this. Nothing enforces it.", { placeholder: "The public API" })}
            {field("check", "Check that proves it done (optional)", "A shell command that exits 0 once the goal is done. You'll see exactly what runs before it's saved.", {
              mono: true,
              placeholder: "npm test",
            })}
            <div className="goal-field">
              <span className="field-label">Turn budget</span>
              <span>
                {ready.budget ?? DEFAULT_MAX_TURNS} turns{ready.budget === undefined && " unless the profile sets another"}
              </span>
              <span className="muted small">The profile's goals.max_turns. Hermes doesn't take a budget for each goal yet.</span>
            </div>
            {replaces}
            {draft.outcome.trim() && problem && (
              <p role="alert" className="branch-unsure">
                <CircleAlert size={13} aria-hidden /> {problem}
              </p>
            )}
            <p className="muted small">{LIVE_NOTE}</p>
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!!problem}>
                Review
              </button>
            </div>
          </form>
        )}
        {ready && step === "review" && (
          <>
            <section className="branch-section" aria-label="The goal">
              <h3>The goal Hermes gets</h3>
              <pre className="goal-preview">{goalArg(draft).replace(/^-- /, "")}</pre>
              <p className="muted small">
                Turn budget: {ready.budget ?? DEFAULT_MAX_TURNS} turns. Done needs {check ? "the check to pass and then " : ""}Hermes's judge model to agree.
              </p>
            </section>
            {check ? (
              <section className="branch-section" aria-label="The check">
                <h3>The check that runs</h3>
                <pre className="goal-preview mono">$ {check}</pre>
                <p className="branch-warning goal-danger">
                  <TriangleAlert size={13} aria-hidden />
                  <span>
                    This command runs on the server as the user Hermes runs as, with no approval, after every turn of this goal, for up to {CHECK_TIMEOUT_SECONDS} seconds
                    each time. When it fails, Hermes tries again at most {CHECK_MAX_RETRIES} times; the next failure pauses the goal.
                  </span>
                </p>
              </section>
            ) : (
              <p className="muted">No check: Hermes's judge model alone decides when it's done.</p>
            )}
            {replaces}
            <p className="muted small">{LIVE_NOTE}</p>
            {error && (
              <p role="alert" className="branch-error">
                <CircleAlert size={13} aria-hidden /> {error}
              </p>
            )}
            {blocked && !saving && (
              <p role="status" className="branch-unsure">
                <CircleAlert size={13} aria-hidden /> {blocked}
              </p>
            )}
            <div className="confirm-actions">
              <button className="btn" disabled={saving} onClick={() => setStep("edit")}>
                Back
              </button>
              <button className="btn primary" autoFocus disabled={saving || !!blocked} onClick={save}>
                {saving && <Spinner />} {check ? "Set goal and run this check" : "Set goal"}
              </button>
            </div>
          </>
        )}
        {loaded && "why" in loaded && (
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={close}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
