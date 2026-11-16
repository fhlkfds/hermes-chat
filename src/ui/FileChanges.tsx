// The chip under a reply that edited files on the server, and the Preview it opens: which files, the diff from the
// checkpoint Hermes took before the reply, and undoing them one file at a time (issue #601, ADR 0177).
import { useEffect, useRef, useState } from "react";
import { FileDiff } from "lucide-react";
import { replyFiles, type FilePlan, type UndoableFile } from "../hermes/fileChanges";
import { loadFiles, undoFiles, type FileOutcome, type FilesView, type RollbackIO, type UndoReport } from "../hermes/fileUndo";
import type { Chat } from "../hermes/model";
import { errorText } from "../hermes/values";
import { useLocale } from "../i18n/locale";
import { useOpenPreview } from "./previewContext";
import { PatchFile } from "./Repository";
import { Spinner } from "./bits";

/** "2 files changed" under a finished reply, opening its files in the Preview. `off`: its profile has checkpoints off. */
export function FilesChip({ chatId, replyId, count, off }: { chatId: string; replyId: string; count: number; off: boolean }) {
  const open = useOpenPreview();
  const l = useLocale().chat.files;
  if (!open) return null;
  return (
    <button className="preview-chip files-chip" title={l.chipTitle} onClick={() => open({ kind: "files", chatId, replyId })}>
      <FileDiff size={12} aria-hidden />
      <span>{off ? `${l.changed(count)} · ${l.off}` : l.changed(count)}</span>
    </button>
  );
}

/** What the Preview reads a reply's files with: the chat as it is now, and its checkpoints. */
export type FileChangesHost = { chat: (chatId: string) => Chat | undefined; io: (chatId: string) => RollbackIO };

type Load = { kind: "loading" } | { kind: "failed"; why: string } | { kind: "ready"; view: FilesView };
/** `choosing`: Undo this turn is asking which files, each checked or not. */
type Step = { kind: "idle" } | { kind: "choosing"; checked: ReadonlySet<string> } | { kind: "undoing" };

const isUndoable = (f: FilePlan): f is UndoableFile => f.state === "undoable";

/**
 * A reply's files in the Preview. Read again on Reload, and after every undo. Undo is off while the chat has a reply
 * running, since Hermes may be changing the same files.
 */
export function FileChangesView({ chatId, replyId, host, reloadSeq, connected }: { chatId: string; replyId: string; host: FileChangesHost; reloadSeq: number; connected: boolean }) {
  const l = useLocale().chat.files;
  const chat = host.chat(chatId);
  const latest = useRef({ chat, host });
  latest.current = { chat, host };
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [report, setReport] = useState<UndoReport>();
  const [read, setRead] = useState(0);
  const reply = chat && replyFiles(chat.items, chat.folder).find((r) => r.replyId === replyId);
  const found = !!reply;

  useEffect(() => {
    const { chat, host } = latest.current;
    const reply = chat && replyFiles(chat.items, chat.folder).find((r) => r.replyId === replyId);
    if (!chat || !reply) return;
    let live = true;
    setLoad({ kind: "loading" });
    loadFiles(host.io(chatId), reply, chat.items, chat.folder).then(
      (view) => live && setLoad({ kind: "ready", view }),
      (e: unknown) => live && setLoad({ kind: "failed", why: errorText(e) }),
    );
    return () => void (live = false);
  }, [chatId, replyId, reloadSeq, read, found]);

  if (!chat || !reply) return <div className="files-view">{l.gone}</div>;
  const view = load.kind === "ready" ? load.view : undefined;
  const blocked = !connected || !!chat.running || step.kind === "undoing";

  const undo = async (chosen: UndoableFile[]) => {
    if (view?.kind !== "found" || !chosen.length) return;
    setStep({ kind: "undoing" });
    setReport(undefined);
    try {
      setReport(await undoFiles(host.io(chatId), view, chosen));
    } catch (e) {
      setLoad({ kind: "failed", why: errorText(e) });
    }
    setStep({ kind: "idle" });
    setRead((n) => n + 1);
  };

  const paths = (
    <ul className="files-paths mono">
      {reply.paths.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
  return (
    <div className="files-view">
      <h3>{l.heading}</h3>
      <p className="repo-notice">{l.limits}</p>
      {chat.running && <p className="repo-notice warn">{l.running}</p>}
      {report && <Report report={report} />}
      {load.kind === "loading" ? (
        <p className="files-loading">
          <Spinner /> {l.loading}
        </p>
      ) : load.kind === "failed" ? (
        <p className="repo-notice warn" role="alert">
          {l.failed(load.why)}
        </p>
      ) : view?.kind !== "found" ? (
        <>
          <p className="repo-notice warn">{view?.kind === "off" ? l.offNote : view?.kind === "ambiguous" ? l.ambiguous : l.none}</p>
          {paths}
        </>
      ) : step.kind === "choosing" ? (
        <Choose files={view.files.filter(isUndoable)} checked={step.checked} blocked={blocked} onChecked={(checked) => setStep({ kind: "choosing", checked })} onCancel={() => setStep({ kind: "idle" })} onRestore={(files) => void undo(files)} />
      ) : (
        <>
          {view.cut && <p className="repo-notice warn">{l.cut}</p>}
          {view.files.map((f) => (
            <FileRow key={f.path} file={f} blocked={blocked} onUndo={(file) => void undo([file])} />
          ))}
          {view.files.some(isUndoable) && (
            <button
              className="btn"
              disabled={blocked}
              onClick={() => setStep({ kind: "choosing", checked: new Set(view.files.filter(isUndoable).filter((f) => f.handEdit === "as-left").map((f) => f.rel)) })}
            >
              {l.undoTurn}
            </button>
          )}
        </>
      )}
      {step.kind === "undoing" && (
        <p className="files-loading" role="status">
          <Spinner /> {l.undoing}
        </p>
      )}
    </div>
  );
}

function FileRow({ file, blocked, onUndo }: { file: FilePlan; blocked: boolean; onUndo: (file: UndoableFile) => void }) {
  const l = useLocale().chat.files;
  const section = file.state === "undoable" || file.state === "created" ? file.section : undefined;
  return (
    <section className="files-file" aria-label={file.path}>
      <div className="files-file-head">
        <span className="mono">{file.path}</span>
        <span className="muted small">{file.state === "undoable" ? l.undoable : file.state === "created" ? l.created : ""}</span>
      </div>
      {file.state === "unchanged" && <p className="repo-notice">{l.unchanged}</p>}
      {file.state === "outside" && <p className="repo-notice">{l.outside}</p>}
      {file.state === "pattern" && <p className="repo-notice">{l.pattern}</p>}
      {file.state === "created" && <p className="repo-notice">{l.createdNote}</p>}
      {file.state === "undoable" && <Warnings file={file} />}
      {(file.state === "undoable" || file.state === "created") && (section ? <div className="repo-review-diff"><PatchFile diff={section} /></div> : <p className="repo-notice">{l.notShown}</p>)}
      {file.state === "undoable" && (
        <button className="btn" disabled={blocked} onClick={() => onUndo(file)}>
          {l.undoFile}
        </button>
      )}
    </section>
  );
}

function Warnings({ file }: { file: UndoableFile }) {
  const l = useLocale().chat.files;
  return (
    <>
      {file.handEdit === "edited" && <p className="repo-notice warn">{l.handEdited}</p>}
      {file.handEdit === "unknown" && <p className="repo-notice warn">{l.handUnknown}</p>}
      {file.laterReply && <p className="repo-notice warn">{l.laterReply}</p>}
    </>
  );
}

/** Undo this turn's list: every file it would restore, checked or not, before anything is sent. */
function Choose({
  files,
  checked,
  blocked,
  onChecked,
  onCancel,
  onRestore,
}: {
  files: UndoableFile[];
  checked: ReadonlySet<string>;
  blocked: boolean;
  onChecked: (checked: ReadonlySet<string>) => void;
  onCancel: () => void;
  onRestore: (files: UndoableFile[]) => void;
}) {
  const locale = useLocale();
  const l = locale.chat.files;
  const chosen = files.filter((f) => checked.has(f.rel));
  const toggle = (rel: string) => {
    const next = new Set(checked);
    if (!next.delete(rel)) next.add(rel);
    onChecked(next);
  };
  return (
    <div className="files-choose">
      <p>{l.choose}</p>
      {files.map((f) => (
        <label key={f.rel} className="files-choice">
          <input type="checkbox" checked={checked.has(f.rel)} onChange={() => toggle(f.rel)} />
          <span className="mono">{f.path}</span>
          <Warnings file={f} />
        </label>
      ))}
      <div className="files-actions">
        <button className="btn primary" disabled={blocked || !chosen.length} onClick={() => onRestore(chosen)}>
          {l.restore(chosen.length)}
        </button>
        <button className="btn" onClick={onCancel}>
          {locale.common.cancel}
        </button>
      </div>
    </div>
  );
}

function Report({ report }: { report: UndoReport }) {
  const o = useLocale().chat.files;
  if (report.kind === "changed")
    return (
      <p className="repo-notice warn" role="alert">
        {o.changedSince}
      </p>
    );
  const line = ({ file, outcome, error = "" }: FileOutcome) =>
    outcome === "failed" ? o.outcome.failed(file.path, error) : outcome === "unconfirmed" ? o.outcome.unconfirmed(file.path, error) : o.outcome[outcome](file.path);
  return (
    <ul className="files-report" role="status">
      {report.files.map((f) => (
        <li key={f.file.rel} className={f.outcome === "restored" ? "" : "warn"}>
          {line(f)}
        </li>
      ))}
    </ul>
  );
}
