// The Repository screen: a Git checkout on the Hermes server, reviewed from here (ADR 0034). It reads through the
// owner's own ssh, not through the dashboard, so it works while Hermes is away too. It covers the chat panes, as
// Server files does.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, CircleAlert, FileWarning, FolderGit2, GitBranch, GitMerge, Pencil, RefreshCw, Server, X } from "lucide-react";
import {
  CONTEXT_CHOICES,
  OPERATION_LABEL,
  asDiff,
  asRepoFailure,
  asStatus,
  branchLabel,
  failureHint,
  group,
  parseDiff,
  upstreamLabel,
  type Change,
  type DiffReply,
  type RepoApi,
  type RepoFailure,
  type Status,
} from "../hermes/repo";
import { Spinner } from "./bits";

type Load<T> = { state: "idle" } | { state: "loading"; last?: T } | { state: "ready"; data: T } | { state: "failed"; error: RepoFailure; last?: T };

const lastOf = <T,>(l: Load<T>): T | undefined => (l.state === "ready" ? l.data : l.state === "idle" ? undefined : l.last);

const SECTIONS: { key: "conflicts" | "staged" | "unstaged" | "untracked"; title: string; empty?: string }[] = [
  { key: "conflicts", title: "Conflicts" },
  { key: "staged", title: "Staged", empty: "Nothing staged." },
  { key: "unstaged", title: "Changed, not staged", empty: "No changes in tracked files." },
  { key: "untracked", title: "Untracked" },
];

export function RepositoryScreen({
  api,
  initialTarget,
  initialPath,
  recent,
  suggestions,
  onOpened,
  onTarget,
  onClose,
}: {
  api: RepoApi;
  /** The SSH target to read through. Empty asks for one. */
  initialTarget: string;
  /** The folder opened last, opened again at once. */
  initialPath: string;
  /** Folders opened lately, newest first. */
  recent: string[];
  /** Folders worth offering, such as the shown project's. */
  suggestions: { label: string; path: string }[];
  /** A folder opened: the checkout's top, to open next time. */
  onOpened: (top: string) => void;
  /** A target the owner set. */
  onTarget: (target: string) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(initialTarget);
  const [editingTarget, setEditingTarget] = useState(!initialTarget);
  const [targetDraft, setTargetDraft] = useState(initialTarget);
  const [pathDraft, setPathDraft] = useState(initialPath);
  const [repo, setRepo] = useState(initialTarget && initialPath ? initialPath : "");
  const [status, setStatus] = useState<Load<Status>>({ state: "idle" });
  const [selected, setSelected] = useState<string>();
  const [context, setContext] = useState(3);
  const [diff, setDiff] = useState<Load<DiffReply>>({ state: "idle" });
  const statusRun = useRef(0);
  const diffRun = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pathId = useId();

  const shown = lastOf(status);
  const groups = useMemo(() => (shown ? group(shown) : undefined), [shown]);
  const all = useMemo(() => (groups ? [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked] : []), [groups]);
  const change = all.find((c) => c.key === selected);

  const read = useCallback(
    (where: string, via: string) => {
      if (!where.trim() || !via.trim()) return;
      const run = ++statusRun.current;
      setStatus((s) => ({ state: "loading", last: lastOf(s) }));
      api.run(via, { op: "status", repo: where.trim() }).then(
        (v) => {
          if (run !== statusRun.current) return;
          try {
            const s = asStatus(v);
            setStatus({ state: "ready", data: s });
            onOpened(s.top);
          } catch (e) {
            setStatus({ state: "failed", error: asRepoFailure(e) });
          }
        },
        (e: unknown) => {
          if (run !== statusRun.current) return;
          setStatus((s) => ({ state: "failed", error: asRepoFailure(e), last: lastOf(s) }));
        },
      );
    },
    [api, onOpened],
  );

  useEffect(() => {
    if (repo && target) read(repo, target);
  }, [repo, target, read]);

  // A different folder or target: what was shown belonged to the other one.
  const open = (where: string) => {
    if (!where.trim()) return;
    statusRun.current++;
    diffRun.current++;
    setStatus({ state: "idle" });
    setSelected(undefined);
    setDiff({ state: "idle" });
    if (where.trim() === repo) read(repo, target);
    else setRepo(where.trim());
  };

  // The selected change's diff, read again whenever the status is, or the context changes.
  const top = shown?.top;
  useEffect(() => {
    if (!change || !top) {
      diffRun.current++;
      setDiff({ state: "idle" });
      return;
    }
    if (status.state === "loading") return;
    const run = ++diffRun.current;
    setDiff((d) => ({ state: "loading", last: lastOf(d) }));
    api
      .run(target, { op: "diff", repo: top, path: change.path, ...(change.origPath && { origPath: change.origPath }), side: change.side, context })
      .then(
        (v) => {
          if (run !== diffRun.current) return;
          try {
            setDiff({ state: "ready", data: asDiff(v) });
          } catch (e) {
            setDiff({ state: "failed", error: asRepoFailure(e) });
          }
        },
        (e: unknown) => run === diffRun.current && setDiff({ state: "failed", error: asRepoFailure(e) }),
      );
    // `status` is a dependency through `shown`: a refresh reads the diff again.
  }, [api, target, top, change?.key, change?.origPath, context, shown, status.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change that's gone after a refresh can't stay selected.
  useEffect(() => {
    if (selected && groups && !change) setSelected(undefined);
  }, [selected, groups, change]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button.repo-file") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };

  const setTargetTo = (t: string) => {
    const v = t.trim();
    if (!v) return;
    setEditingTarget(false);
    onTarget(v);
    if (v !== target) {
      statusRun.current++;
      diffRun.current++;
      setStatus({ state: "idle" });
      setDiff({ state: "idle" });
      setSelected(undefined);
      setTarget(v);
    } else if (repo) read(repo, v);
  };

  const loading = status.state === "loading";
  const failure = status.state === "failed" ? status.error : undefined;
  const offers = [...suggestions, ...recent.filter((p) => !suggestions.some((s) => s.path === p)).map((p) => ({ label: "Recent", path: p }))].filter((o) => o.path !== shown?.top);

  return (
    <div className="files repo">
      <div className="files-head">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="files-title">
          <h1>Repository</h1>
          {target && !editingTarget && (
            <span className="files-server" title="Read through your own ssh to this target">
              <Server size={13} aria-hidden /> <span className="mono">{target}</span>
              <button className="icon-btn repo-edit-target" aria-label="Change the SSH target" title="Change the SSH target" onClick={() => setEditingTarget(true)}>
                <Pencil size={13} />
              </button>
            </span>
          )}
        </div>
        <p className="files-note muted small">
          A Git checkout on the server, read through your own ssh, so Hermes doesn't need to be connected. Reading changes nothing in the repository.
        </p>
      </div>

      {editingTarget && (
        <form
          className="repo-target"
          onSubmit={(e) => {
            e.preventDefault();
            setTargetTo(targetDraft);
          }}
        >
          <label htmlFor={`${pathId}-target`}>SSH target</label>
          <input
            id={`${pathId}-target`}
            className="mono"
            placeholder="liam@hermes or a host alias from ~/.ssh/config"
            value={targetDraft}
            autoFocus
            onChange={(e) => setTargetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && target) {
                e.stopPropagation();
                setTargetDraft(target);
                setEditingTarget(false);
              }
            }}
          />
          <button className="btn primary" disabled={!targetDraft.trim()}>
            Use this target
          </button>
          {target && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTargetDraft(target);
                setEditingTarget(false);
              }}
            >
              Cancel
            </button>
          )}
        </form>
      )}

      <form
        className="files-bar repo-bar"
        onSubmit={(e) => {
          e.preventDefault();
          open(pathDraft);
        }}
      >
        <label htmlFor={pathId} className="repo-path-label">
          <FolderGit2 size={15} aria-hidden /> Folder on the server
        </label>
        <input
          id={pathId}
          className="repo-path mono"
          placeholder="~/projects/app"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          list={`${pathId}-offers`}
        />
        <datalist id={`${pathId}-offers`}>
          {offers.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </datalist>
        <button className="btn" disabled={!pathDraft.trim() || !target}>
          Open
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Read the repository again"
          aria-label="Refresh"
          disabled={!repo || !target || loading}
          onClick={() => read(repo, target)}
        >
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </form>

      {!repo && offers.length > 0 && (
        <div className="repo-offers">
          {offers.map((o) => (
            <button
              key={o.path}
              className="chip"
              disabled={!target}
              onClick={() => {
                setPathDraft(o.path);
                open(o.path);
              }}
            >
              <span className="muted">{o.label}</span> <span className="mono">{o.path}</span>
            </button>
          ))}
        </div>
      )}

      {failure && <Failure failure={failure} what={`Couldn't read ${repo}`} onDismiss={shown ? () => setStatus({ state: "ready", data: shown }) : undefined} />}

      {!shown && !failure && (
        <div className="repo-empty muted">
          {loading ? (
            <>
              <Spinner /> Reading {repo}…
            </>
          ) : !target ? (
            "Enter the SSH target of the Hermes server first."
          ) : (
            "Open a folder on the server to see its branch and changes."
          )}
        </div>
      )}

      {shown && groups && (
        <>
          <section className="repo-summary" aria-label="Repository" data-stale={loading || undefined}>
            <div className="repo-summary-row">
              <span className="mono repo-top" title="The top folder of the checkout, on the server">
                {shown.top}
              </span>
            </div>
            <div className="repo-summary-row">
              <span className="repo-branch">
                <GitBranch size={14} aria-hidden /> <span className="mono">{branchLabel(shown.branch)}</span>
              </span>
              <span className="muted small">{upstreamLabel(shown.branch)}</span>
              {shown.branch.oid && <span className="muted small mono" title="HEAD">{shown.branch.oid.slice(0, 12)}</span>}
            </div>
            {shown.operation && (
              <div className="files-banner warn" role="status">
                <GitMerge size={14} aria-hidden />
                <span>{OPERATION_LABEL[shown.operation]} Finish or abort it in the Terminal; this screen doesn't do either.</span>
              </div>
            )}
            {shown.truncated && (
              <div className="files-banner warn" role="status">
                <FileWarning size={14} aria-hidden />
                <span>More than 5,000 files changed. Only the first 5,000 are listed.</span>
              </div>
            )}
          </section>

          <div className={`repo-body ${change ? "with-diff" : ""}`}>
            <div className="repo-list" ref={listRef} onKeyDown={onListKey} aria-busy={loading} data-stale={loading || undefined}>
              {all.length === 0 && <p className="muted repo-clean">No changes: the working tree matches HEAD.</p>}
              {all.length > 0 &&
                SECTIONS.map(({ key, title, empty }) => {
                  const items = groups[key];
                  if (!items.length && !empty) return null;
                  return (
                    <section key={key} className="repo-section" aria-label={title}>
                      <h2>
                        {title} <span className="count">{items.length}</span>
                      </h2>
                      {items.length === 0 ? (
                        <p className="muted small repo-none">{empty}</p>
                      ) : (
                        <ul>
                          {items.map((c) => (
                            <li key={c.key}>
                              <FileRow change={c} selected={c.key === selected} onSelect={() => setSelected(c.key)} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
            </div>
            {change && (
              <DiffPanel
                change={change}
                diff={diff}
                context={context}
                onContext={setContext}
                onClose={() => {
                  setSelected(undefined);
                  listRef.current?.querySelector<HTMLButtonElement>("button.repo-file")?.focus();
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FileRow({ change: c, selected, onSelect }: { change: Change; selected: boolean; onSelect: () => void }) {
  const name = c.path.split("/").pop() ?? c.path;
  const dir = c.path.slice(0, c.path.length - name.length);
  return (
    <button className="repo-file" aria-current={selected || undefined} onClick={onSelect} title={`${c.label}: ${c.origPath ? `${c.origPath} → ` : ""}${c.path}`}>
      <span className={`repo-code code-${c.code === "?" ? "untracked" : c.code}`} aria-label={c.label}>
        {c.code}
      </span>
      <span className="repo-file-name">
        <span className="mono">{name}</span>
        {dir && <span className="mono muted repo-file-dir">{dir.replace(/\/$/, "")}</span>}
        {c.origPath && <span className="mono muted repo-file-dir">from {c.origPath}</span>}
      </span>
      {c.binary ? (
        <span className="badge">binary</span>
      ) : c.submodule ? (
        <span className="badge">submodule</span>
      ) : (
        c.counts && (
          <span className="repo-counts small">
            <span className="add">+{c.counts[0]}</span> <span className="del">−{c.counts[1]}</span>
          </span>
        )
      )}
    </button>
  );
}

const SIDE_TITLE: Record<Change["side"], string> = {
  staged: "Staged: the index against HEAD",
  unstaged: "Not staged: the working tree against the index",
  untracked: "Untracked: not in Git yet",
  conflict: "Merge conflict",
};

const STAGE_NAME: Record<number, string> = { 1: "the common base", 2: "ours", 3: "theirs" };

function DiffPanel({
  change,
  diff,
  context,
  onContext,
  onClose,
}: {
  change: Change;
  diff: Load<DiffReply>;
  context: number;
  onContext: (n: number) => void;
  onClose: () => void;
}) {
  const reply = lastOf(diff);
  const parsed = useMemo(() => (reply ? parseDiff(reply.diff) : undefined), [reply]);
  const contextId = useId();
  return (
    <section className="repo-diff" aria-label={`Diff of ${change.path}`}>
      <div className="repo-diff-head">
        <div className="repo-diff-title">
          <span className="muted small">{SIDE_TITLE[change.side]}</span>
          <span className="mono repo-diff-path">
            {change.origPath ? (
              <>
                <span className="muted">{change.origPath}</span> → {change.path}
              </>
            ) : (
              change.path
            )}
          </span>
        </div>
        <label htmlFor={contextId} className="small muted">
          Context
        </label>
        <select id={contextId} value={context} onChange={(e) => onContext(Number(e.target.value))} disabled={change.side === "untracked"}>
          {CONTEXT_CHOICES.map((c) => (
            <option key={c.lines} value={c.lines}>
              {c.label}
            </option>
          ))}
        </select>
        {diff.state === "loading" && <Spinner />}
        <button className="icon-btn" aria-label="Close the diff" title="Close the diff" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {diff.state === "failed" && <Failure failure={diff.error} what={`Couldn't read the diff of ${change.path}`} />}
      {parsed && reply && (
        <div className="repo-diff-body" data-stale={diff.state === "loading" || undefined}>
          <DiffNotices change={change} parsed={parsed} reply={reply} />
          {parsed.hunks.map((h, i) => (
            <div key={i} className="files-diff-hunk">
              <div className="files-diff-at mono">{h.header}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={`files-diff-line mono ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : l.kind === "note" ? "note" : ""} ${conflictMarker(l.text) ? "marker" : ""}`}>
                  {!parsed.combined && (
                    <>
                      <span className="files-diff-no">{l.oldNo ?? ""}</span>
                      <span className="files-diff-no">{l.newNo ?? ""}</span>
                    </>
                  )}
                  <span className="files-diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "note" ? "\\" : " "}</span>
                  <span className="files-diff-text">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
          {!parsed.hunks.length && !parsed.binary && !parsed.rename && !parsed.mode && !parsed.newFile && !parsed.deletedFile && !parsed.submodule && (
            <p className="muted small repo-diff-none">No differences on this side any more. Refresh to see the repository as it is now.</p>
          )}
        </div>
      )}
    </section>
  );
}

const conflictMarker = (t: string) => /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(t);

function DiffNotices({ change, parsed, reply }: { change: Change; parsed: ReturnType<typeof parseDiff>; reply: DiffReply }) {
  const notes: { tone: "warn" | "info"; text: string }[] = [];
  if (change.side === "conflict") {
    const names = reply.stages.map((s) => STAGE_NAME[s] ?? `stage ${s}`);
    const stages = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
    notes.push({
      tone: "warn",
      text: `${change.label}. Git holds ${stages || "no versions"} for this file. Lines between <<<<<<< and >>>>>>> are unresolved. Resolve the conflict in the Terminal or ask Hermes to, then refresh.`,
    });
  }
  if (parsed.binary) notes.push({ tone: "info", text: "Binary file: Git shows no lines for it." });
  if (parsed.submodule || change.submodule) notes.push({ tone: "info", text: "A submodule: the change is the commit it points at." });
  if (parsed.rename) notes.push({ tone: "info", text: `Renamed from ${parsed.rename.from}${parsed.rename.similarity ? ` (${parsed.rename.similarity} similar)` : ""}.` });
  if (parsed.copy) notes.push({ tone: "info", text: `Copied from ${parsed.copy.from}.` });
  if (parsed.newFile && change.side !== "untracked") notes.push({ tone: "info", text: `New file${parsed.newMode ? `, mode ${parsed.newMode}` : ""}.` });
  if (parsed.deletedFile) notes.push({ tone: "info", text: "Deleted file." });
  if (parsed.mode) notes.push({ tone: "info", text: `Mode changed from ${parsed.mode.from} to ${parsed.mode.to}.` });
  if (reply.truncated) notes.push({ tone: "warn", text: `This diff is ${Math.round(reply.bytes / 1024)} KiB, so only its first 2 MiB is shown.` });
  if (reply.lossy) notes.push({ tone: "warn", text: "Some of this file isn't UTF-8, so a few characters are shown as �." });
  if (!notes.length) return null;
  return (
    <div className="repo-notices">
      {notes.map((n, i) => (
        <p key={i} className={`repo-notice ${n.tone}`}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

export function Failure({ failure, what, onDismiss }: { failure: RepoFailure; what: string; onDismiss?: () => void }) {
  const hint = failureHint(failure);
  return (
    <div className="files-banner err repo-failure" role="alert">
      <CircleAlert size={14} aria-hidden />
      <div className="repo-failure-text">
        <span>
          {what}: {failure.message}
        </span>
        {hint && <span className="repo-hint">{hint}</span>}
        {failure.output.trim() && failure.output.trim() !== failure.message.trim() && <pre className="repo-output mono">{failure.output.trim()}</pre>}
      </div>
      {onDismiss && (
        <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
