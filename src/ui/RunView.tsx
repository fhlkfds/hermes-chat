// The Run view (ADR 0178): the button under a reply, and the dialog that draws the reply's turn as a waterfall of
// steps, each with how long it took and whether it failed. Clicking a step shows its arguments and result.
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Activity, CircleAlert, MessageCircleQuestionMark, Minimize2, Sparkles, TriangleAlert, Wrench, X } from "lucide-react";
import type { Length, Run, RunView, Step, StepKind, ToolProgress } from "../hermes/runs";
import { tokens, usd } from "../hermes/usage";
import { errorText } from "../hermes/values";
import { Spinner } from "./bits";
import { useModal } from "./modal";

/** Under a reply: opens its Run view. */
export function RunButton({ onRun }: { onRun: () => void }) {
  return (
    <button
      className="msg-action"
      title="See the steps this reply took, how long each took, and which failed."
      aria-label="Run view"
      onClick={(e) => {
        // Kept as the place focus goes back to when the view closes.
        e.currentTarget.focus();
        onRun();
      }}
    >
      <Activity size={13} aria-hidden />
      <span>Run</span>
    </button>
  );
}

/** A length in a few characters: 340 ms, 2.5 s, 1 min 4 s. */
export function lengthText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

const ICONS: Record<StepKind, typeof Wrench> = {
  model: Sparkles,
  tool: Wrench,
  question: MessageCircleQuestionMark,
  compaction: Minimize2,
  status: CircleAlert,
  error: TriangleAlert,
};

function LengthBadge({ length }: { length: Length }) {
  return (
    <span className="run-length">
      {lengthText(length.ms)}{" "}
      <span className={`run-how ${length.measured ? "measured" : "inferred"}`} title={length.measured ? "Hermes measured this length itself." : "Worked out by this app, not measured by Hermes."}>
        {length.measured ? "measured" : "inferred"}
      </span>
    </span>
  );
}

type State = { phase: "loading" } | { phase: "failed"; why: string } | { phase: "ready"; view: RunView };

/** The dialog: reads the run once when it opens. Late answers after it closed change nothing. */
export function RunDialog({ load, returnTo, onClose }: { load: () => Promise<RunView>; returnTo?: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [picked, setPicked] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const loadRef = useRef(load);
  useEffect(() => {
    let open = true;
    loadRef.current().then(
      (view) => open && setState({ phase: "ready", view }),
      (e) => open && setState({ phase: "failed", why: errorText(e) }),
    );
    return () => void (open = false);
  }, []);
  const view = state.phase === "ready" ? state.view : undefined;
  const step = view?.run.steps.find((s) => s.id === picked);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog run-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={state.phase === "loading"}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="run-head">
          <h2 id={titleId} className="leave-title run-title">
            <Activity size={14} aria-hidden /> Run of this reply
          </h2>
          <button className="icon-btn" aria-label="Close" title="Close" autoFocus onClick={onClose}>
            <X size={15} aria-hidden />
          </button>
        </div>
        {state.phase === "loading" && (
          <p className="run-loading" role="status">
            <Spinner /> Reading this reply's steps…
          </p>
        )}
        {state.phase === "failed" && (
          <p role="alert" className="run-error">
            <CircleAlert size={13} aria-hidden /> {state.why}
          </p>
        )}
        {view && (
          <>
            <Summary run={view.run} />
            <Notes run={view.run} toolProgress={view.toolProgress} />
            <Waterfall run={view.run} picked={picked} onPick={(id) => setPicked(id === picked ? undefined : id)} />
            {step && <StepDetail step={step} run={view.run} />}
          </>
        )}
      </div>
    </div>
  );
}

function Summary({ run }: { run: Run }) {
  const failed = run.steps.filter((s) => s.failed).length;
  return (
    <p className="run-summary">
      {run.source === "watched" ? "Watched by this app" : "Read from Hermes's stored history"} · {run.steps.length} step{run.steps.length === 1 ? "" : "s"} ·{" "}
      {lengthText(Math.max(0, run.end - run.start))} <span className="run-how inferred">inferred</span> ·{" "}
      {run.tokens && (
        <>
          {tokens(run.tokens.prompt)} tokens in, {tokens(run.tokens.output)} out over {run.tokens.calls} model call{run.tokens.calls === 1 ? "" : "s"} ·{" "}
        </>
      )}
      {run.cost !== undefined ? (
        <>
          cost {usd(run.cost)} <span className="run-how inferred">inferred</span>
        </>
      ) : (
        <span className="muted" title={run.costWhy}>
          no cost for this reply
        </span>
      )}
      {failed > 0 && <span className="run-failed-count"> · {failed} look{failed === 1 ? "s" : ""} failed</span>}
      {run.outcome && <span className="run-outcome"> · {run.outcome}</span>}
    </p>
  );
}

function Notes({ run, toolProgress }: { run: Run; toolProgress: ToolProgress }) {
  const off = "mode" in toolProgress && toolProgress.mode === "off";
  return (
    <ul className="run-notes">
      {off && (
        <li className="run-warn">
          <TriangleAlert size={12} aria-hidden />
          <span>
            Hermes doesn't send ordinary tool steps for this profile (<span className="mono">display.tool_progress: off</span>). Only file edits, delegations,
            questions and a few card tools show here.
          </span>
        </li>
      )}
      {"why" in toolProgress && <li>Couldn't tell whether Hermes sends every tool step: {toolProgress.why}</li>}
      {run.source === "watched" ? (
        <>
          <li>Times are when this app heard each event: Hermes sends no times of its own. Only a tool's length marked measured is Hermes's.</li>
          <li>A model call has no event: each is the time between tool calls, its tokens from Hermes's usage counters, which arrive at most once a second.</li>
          {run.turnIds === false && <li>This Hermes doesn't name its turns, so this reply's events are the ones heard between its start and end.</li>}
        </>
      ) : (
        <li>Hermes stores one time per step, when it ended, so each length is the gap since the step before. This app didn't watch this reply live.</li>
      )}
      <li>
        Hermes doesn't say when a tool fails: a failure here is judged from the result's words. A retry that recovered leaves no trace, and Hermes keeps cost per chat, so no
        step has a cost{run.cost === undefined && run.costWhy ? `. ${run.costWhy}` : "."}
      </li>
    </ul>
  );
}

function Waterfall({ run, picked, onPick }: { run: Run; picked?: string; onPick: (id: string) => void }) {
  if (!run.steps.length) return <p className="muted">No steps: this app saw no model call or tool call in this reply.</p>;
  const total = Math.max(1, run.end - run.start);
  return (
    <ol className="run-steps" aria-label="Steps">
      {run.steps.map((s) => {
        const Icon = ICONS[s.kind];
        const left = Math.min(100, Math.max(0, ((s.start - run.start) / total) * 100));
        const width = Math.max(0.6, Math.min(100 - left, ((s.end - s.start) / total) * 100));
        return (
          <li key={s.id}>
            <button className={`run-step ${s.kind}${s.failed ? " failed" : ""}${picked === s.id ? " picked" : ""}`} aria-pressed={picked === s.id} onClick={() => onPick(s.id)}>
              <span className="run-name">
                <Icon size={12} aria-hidden /><span className="run-name-text">{s.name}</span>
                {s.failed && <span className="run-fail-mark">{s.judged ? "looks failed" : "failed"}</span>}
              </span>
              <span className="run-track" aria-hidden>
                <span className="run-bar" style={{ left: `${left}%`, width: `${width}%` }} />
              </span>
              {s.length ? <LengthBadge length={s.length} /> : <span className="run-length muted">+{lengthText(Math.max(0, s.start - run.start))}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function StepDetail({ step, run }: { step: Step; run: Run }) {
  return (
    <section className="run-detail" aria-label={`${step.name}: details`}>
      <h3>{step.name}</h3>
      <p className="muted small">
        {run.source === "watched" ? "Heard" : "Stored"} {lengthText(Math.max(0, step.start - run.start))} after the reply began
        {step.length && <>, took <LengthBadge length={step.length} /></>}
      </p>
      {step.failed && (
        <p className="run-error">
          <CircleAlert size={13} aria-hidden /> {step.judged ? `Looks failed, judged from the result: ${step.failed}` : step.failed}
        </p>
      )}
      {step.note && <p className="muted small">{step.note}</p>}
      {step.tokens && (
        <p className="small">
          Tokens <span className="run-how inferred">inferred</span>: {tokens(step.tokens.prompt)} in, {tokens(step.tokens.output)} out
          {step.tokens.reasoning > 0 && `, ${tokens(step.tokens.reasoning)} reasoning`} over {step.tokens.calls} model call{step.tokens.calls === 1 ? "" : "s"}
        </p>
      )}
      {step.args !== undefined && <Block title="Arguments" text={shown(step.args)} />}
      {step.result !== undefined && <Block title="Result" text={step.result} />}
      {step.reasoning && <Block title="Reasoning" text={step.reasoning} />}
      {step.text && <Block title={step.kind === "model" ? "Text" : "What happened"} text={step.text} />}
      {step.args === undefined && step.result === undefined && !step.text && !step.reasoning && <p className="muted small">Hermes sent nothing more about this step.</p>}
    </section>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h4>{title}</h4>
      <pre className="run-pre">{text}</pre>
    </>
  );
}
