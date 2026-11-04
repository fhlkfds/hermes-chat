// Worktrees in the Repository screen (ADR 0040): the repository's worktrees on the server, the ones Hermes Chat made
// with their chats, changes and unpushed commits, and making, setting up, starting a chat in, and removing them. Every
// Git operation runs on the server through the Repository screen's helper over the owner's ssh.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, CircleX, FolderOpen, GitBranch, GitBranchPlus, Lock, MessageSquarePlus, RefreshCw, RotateCcw, Shield, ShieldOff, Trash2 } from "lucide-react";
import { asRepoFailure, type RepoApi, RepoFailure } from "../hermes/repo";
import {
  answerLost,
  asList,
  asPlan,
  asRecord,
  asRemoval,
  countsLabel,
  folderName,
  removalBlockers,
  setupSummary,
  stepsToRun,
  type RemovalFacts,
  type SetupStep,
  type WorktreeLaunch,
  type WorktreeList,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeRow,
} from "../hermes/worktrees";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import { Failure } from "./Repository";

type Load<T> = { state: "loading"; last?: T } | { state: "ready"; data: T } | { state: "failed"; error: RepoFailure; last?: T };
type HermesChats = { chats: { id: string; title: string; archived: boolean }[]; more: boolean };

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "");

export function WorktreesPanel({
  api,
  target,
  top,
  branch,
  scope,
  by,
  chatsIn,
  onOpen,
  onStartChat,
}: {
  api: RepoApi;
  target: string;
  /** The checkout the screen has open: any worktree of the repository. */
  top: string;
  /** Its branch, offered as the base of a new one. */
  branch: string | null;
  /** The connection and profile chats are recorded under. */
  scope: string;
  /** Who makes a worktree, kept in its record. */
  by: string;
  /** The profile's chats Hermes keeps as working in a folder; absent while Hermes isn't connected. */
  chatsIn?: (folder: string) => Promise<HermesChats>;
  /** Opens a folder in the Repository screen. */
  onOpen: (path: string) => void;
  /** Starts a new chat working in the worktree; absent while Hermes isn't connected. */
  onStartChat?: (w: WorktreeLaunch) => void;
}) {
  const [list, setList] = useState<Load<WorktreeList>>({ state: "loading" });
  const [creating, setCreating] = useState<{ record?: WorktreeRecord }>();
  const [removing, setRemoving] = useState<WorktreeRecord>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ what: string; error: RepoFailure }>();
  // Only the newest read is shown: an answer for an older one, or one that lands after this panel moved on, is dropped.
  const gen = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const load = useCallback(() => {
    const n = ++gen.current;
    setList((l) => ({ state: "loading", last: l.state === "ready" ? l.data : l.last }));
    api.run(target, { op: "worktreeList", repo: top }).then(
      (v) => {
        if (!alive.current || n !== gen.current) return;
        try {
          setList({ state: "ready", data: asList(v) });
        } catch (e) {
          setList((l) => ({ state: "failed", error: asRepoFailure(e), last: l.state === "loading" ? l.last : undefined }));
        }
      },
      (e: unknown) => alive.current && n === gen.current && setList((l) => ({ state: "failed", error: asRepoFailure(e), last: l.state === "loading" ? l.last : undefined })),
    );
  }, [api, target, top]);
  useEffect(load, [load]);

  const data = list.state === "ready" ? list.data : list.last;
  const loading = list.state === "loading";

  /** A small write from a row: one at a time, then the list is read again. */
  const write = (what: string, req: Parameters<RepoApi["run"]>[1]) => {
    setBusy(what);
    setError(undefined);
    api.run(target, req).then(
      () => alive.current && (setBusy(undefined), load()),
      (e: unknown) => alive.current && (setBusy(undefined), setError({ what, error: asRepoFailure(e) }), load()),
    );
  };

  const launch = (r: WorktreeRecord): WorktreeLaunch | undefined =>
    data && { target, repo: data.main, id: r.id, path: r.path, branch: r.branch };

  const managed = data?.worktrees.filter((w) => w.record) ?? [];
  const others = data?.worktrees.filter((w) => !w.record) ?? [];

  return (
    <section className="repo-publish repo-worktrees" aria-label="Worktrees" aria-busy={loading}>
      <div className="repo-section-head">
        <h2 className="repo-commit-label">
          <GitBranch size={14} aria-hidden /> Worktrees {data && <span className="count">{managed.length}</span>}
        </h2>
        <button className="btn" disabled={!data || data.newer || !!busy} onClick={() => setCreating({})}>
          <GitBranchPlus size={13} aria-hidden /> New worktree…
        </button>
        <button className="icon-btn" title="Read the worktrees again" aria-label="Refresh worktrees" disabled={loading} onClick={load}>
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
        </button>
      </div>
      {list.state === "failed" && (
        <Failure
          failure={list.error}
          what={list.error.kind === "unsupported" ? "Worktrees aren't available for this repository" : "Couldn't read the worktrees"}
        />
      )}
      {error && <Failure failure={error.error} what={`${error.what} didn't happen`} onDismiss={() => setError(undefined)} />}
      {busy && (
        <p className="muted small repo-review-status" role="status">
          <Spinner /> {busy}…
        </p>
      )}
      {!data && loading && (
        <p className="muted small repo-review-status" role="status">
          <Spinner /> Reading the worktrees…
        </p>
      )}
      {data?.newer && (
        <div className="files-banner warn" role="status">
          <CircleAlert size={14} aria-hidden /> A newer Hermes Chat keeps this repository's worktrees. They're shown here, but only that version can change them.
        </div>
      )}
      {data && (
        <>
          {managed.length === 0 && (
            <p className="muted small repo-none">
              No worktrees made by Hermes Chat are here. New worktree… makes one beside the repository, on a branch of its own, for a chat to work in
              without touching this checkout.
            </p>
          )}
          {managed.length > 0 && (
            <ul className="wt-list" aria-label="Worktrees made by Hermes Chat">
              {managed.map((w) => (
                <li key={w.path}>
                  <ManagedRow
                    row={w}
                    hasRemote={data.hasRemote}
                    busy={!!busy || data.newer}
                    onOpen={() => onOpen(w.path)}
                    onStartChat={onStartChat && w.record!.state === "ready" && !w.missing ? () => onStartChat(launch(w.record!)!) : undefined}
                    onSetup={() => setCreating({ record: w.record! })}
                    onProtect={(on) => write(on ? "Protect" : "Unprotect", { op: "worktreeProtect", repo: top, id: w.record!.id, protected: on })}
                    onDetach={(c) => write("Detach", { op: "worktreeDetach", repo: top, id: w.record!.id, scope: c.scope, chat: c.chat })}
                    onRemove={() => setRemoving(w.record!)}
                    scope={scope}
                  />
                </li>
              ))}
            </ul>
          )}
          {data.unfinished.length > 0 && (
            <div className="repo-card" role="group" aria-label="Unfinished">
              <h3>
                <CircleAlert size={14} aria-hidden /> Not finished
              </h3>
              <ul className="wt-plain">
                {data.unfinished.map((r) => (
                  <li key={r.id}>
                    <span className="mono">{r.branch}</span> <span className="muted small mono">{r.path}</span>{" "}
                    <span className="muted small">
                      {r.state === "creating"
                        ? "Making it stopped before the worktree was there."
                        : r.state === "removing"
                          ? "Its removal stopped part way; the worktree is gone."
                          : "The worktree isn't there any more: it was removed outside Hermes Chat."}
                    </span>
                    <div className="wt-actions">
                      {r.state === "creating" && (
                        <button className="btn" disabled={!!busy} onClick={() => setCreating({ record: r })}>
                          Finish making it
                        </button>
                      )}
                      <button className="btn" disabled={!!busy || data.newer} onClick={() => write("Forget", { op: "worktreeForget", repo: top, id: r.id })}>
                        Forget
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {others.length > 0 && (
            <details className="wt-others">
              <summary>
                Other worktrees <span className="count">{others.length}</span>
              </summary>
              <p className="muted small">Made outside Hermes Chat, or the repository's own checkout. They're shown, never removed from here.</p>
              <ul className="wt-plain" aria-label="Other worktrees">
                {others.map((w) => (
                  <li key={w.path}>
                    <span className="mono">{w.branch ?? (w.detached ? "detached HEAD" : "—")}</span> <span className="muted small mono">{w.path}</span>{" "}
                    <span className="muted small">
                      {w.main ? "the repository's own checkout" : w.missing ? "folder missing" : countsLabel(w.changes)}
                      {w.locked !== null && ` · locked${w.locked ? `: ${w.locked}` : ""}`}
                    </span>
                    {!w.current && !w.missing && (
                      <button className="btn wt-inline" onClick={() => onOpen(w.path)} aria-label={`Open ${w.path} here`}>
                        <FolderOpen size={13} aria-hidden /> Open
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {data.removed.length > 0 && (
            <details className="wt-others">
              <summary>
                Removed <span className="count">{data.removed.length}</span>
              </summary>
              <ul className="wt-plain" aria-label="Removed worktrees">
                {data.removed.map((r) => (
                  <li key={r.id}>
                    <span className="mono">{r.removed?.branch ?? "detached HEAD"}</span> <span className="muted small mono">{r.path}</span>{" "}
                    <span className="muted small">
                      removed {new Date(r.removed!.at).toLocaleString()}
                      {r.removed?.kept ? (
                        <>
                          {" "}
                          · its changes are kept in <span className="mono">{r.removed.kept.ref}</span>
                        </>
                      ) : (
                        " · it had no changes to keep"
                      )}
                      {r.removed?.branch && ` · the branch ${r.removed.branch} is kept`}
                    </span>
                    <div className="wt-actions">
                      <button className="btn" disabled={!!busy || data.newer} onClick={() => write("Restore", { op: "worktreeRestore", repo: top, id: r.id })}>
                        <RotateCcw size={13} aria-hidden /> Restore
                      </button>
                      <button
                        className="btn"
                        disabled={!!busy || data.newer}
                        title="Drops only this entry. The branch and any kept changes stay in the repository."
                        onClick={() => write("Forget", { op: "worktreeForget", repo: top, id: r.id })}
                      >
                        Forget
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {creating && (
        <CreateDialog
          api={api}
          target={target}
          top={top}
          branch={branch}
          by={by}
          resume={creating.record}
          onOpen={onOpen}
          onStartChat={onStartChat && ((r) => onStartChat(launch(r) ?? { target, repo: top, id: r.id, path: r.path, branch: r.branch }))}
          onClose={() => {
            setCreating(undefined);
            load();
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          api={api}
          target={target}
          top={top}
          record={removing}
          chatsIn={chatsIn}
          onClose={() => {
            setRemoving(undefined);
            load();
          }}
        />
      )}
    </section>
  );
}

function ManagedRow({
  row: w,
  hasRemote,
  busy,
  scope,
  onOpen,
  onStartChat,
  onSetup,
  onProtect,
  onDetach,
  onRemove,
}: {
  row: WorktreeRow;
  hasRemote: boolean;
  busy: boolean;
  scope: string;
  onOpen: () => void;
  onStartChat?: () => void;
  onSetup: () => void;
  onProtect: (on: boolean) => void;
  onDetach: (c: WorktreeRecord["chats"][number]) => void;
  onRemove: () => void;
}) {
  const r = w.record!;
  const setup = setupSummary(r);
  const [confirmDetach, setConfirmDetach] = useState<string>();
  const name = w.branch ?? r.branch;
  return (
    <div className="repo-card wt-card" aria-label={`Worktree ${name}`} role="group">
      <h3>
        <GitBranch size={14} aria-hidden /> <span className="mono">{w.branch ?? (w.detached ? `detached at ${short(w.head)}` : r.branch)}</span>
        {w.current && <span className="chip-tag">open here</span>}
        {r.protected && (
          <span className="chip-tag">
            <Shield size={11} aria-hidden /> protected
          </span>
        )}
        {w.locked !== null && w.locked !== `hermes-chat ${r.id}` && (
          <span className="chip-tag warn">
            <Lock size={11} aria-hidden /> locked by another tool
          </span>
        )}
      </h3>
      <div className="mono small wt-path" title="Its folder on the server">
        {w.path}
      </div>
      <div className="small wt-facts">
        {w.missing ? (
          <span className="err">The folder isn't there.</span>
        ) : w.error ? (
          <span className="err">{w.error}</span>
        ) : (
          <>
            <span>{countsLabel(w.changes)}</span>
            <span>
              {!hasRemote
                ? "No remote: its commits are only here"
                : w.unpushed
                  ? `${w.unpushed} commit${w.unpushed === 1 ? "" : "s"} not on a remote`
                  : "Nothing unpushed"}
            </span>
          </>
        )}
        <span className="muted">
          from {r.base} at {short(r.baseSha)} · made by {r.createdBy}
        </span>
      </div>
      {setup.total > 0 && (
        <div className={`small wt-setup ${setup.failed.length ? "err" : ""}`}>
          Setup: {setup.done} of {setup.total} done
          {setup.failed.length > 0 && `, failed: ${setup.failed.map((s) => s.entry).join(", ")}`}
          {setup.pending > 0 && !setup.failed.length && `, ${setup.pending} not run yet`}
        </div>
      )}
      <div className="small">
        {r.chats.length === 0 ? (
          <span className="muted">No chat recorded as working here.</span>
        ) : (
          <ul className="wt-chats" aria-label="Chats working here">
            {r.chats.map((c) => (
              <li key={`${c.scope}\n${c.chat}`}>
                <span>“{c.title || c.chat}”</span>
                {c.scope !== scope && <span className="muted"> (another connection or profile)</span>}
                {confirmDetach === `${c.scope}\n${c.chat}` ? (
                  <span className="wt-confirm" role="group" aria-label="Detach this chat?">
                    <span className="muted"> The chat keeps working in this folder; only the worktree stops counting it. </span>
                    <button className="btn" autoFocus disabled={busy} onClick={() => onDetach(c)}>
                      Detach
                    </button>
                    <button className="btn" onClick={() => setConfirmDetach(undefined)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button className="btn wt-inline" disabled={busy} aria-label={`Detach “${c.title || c.chat}”`} onClick={() => setConfirmDetach(`${c.scope}\n${c.chat}`)}>
                    Detach…
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="wt-actions">
        <button className="btn primary" disabled={busy || !onStartChat} title={onStartChat ? undefined : "Connect to Hermes to start a chat"} onClick={onStartChat}>
          <MessageSquarePlus size={13} aria-hidden /> Start chat here
        </button>
        {!w.current && !w.missing && (
          <button className="btn" onClick={onOpen} aria-label={`Open ${name} in this screen`}>
            <FolderOpen size={13} aria-hidden /> Open
          </button>
        )}
        {(setup.failed.length > 0 || setup.pending > 0) && !w.missing && (
          <button className="btn" disabled={busy} onClick={onSetup}>
            <RotateCcw size={13} aria-hidden /> {setup.failed.length ? "Retry setup" : "Run setup"}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => onProtect(!r.protected)}>
          {r.protected ? <ShieldOff size={13} aria-hidden /> : <Shield size={13} aria-hidden />} {r.protected ? "Unprotect" : "Protect"}
        </button>
        <button className="btn danger" disabled={busy} onClick={onRemove} aria-label={`Remove the worktree ${name}…`}>
          <Trash2 size={13} aria-hidden /> Remove…
        </button>
      </div>
    </div>
  );
}

const STEP_ICON: Record<SetupStep["state"], ReactNode> = {
  pending: <CircleDashed size={13} aria-label="not run yet" />,
  done: <Check size={13} aria-label="done" />,
  failed: <CircleX size={13} aria-label="failed" />,
  skipped: <span className="muted" aria-label="skipped">–</span>,
};

function SetupSteps({ steps, running }: { steps: SetupStep[]; running?: number }) {
  if (!steps.length) return <p className="muted small">This repository has no .worktreeinclude, so there's no setup to run.</p>;
  return (
    <ol className="wt-steps" aria-label="Setup steps">
      {steps.map((s, i) => (
        <li key={i} className={`wt-step ${s.state}`}>
          {running === i ? <Spinner /> : STEP_ICON[s.state]}{" "}
          <span>
            {s.action === "copy" ? "Copy" : s.action === "link" ? "Link" : "Skip"} <span className="mono">{s.entry}</span>
          </span>
          {s.message && <div className="muted small wt-step-msg">{s.message}</div>}
        </li>
      ))}
    </ol>
  );
}

type CreatePhase =
  | { phase: "form"; plan?: Load<WorktreePlan> }
  | { phase: "creating"; plan: WorktreePlan }
  | { phase: "lost"; plan?: WorktreePlan; checking: boolean; note?: string; error?: RepoFailure }
  | { phase: "setup"; record: WorktreeRecord; running?: number; output?: string; error?: RepoFailure };

/**
 * New worktree: the form, its preview from the server, then making it, then each setup step in turn with what it did.
 * `resume`: a worktree made already whose setup isn't finished, or a create that stopped part way.
 */
function CreateDialog({
  api,
  target,
  top,
  branch,
  by,
  resume,
  onOpen,
  onStartChat,
  onClose,
}: {
  api: RepoApi;
  target: string;
  top: string;
  branch: string | null;
  by: string;
  resume?: WorktreeRecord;
  onOpen: (path: string) => void;
  onStartChat?: (r: WorktreeRecord) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const ids = { branch: useId(), base: useId() };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const [newBranch, setNewBranch] = useState(true);
  const [name, setName] = useState("");
  const [base, setBase] = useState(branch ?? "HEAD");
  // Made once per dialog: a create sent again after its answer was lost finishes this same worktree.
  const [id] = useState(() => resume?.id ?? crypto.randomUUID());
  const [phase, setPhase] = useState<CreatePhase>(() =>
    resume ? (resume.state === "creating" ? { phase: "lost", checking: false, note: "Making it stopped part way. Finish sends the same request again." } : { phase: "setup", record: resume }) : { phase: "form" },
  );
  const planGen = useRef(0);
  const primary = useRef<HTMLButtonElement>(null);

  const preview = () => {
    const n = ++planGen.current;
    setPhase({ phase: "form", plan: { state: "loading" } });
    api.run(target, { op: "worktreePlan", repo: top, branch: name.trim(), newBranch, ...(newBranch && { base: base.trim() }) }).then(
      (v) => {
        if (!alive.current || n !== planGen.current) return;
        try {
          setPhase({ phase: "form", plan: { state: "ready", data: asPlan(v) } });
        } catch (e) {
          setPhase({ phase: "form", plan: { state: "failed", error: asRepoFailure(e) } });
        }
      },
      (e: unknown) => alive.current && n === planGen.current && setPhase({ phase: "form", plan: { state: "failed", error: asRepoFailure(e) } }),
    );
  };
  // Any edit makes the preview out of date: it must be read again before anything is made.
  const edited = () => {
    planGen.current++;
    setPhase({ phase: "form" });
  };

  /** Runs the steps left, one request each, so each one's result shows as it lands. `output`: what Git printed
   * making the worktree, kept on screen throughout. */
  const runSetup = async (record: WorktreeRecord, output?: string) => {
    let rec = record;
    for (const step of stepsToRun(rec)) {
      setPhase({ phase: "setup", record: rec, running: step, output });
      try {
        rec = asRecord(await api.run(target, { op: "worktreeSetup", repo: top, id: rec.id, step })).record;
      } catch (e) {
        if (!alive.current) return;
        return setPhase({ phase: "setup", record: rec, output, error: asRepoFailure(e) });
      }
      if (!alive.current) return;
      // A failed step stops the run; the steps after it wait for Retry.
      if (rec.setup[step].state === "failed") break;
    }
    setPhase({ phase: "setup", record: rec, output });
  };

  const create = (plan: WorktreePlan | undefined, req: { branch: string; newBranch: boolean; base?: string; stamp: string }) => {
    setPhase(plan ? { phase: "creating", plan } : { phase: "lost", checking: true });
    api.run(target, { op: "worktreeCreate", repo: top, id, by, ...req }).then(
      (v) => {
        if (!alive.current) return;
        const { record, output } = asRecord(v);
        void runSetup(record, output);
      },
      (e: unknown) => {
        if (!alive.current) return;
        const error = asRepoFailure(e);
        // Refused, so nothing was made: back to the form, which must be previewed again.
        if (!answerLost(error)) return setPhase(plan ? { phase: "form", plan: { state: "failed", error } } : { phase: "lost", checking: false, error });
        // The answer was lost: whether the worktree was made isn't known until the server is asked.
        setPhase({ phase: "lost", plan, checking: true, error });
        api.run(target, { op: "worktreeList", repo: top }).then(
          (v) => {
            if (!alive.current) return;
            const l = asList(v);
            const made = l.worktrees.find((w) => w.record?.id === id)?.record ?? l.unfinished.find((r) => r.id === id);
            if (made?.state === "ready") {
              void runSetup(made, "The answer was lost, but the server has the worktree.");
            } else
              setPhase({
                phase: "lost",
                plan,
                checking: false,
                error,
                note: made ? "Making it stopped part way. Finish sends the same request again." : "Nothing was made. You can try again.",
              });
          },
          (e2: unknown) => alive.current && setPhase({ phase: "lost", plan, checking: false, error: asRepoFailure(e2), note: "The server couldn't be asked whether it was made. Try again when it's reachable: the same request finishes it or makes it once." }),
        );
      },
    );
  };

  const resend = () => {
    const r = resume;
    if (phase.phase === "lost" && phase.plan) {
      const p = phase.plan;
      return create(p, { branch: p.branch, newBranch: p.newBranch, ...(p.newBranch && { base: p.base }), stamp: p.stamp });
    }
    // A create left part way by an earlier window: its record holds what was asked.
    if (r) create(undefined, { branch: r.branch, newBranch: r.newBranch, ...(r.newBranch && { base: r.base }), stamp: "" });
  };

  // Opened from a worktree's Run setup or Retry setup: the steps left run at once, for the worktree it opened with.
  // Once, StrictMode included.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || resume?.state !== "ready" || !stepsToRun(resume).length) return;
    autoRan.current = true;
    void runSetup(resume);
  }, []);

  const working = phase.phase === "creating" || (phase.phase === "setup" && phase.running !== undefined) || (phase.phase === "lost" && phase.checking);
  useEffect(() => {
    if (!working) primary.current?.focus();
  }, [working, phase.phase]);
  const close = () => !working && onClose();
  const plan = phase.phase === "form" && phase.plan?.state === "ready" ? phase.plan.data : undefined;
  const record = phase.phase === "setup" ? phase.record : undefined;
  const summary = record && setupSummary(record);
  // Not finished: a step failed, or some haven't run (Retry runs them).
  const failed = !!summary?.failed.length || !!summary?.pending || (phase.phase === "setup" && !!phase.error);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={working}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <GitBranchPlus size={15} aria-hidden /> {record ? `Worktree ${record.branch}` : "New worktree"}
        </h2>
        <div className="repo-review-body">
          {phase.phase === "form" && (
            <form
              className="wt-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (plan) create(plan, { branch: plan.branch, newBranch: plan.newBranch, ...(plan.newBranch && { base: plan.base }), stamp: plan.stamp });
                else if (name.trim() && (!newBranch || base.trim())) preview();
              }}
            >
              <fieldset className="wt-kind">
                <legend>Branch</legend>
                <label>
                  <input type="radio" name="wt-kind" checked={newBranch} onChange={() => (setNewBranch(true), edited())} /> New branch
                </label>
                <label>
                  <input type="radio" name="wt-kind" checked={!newBranch} onChange={() => (setNewBranch(false), edited())} /> Existing branch
                </label>
              </fieldset>
              <label htmlFor={ids.branch}>{newBranch ? "New branch name" : "Branch to check out"}</label>
              <input
                id={ids.branch}
                className="repo-pr-title mono"
                autoFocus
                value={name}
                placeholder={newBranch ? "fix/login-timeout" : "feature/search"}
                onChange={(e) => (setName(e.target.value), edited())}
              />
              {newBranch && (
                <>
                  <label htmlFor={ids.base}>Start from (branch, tag or commit)</label>
                  <input id={ids.base} className="repo-pr-title mono" value={base} onChange={(e) => (setBase(e.target.value), edited())} />
                </>
              )}
              {name.trim() && !plan && (
                <p className="muted small">
                  Folder on the server: <span className="mono">…{"/"}&lt;repository&gt;.worktrees/{folderName(name.trim()) || "?"}</span>, shown in full by Preview.
                </p>
              )}
              {phase.plan?.state === "loading" && (
                <p className="repo-review-status" role="status">
                  <Spinner /> Checking on the server…
                </p>
              )}
              {phase.plan?.state === "failed" && <Failure failure={phase.plan.error} what="This worktree can't be made" />}
              {plan && <PlanView plan={plan} />}
              <div className="confirm-actions">
                <button type="button" className="btn" onClick={close}>
                  Cancel
                </button>
                {plan ? (
                  <button ref={primary} className="btn primary">
                    Create worktree
                  </button>
                ) : (
                  <button ref={primary} className="btn primary" disabled={!name.trim() || (newBranch && !base.trim()) || phase.plan?.state === "loading"}>
                    Preview
                  </button>
                )}
              </div>
            </form>
          )}
          {phase.phase === "creating" && (
            <>
              <PlanView plan={phase.plan} />
              <p className="repo-review-status" role="status">
                <Spinner /> Making the worktree on the server…
              </p>
            </>
          )}
          {phase.phase === "lost" && (
            <>
              {phase.plan && <PlanView plan={phase.plan} />}
              {phase.error && <Failure failure={phase.error} what={answerLost(phase.error) ? "The answer from the server was lost" : "The worktree wasn't made"} />}
              {phase.checking ? (
                <p className="repo-review-status" role="status">
                  <Spinner /> Asking the server whether it was made…
                </p>
              ) : (
                phase.note && <p role="status">{phase.note}</p>
              )}
              <div className="confirm-actions">
                <button ref={primary} className="btn" disabled={phase.checking} onClick={close}>
                  Close
                </button>
                {!phase.checking && (phase.plan || resume) && (!phase.error || answerLost(phase.error) || phase.error.kind === "git") && (
                  <button className="btn primary" onClick={resend}>
                    {phase.note?.startsWith("Making it stopped") ? "Finish making it" : "Try again"}
                  </button>
                )}
              </div>
            </>
          )}
          {record && phase.phase === "setup" && (
            <>
              <dl className="repo-review-facts">
                <dt>Folder</dt>
                <dd className="mono">{record.path}</dd>
                <dt>Branch</dt>
                <dd className="mono">{record.branch}</dd>
                <dt>Starts at</dt>
                <dd>
                  <span className="mono">{short(record.baseSha)}</span> ({record.base})
                </dd>
              </dl>
              <h3>Setup</h3>
              <SetupSteps steps={record.setup} running={phase.running} />
              {phase.error && <Failure failure={phase.error} what="A setup step couldn't run" />}
              {phase.output && (
                <>
                  <h3>What Git printed</h3>
                  <pre className="repo-output mono">{phase.output}</pre>
                </>
              )}
              <p role="status" className={failed ? "err" : undefined}>
                {phase.running !== undefined
                  ? `Running step ${phase.running + 1} of ${record.setup.length}…`
                  : failed
                    ? "Setup didn't finish. The worktree is there; retry setup, or open it to look."
                    : "The worktree is ready."}
              </p>
              <div className="confirm-actions">
                <button className="btn" disabled={working} onClick={close}>
                  Close
                </button>
                {failed && (
                  <>
                    <button className="btn" disabled={working} onClick={() => (onOpen(record.path), onClose())}>
                      <FolderOpen size={13} aria-hidden /> Open
                    </button>
                    <button ref={primary} className="btn primary" disabled={working} onClick={() => void runSetup(record, phase.output)}>
                      <RotateCcw size={13} aria-hidden /> Retry
                    </button>
                  </>
                )}
                {!failed && onStartChat && (
                  <button ref={primary} className="btn primary" disabled={working} onClick={() => (onStartChat(record), onClose())}>
                    <MessageSquarePlus size={13} aria-hidden /> Start chat here
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanView({ plan }: { plan: WorktreePlan }) {
  const s = plan.source;
  const sourceDirty = s.staged + s.changed + s.untracked + s.conflicts > 0;
  return (
    <div className="wt-plan" aria-label="What will be made">
      <dl className="repo-review-facts">
        <dt>Folder on the server</dt>
        <dd className="mono">{plan.path}</dd>
        <dt>Branch</dt>
        <dd>
          <span className="mono">{plan.branch}</span> {plan.newBranch ? "(new, not tracking anything)" : "(existing, checked out as it is)"}
        </dd>
        <dt>Starts at</dt>
        <dd>
          <span className="mono">{short(plan.baseSha)}</span> {plan.subject}
          {plan.newBranch && <span className="muted"> ({plan.base})</span>}
        </dd>
        <dt>Repository</dt>
        <dd className="mono">{plan.repo}</dd>
      </dl>
      {sourceDirty && (
        <p className="files-banner" role="note">
          <CircleAlert size={14} aria-hidden /> {s.path} has uncommitted changes ({countsLabel(s).toLowerCase()}). They stay there: the worktree starts from the
          commit above, without them.
        </p>
      )}
      {plan.submoduleCount > 0 && (
        <p className="files-banner" role="note">
          <CircleAlert size={14} aria-hidden /> {plan.submoduleCount} submodule{plan.submoduleCount === 1 ? "" : "s"} ({plan.submodules.slice(0, 3).join(", ")}
          {plan.submoduleCount > 3 ? "…" : ""}) won't be checked out. Run git submodule update in the worktree if a chat needs them.
        </p>
      )}
      <h3>Setup, from .worktreeinclude</h3>
      <SetupSteps steps={plan.setup} />
    </div>
  );
}

const FILE_STATUS: Record<RemovalFacts["files"][number]["status"], string> = {
  staged: "staged",
  changed: "changed",
  both: "staged and changed",
  conflict: "conflicted",
  untracked: "untracked",
};

/** Remove: the preview of what it affects and what stops it, then the removal, which keeps the changes first. */
function RemoveDialog({
  api,
  target,
  top,
  record,
  chatsIn,
  onClose,
}: {
  api: RepoApi;
  target: string;
  top: string;
  record: WorktreeRecord;
  chatsIn?: (folder: string) => Promise<HermesChats>;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  type State =
    | { phase: "loading" }
    | { phase: "failed"; error: RepoFailure }
    | { phase: "ready"; facts: RemovalFacts; hermes: HermesChats | Error | undefined; error?: RepoFailure }
    | { phase: "removing"; facts: RemovalFacts }
    | { phase: "removed"; record: WorktreeRecord }
    | { phase: "lost"; facts: RemovalFacts; error: RepoFailure };
  const [state, setState] = useState<State>({ phase: "loading" });

  const ask = useCallback(async () => {
    const hermes = chatsIn ? await chatsIn(record.path).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : undefined;
    return hermes;
  }, [chatsIn, record.path]);

  const load = useCallback(() => {
    setState({ phase: "loading" });
    Promise.all([api.run(target, { op: "worktreeRemoval", repo: top, id: record.id }).then(asRemoval), ask()]).then(
      ([facts, hermes]) => alive.current && setState({ phase: "ready", facts, hermes }),
      (e: unknown) => alive.current && setState({ phase: "failed", error: asRepoFailure(e) }),
    );
  }, [api, target, top, record.id, ask]);
  useEffect(load, [load]);

  const remove = async (facts: RemovalFacts) => {
    setState({ phase: "removing", facts });
    // Asked again right before: a chat may have started working there since the preview.
    const hermes = await ask();
    if (!alive.current) return;
    if (removalBlockers(facts, hermes).length) return setState({ phase: "ready", facts, hermes });
    api.run(target, { op: "worktreeRemove", repo: top, id: record.id, stamp: facts.stamp }).then(
      (v) => alive.current && setState({ phase: "removed", record: asRecord(v).record }),
      (e: unknown) => {
        if (!alive.current) return;
        const error = asRepoFailure(e);
        if (answerLost(error)) return setState({ phase: "lost", facts, error });
        setState({ phase: "ready", facts, hermes, error });
      },
    );
  };

  const working = state.phase === "loading" || state.phase === "removing";
  useEffect(() => {
    if (!working) primary.current?.focus();
  }, [working]);
  const close = () => !working && onClose();
  const facts = state.phase === "ready" || state.phase === "removing" || state.phase === "lost" ? state.facts : undefined;
  const blockers = state.phase === "ready" ? removalBlockers(state.facts, state.hermes) : [];
  const archived = state.phase === "ready" && state.hermes && !(state.hermes instanceof Error) ? state.hermes.chats.filter((c) => c.archived) : [];
  const keeps = !!facts && (facts.files.length > 0 || facts.keepHead);

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog repo-review wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={working}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <Trash2 size={15} aria-hidden /> {state.phase === "removed" ? "Worktree removed" : `Remove the worktree ${record.branch}?`}
        </h2>
        <div className="repo-review-body">
          {state.phase === "loading" && (
            <p className="repo-review-status" role="status">
              <Spinner /> Reading what removing it would affect…
            </p>
          )}
          {state.phase === "failed" && <Failure failure={state.error} what="Couldn't read the worktree" />}
          {facts && state.phase !== "removed" && (
            <>
              <dl className="repo-review-facts">
                <dt>Folder</dt>
                <dd className="mono">{facts.path}</dd>
                <dt>Branch</dt>
                <dd>{facts.branch ? <><span className="mono">{facts.branch}</span>: kept, never deleted</> : `detached at ${short(facts.head)}`}</dd>
              </dl>
              {blockers.length > 0 && (
                <div className="files-banner warn" role="alert">
                  <CircleAlert size={14} aria-hidden />
                  <div>
                    <strong>It can't be removed now.</strong>
                    <ul>
                      {blockers.map((b, i) => (
                        <li key={i}>{b.message}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {archived.length > 0 && (
                <p className="muted small">
                  Archived chats that worked here: {archived.map((c) => `“${c.title}”`).join(", ")}. They'd lose their folder.
                </p>
              )}
              <h3>Files that will be kept {facts.files.length > 0 && <span className="count">{facts.fileCount ?? facts.files.length}</span>}</h3>
              {facts.files.length === 0 ? (
                <p className="muted small">No changes: it matches its last commit.</p>
              ) : (
                <ul className="wt-files" aria-label="Changed and untracked files">
                  {facts.files.map((f) => (
                    <li key={f.path}>
                      <span className="mono">{f.path}</span> <span className="muted small">{FILE_STATUS[f.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>Commits not on a remote {facts.unpushed.length > 0 && <span className="count">{facts.unpushed.length}</span>}</h3>
              {facts.unpushed.length === 0 ? (
                <p className="muted small">None.</p>
              ) : (
                <>
                  <p className="muted small">
                    {facts.branch ? `They stay on the branch ${facts.branch}.` : "They're on no branch, so the recovery ref keeps them."}
                    {facts.hasRemote === false && " This repository has no remote."}
                  </p>
                  <ul className="wt-files" aria-label="Commits not on a remote">
                    {facts.unpushed.slice(0, 50).map((c) => (
                      <li key={c.sha}>
                        <span className="mono">{short(c.sha)}</span> {c.subject}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {facts.ignored.length > 0 && (
                <>
                  <h3>
                    Ignored, deleted with the folder <span className="count">{facts.ignored.length}</span>
                  </h3>
                  <ul className="wt-files" aria-label="Ignored files deleted with the folder">
                    {facts.ignored.slice(0, 50).map((f) => (
                      <li key={f} className="mono">
                        {f}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="small">
                {keeps
                  ? "Before anything is deleted, the changes are saved as one commit in a recovery ref (refs/hermes-chat/recovery/…), read back, and only then is the folder removed. Restore puts them back."
                  : "Nothing needs keeping. The folder is removed; the branch stays."}
              </p>
              {state.phase === "ready" && state.error && <Failure failure={state.error} what="Nothing was removed" />}
              {state.phase === "lost" && (
                <>
                  <Failure failure={state.error} what="The answer from the server was lost" />
                  <p role="status">Whether it was removed isn't known yet. Close, and the list shows what the server has now. Nothing is sent again on its own.</p>
                </>
              )}
              {state.phase === "removing" && (
                <p className="repo-review-status" role="status">
                  <Spinner /> {keeps ? "Keeping the changes, then removing…" : "Removing…"}
                </p>
              )}
            </>
          )}
          {state.phase === "removed" && (
            <>
              <p role="status">
                {state.record.path} was removed.{" "}
                {state.record.removed?.kept ? (
                  <>
                    Its changes are kept in <span className="mono">{state.record.removed.kept.ref}</span>.
                  </>
                ) : (
                  "It had no changes to keep."
                )}{" "}
                {state.record.removed?.branch && `The branch ${state.record.removed.branch} is still there.`}
              </p>
            </>
          )}
          <div className="confirm-actions">
            <button ref={state.phase === "ready" && !blockers.length ? undefined : primary} className="btn" disabled={working} onClick={close}>
              {state.phase === "removed" ? "Close" : "Cancel"}
            </button>
            {state.phase === "ready" && (
              <button
                ref={blockers.length ? undefined : primary}
                className="btn danger"
                disabled={blockers.length > 0}
                onClick={() => void remove(state.facts)}
              >
                {keeps ? "Keep changes and remove" : "Remove worktree"}
              </button>
            )}
            {(state.phase === "failed" || (state.phase === "ready" && !!state.error)) && (
              <button className="btn" onClick={load}>
                Preview again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
