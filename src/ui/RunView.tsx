// The Run view (ADR 0177): a reply's turn as a waterfall of model calls, tool calls, Questions and status lines, each
// with how long it took and whether it failed. Every figure the app inferred, rather than Hermes measured, is marked.
import { useEffect, useId, useRef, useState } from "react";
import { Activity, Bot, CircleAlert, Info, MessageCircleQuestion, TriangleAlert, Wrench } from "lucide-react";
import { questionName, type Length, type Run, type Step, type ToolProgress } from "../hermes/flightRecorder";
import { tokens, usd } from "../hermes/usage";
import { errorText, plural } from "../hermes/values";
import { Spinner } from "./bits";
import { useModal } from "./modal";

/** Under a reply: opens its Run view. */
export function RunButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className="msg-action"
      title="See the steps this reply took: how long each took and which failed."
      aria-label="Run"
      onClick={(e) => {
        e.currentTarget.focus();
        onOpen();
      }}
    >
      <Activity size={13} aria-hidden />
      <span>Run</span>
    </button>
  );
}

export type RunApi = { read: () => Promise<{ run: Run; toolProgress?: ToolProgress }> };

type State = { phase: "loading" } | { phase: "failed"; why: string } | { phase: "ready"; run: Run; toolProgress?: ToolProgress };

/** A length as people read it: 420 ms, 3.4 s, 2 min 5 s. */
export function lengthText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A length, with ≈ and "inferred" for one the app worked out rather than Hermes measured. */
function Took({ length }: { length: Length }) {
  if (length.measured) return <span title="Measured by Hermes">{lengthText(length.ms)}</span>;
  return (
    <span className="run-inferred" title="Inferred by this app">
      ≈{lengthText(length.ms)}
      <span className="sr-only"> (inferred)</span>
    </span>
  );
}

function stepName(s: Step): string {
  switch (s.kind) {
    case "model":
      return s.calls && s.calls > 1 ? `Model, ${s.calls} calls` : "Model";
    case "tool":
      return s.name;
    case "question":
      return questionName(s.what);
    case "status":
      return s.status === "compacting" || s.status === "compressing" ? "Compaction" : s.status === "warn" ? "Warning" : "Status";
    case "error":
      return "Error";
  }
}

function StepIcon({ step }: { step: Step }) {
  if (step.failed) return <CircleAlert size={13} aria-hidden className="run-bad" />;
  if (step.kind === "model") return <Bot size={13} aria-hidden />;
  if (step.kind === "tool") return <Wrench size={13} aria-hidden />;
  if (step.kind === "question") return <MessageCircleQuestion size={13} aria-hidden />;
  return <Info size={13} aria-hidden />;
}

const SHOWN_CHARS = 4000;

function Block({ label, text }: { label: string; text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > SHOWN_CHARS;
  return (
    <div className="run-block">
      <div className="run-block-label">{label}</div>
      <pre>{long && !all ? `${text.slice(0, SHOWN_CHARS)}…` : text}</pre>
      {long && (
        <button className="link-btn" onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show all ${plural(text.length, "character")}`}
        </button>
      )}
    </div>
  );
}

/** What a step holds: a tool's arguments and result, a model step's tokens and text, a Question's outcome. */
function StepDetail({ step, run }: { step: Step; run: Run }) {
  const offset = lengthText(Math.max(0, step.start - run.start));
  return (
    <div className="run-detail">
      <p className="muted small">
        Started {offset} into the run{run.source === "stored" ? ", worked out from the stored row before it" : ", as this app heard it"}.
        {step.kind === "tool" && step.placed && " Hermes sent no start for it, so it is placed back from its measured length."}
        {step.kind === "tool" && step.together && " It ran beside other tools, so its stored gap isn't its own length."}
      </p>
      {step.failed && (
        <p className="run-bad">
          <CircleAlert size={13} aria-hidden /> {step.kind === "tool" ? `Failed, judged from its result: ${step.failed}` : step.failed}
        </p>
      )}
      {step.kind === "tool" && (
        <>
          <Block label="Arguments" text={step.args ? JSON.stringify(step.args, null, 2) : "None sent"} />
          <Block label="Result" text={step.result ?? (step.end > step.start || step.length.measured ? "None sent" : "Still running")} />
        </>
      )}
      {step.kind === "model" && (
        <>
          <p>
            {step.calls !== undefined ? (
              <span className="run-inferred">
                ≈{plural(step.calls, "model call")}, {tokens(step.tokens!.prompt)} in, {tokens(step.tokens!.output)} out
                {step.tokens!.reasoning ? `, ${tokens(step.tokens!.reasoning)} reasoning` : ""}, from Hermes's counters before and after it (inferred).
              </span>
            ) : run.source === "watched" ? (
              "Hermes's counters didn't move where this app could tell, so its tokens aren't known."
            ) : (
              "Hermes stores no tokens for a step."
            )}
          </p>
          {step.chars ? <p className="muted small">{plural(step.chars, "character")} of text and reasoning streamed.</p> : null}
          {step.reasoning && step.reasoning !== "reasoning" && <Block label="Reasoning" text={step.reasoning} />}
          {step.text && <Block label="Text" text={step.text} />}
        </>
      )}
      {step.kind === "question" && (
        <>
          <Block label="Asked" text={step.summary || "(nothing shown)"} />
          <p>{step.outcome}.</p>
        </>
      )}
      {(step.kind === "status" || step.kind === "error") && <Block label="Hermes said" text={step.text} />}
    </div>
  );
}

/** The run's facts above the waterfall: where it came from, how long, how many calls, what it cost. */
function Summary({ run }: { run: Run }) {
  const cost = run.cost;
  return (
    <dl className="run-summary">
      <dt>From</dt>
      <dd>{run.source === "watched" ? "What this app heard live: each time is when an event arrived here" : "Hermes's stored history: each row has only the time its step ended"}</dd>
      <dt>Length</dt>
      <dd>
        <Took length={{ ms: run.end - run.start, measured: false }} />
        {run.outcome === "running" ? ", still running" : run.outcome === "interrupted" ? ", stopped" : run.outcome === "failed" ? ", failed" : ""}
      </dd>
      {run.calls !== undefined && (
        <>
          <dt>Model calls</dt>
          <dd>{run.calls}, from Hermes's counters</dd>
        </>
      )}
      <dt>Cost</dt>
      <dd>
        {!cost ? (
          "Hermes keeps cost per chat, not per step or turn, so a stored run has none."
        ) : "usd" in cost ? (
          <span className="run-inferred">≈{usd(cost.usd)} for the turn, the change in the chat's cost across it (inferred)</span>
        ) : (
          cost.why
        )}
      </dd>
    </dl>
  );
}

/**
 * The Run view for one reply. It reads the run once when it opens; `onClose` closes it. A late answer after it closed
 * changes nothing.
 */
export function RunDialog({ api, onClose }: { api: RunApi; onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [open, setOpen] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    apiRef.current.read().then(
      ({ run, toolProgress }) => live && setState({ phase: "ready", run, toolProgress }),
      (e) => live && setState({ phase: "failed", why: errorText(e) }),
    );
    return () => void (live = false);
  }, []);

  const run = state.phase === "ready" ? state.run : undefined;
  const span = run ? Math.max(1, run.end - run.start) : 1;
  const failedTool = run?.steps.some((s) => s.kind === "tool" && s.failed);
  const together = run?.steps.some((s) => s.kind === "tool" && s.together);
  const toolsOff = run?.source === "watched" && state.phase === "ready" && state.toolProgress === "off";

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
        <h2 id={titleId} className="leave-title run-title">
          <Activity size={14} aria-hidden /> Run of this reply
        </h2>
        {state.phase === "loading" && (
          <p role="status">
            <Spinner /> Reading this reply's steps…
          </p>
        )}
        {state.phase === "failed" && (
          <p role="alert" className="run-bad">
            <CircleAlert size={13} aria-hidden /> {state.why}
          </p>
        )}
        {run && (
          <>
            <Summary run={run} />
            {toolsOff && (
              <p className="run-note" role="note">
                <TriangleAlert size={13} aria-hidden /> This profile's <code>display.tool_progress</code> is <code>off</code>, so Hermes doesn't send
                ordinary tool steps. Only file edits, <code>delegate_task</code>, <code>clarify</code>, a few card tools and failed calls still show
                here.
              </p>
            )}
            {run.steps.length === 0 ? (
              <p className="muted">No steps to show.</p>
            ) : (
              <ol className="run-steps" aria-label="Steps">
                {run.steps.map((s) => {
                  const left = ((s.start - run.start) / span) * 100;
                  const width = ((s.end - s.start) / span) * 100;
                  const expanded = open === s.id;
                  return (
                    <li key={s.id} className={`run-step run-${s.kind}${s.failed ? " run-failed" : ""}`}>
                      <button className="run-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : s.id)}>
                        <span className="run-name">
                          <StepIcon step={s} /> {stepName(s)}
                        </span>
                        <span className="run-track" aria-hidden>
                          <span
                            className={`run-bar${s.length.measured ? "" : " inferred"}${s.end === s.start ? " moment" : ""}`}
                            style={{ left: `${Math.min(100, Math.max(0, left))}%`, width: `${Math.min(100 - Math.max(0, left), Math.max(0, width))}%` }}
                          />
                        </span>
                        <span className="run-took">{s.end === s.start && !s.length.measured ? "" : <Took length={s.length} />}</span>
                      </button>
                      {expanded && <StepDetail step={s} run={run} />}
                    </li>
                  );
                })}
              </ol>
            )}
            <ul className="run-notes muted small">
              <li>≈ marks a time, token count or cost this app inferred. A tool length without it is Hermes's own measurement.</li>
              {failedTool && <li>Hermes sends no failure flag for a tool call, so a failed one is judged from its result, as Hermes judges one to show.</li>}
              {together && <li>Tools called together are stored as each finishes, in call order, so their gaps aren't each one's own length.</li>}
              <li>Hermes reports retries only when every retry failed, so a retry that recovered can't show here.</li>
            </ul>
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
