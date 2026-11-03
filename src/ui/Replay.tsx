// Edit and Regenerate (issue #63, ADR 0032): the buttons under a message, the dialog that says what the new branch
// will hold and leave out before anything is sent, the other answers a reply has, and the chats an owner's message was
// edited in. Both make a branch through Branch from here's contract (ADR 0027); the chat they come from stays as it is.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, FileText, GitBranch, Pencil, RefreshCw, Wrench } from "lucide-react";
import type { BranchLink } from "../hermes/branch";
import { modelLabel, type ReplayInfo, type ReplayKind, type ReplayPreview } from "../hermes/replay";
import type { Delivery } from "../hermes/transport";
import { BranchUnconfirmed } from "../hermes/transport";
import { Markdown } from "./Markdown";
import { Spinner } from "./bits";
import { useModal } from "./modal";

/** A branch Edit or Regenerate made from a message here: its chat, title, and whether a reply runs in it now. */
export type ReplayRef = { chatId: string; title: string; running: boolean; link: BranchLink & { replay: ReplayInfo } };

/**
 * What the transcript's Edit and Regenerate need from the chat view: why neither can be done now (`blocked`), opening
 * the dialog for a message, reading another answer from its branch, and opening a branch.
 */
export type ReplayHost = {
  blocked?: string;
  /** The answer Regenerate just made here, which its reply shows. */
  fresh?: string;
  act: (itemId: string, kind: ReplayKind) => void;
  read: (chatId: string) => Promise<{ text?: string; model?: string }>;
  open: (chatId: string) => void;
};
export const ReplayContext = createContext<ReplayHost | undefined>(undefined);

const LABEL: Record<ReplayKind, string> = { edit: "Edit", regenerate: "Regenerate" };
const HINT: Record<ReplayKind, string> = {
  edit: "Change this message in a new branch. This chat stays as it is.",
  regenerate: "Get another answer in a new branch. This reply stays, and you can switch between the answers.",
};

/** Under a message: Edit (the owner's) or Regenerate (a reply). `blocked`, from the host, shows on hover. */
export function ReplayButton({ itemId, kind }: { itemId: string; kind: ReplayKind }) {
  const host = useContext(ReplayContext);
  if (!host) return null;
  const Icon = kind === "edit" ? Pencil : RefreshCw;
  return (
    <button
      className="msg-action"
      title={host.blocked ?? HINT[kind]}
      aria-label={LABEL[kind]}
      aria-disabled={!!host.blocked}
      onClick={(e) => {
        // Kept as the place focus goes back to when the dialog closes.
        e.currentTarget.focus();
        host.act(itemId, kind);
      }}
    >
      <Icon size={13} aria-hidden />
      <span>{LABEL[kind]}</span>
    </button>
  );
}

/** Under an owner's message: the branches it was edited in, each a way to open it. */
export function EditedIn({ edits }: { edits: ReplayRef[] }) {
  const host = useContext(ReplayContext);
  return (
    <div className="edited-in">
      <Pencil size={12} aria-hidden />
      <span>Edited in</span>
      {edits.map((e, i) => (
        <span key={e.chatId}>
          <button className="link-btn" onClick={() => host?.open(e.chatId)} title={`Open "${e.title}", where this message was edited`}>
            {e.title}
          </button>
          {i < edits.length - 1 && ","}
        </span>
      ))}
    </div>
  );
}

/**
 * A reply with other answers Regenerate wrote: a switch between this answer (`children`) and each other one, which is
 * read from its branch. `originalModel`: the model that wrote this reply, when this app saw it written. Each answer
 * says the model and settings it ran on and has a way to open its branch. The answer just made here is shown first.
 */
export function Variants({ variants, originalModel, children }: { variants: ReplayRef[]; originalModel?: string; children: ReactNode }) {
  const host = useContext(ReplayContext);
  const fresh = variants.findIndex((v) => v.chatId === host?.fresh) + 1;
  const [shown, setShown] = useState(fresh);
  const count = variants.length;
  useEffect(() => {
    if (fresh) setShown(fresh);
  }, [fresh]);
  // One gone, its branch deleted, takes the switch back within range.
  useEffect(() => {
    if (shown > count) setShown(count);
  }, [count, shown]);
  const v = shown > 0 ? variants[shown - 1] : undefined;
  return (
    <div className="variants">
      <div className="variant-bar" role="group" aria-label="Answers to your message">
        <button className="icon-btn variant-step" aria-label="Previous answer" disabled={shown === 0} onClick={() => setShown(shown - 1)}>
          <ChevronLeft size={14} />
        </button>
        <span className="variant-count" aria-live="polite">
          Answer {shown + 1} of {count + 1}
        </span>
        <button className="icon-btn variant-step" aria-label="Next answer" disabled={shown === count} onClick={() => setShown(shown + 1)}>
          <ChevronRight size={14} />
        </button>
        <span className="variant-meta">
          {v ? (
            <>
              Regenerated in{" "}
              <button className="link-btn" onClick={() => host?.open(v.chatId)} title="Open the branch this answer was written in">
                {v.title}
              </button>
            </>
          ) : (
            <span title={originalModel ? undefined : "Hermes doesn't record which model wrote an earlier reply."}>
              Original answer{originalModel ? `, ${originalModel}` : ""}
            </span>
          )}
        </span>
      </div>
      {v ? <VariantBody key={v.chatId} v={v} /> : children}
    </div>
  );
}

type Read = { phase: "loading" } | { phase: "ready"; text?: string; model?: string } | { phase: "failed"; why: string };

/** Another answer, read from its branch, again once the reply running there ends. */
function VariantBody({ v }: { v: ReplayRef }) {
  const host = useContext(ReplayContext);
  const [read, setRead] = useState<Read>({ phase: "loading" });
  useEffect(() => {
    if (!host) return;
    let live = true;
    host.read(v.chatId).then(
      (r) => live && setRead({ phase: "ready", ...r }),
      (e) => live && setRead({ phase: "failed", why: messageOf(e) }),
    );
    return () => void (live = false);
    // `read` is the same function for the life of the chat view; a new one only comes with another Hermes.
  }, [host?.read, v.chatId, v.running]);
  const model = modelLabel(v.link.replay.model) ?? (read.phase === "ready" ? read.model : undefined);
  return (
    <div className="variant-body">
      {read.phase === "ready" && read.text ? (
        <Markdown text={read.text} />
      ) : (
        <p className="muted small variant-status" role="status">
          {v.running ? (
            <>
              <Spinner /> Hermes is writing this answer. Open the branch to watch it.
            </>
          ) : read.phase === "loading" ? (
            <>
              <Spinner /> Reading this answer from Hermes…
            </>
          ) : read.phase === "failed" ? (
            `Couldn't read this answer from Hermes: ${read.why}`
          ) : (
            "This branch has no answer yet. Open it to see why."
          )}
        </p>
      )}
      <p className="variant-model muted small">
        {model ? `Model: ${model}.` : "Hermes didn't say which model."} Sent again: your message <q className="branch-quote">{v.link.replay.excerpt}</q>
      </p>
    </div>
  );
}

/** What the dialog needs from the transport: read what would happen, and do it. */
export type ReplayApi = {
  preview: () => Promise<ReplayPreview>;
  make: (preview: ReplayPreview, text: string) => Promise<{ chatId: string; warnings: string[]; delivery: Delivery }>;
};

type State =
  | { phase: "loading" }
  | { phase: "refused"; why: string }
  | { phase: "ready"; preview: ReplayPreview; error?: string }
  | { phase: "making"; preview: ReplayPreview }
  | { phase: "unconfirmed"; why: string };

/** The dialog lists this many of the later messages left out. */
const SHOWN_LATER = 6;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Edit (`kind` "edit"): the message's words to change, with Save as branch and Cancel. Regenerate: a confirmation. Both
 * read first what the new branch would hold, what it leaves out, which files go again and the model, and say that
 * nothing Hermes did is undone. A file no longer on the server must be acknowledged first. `done` gets the branch,
 * whether the message went, and what else went wrong; `onClose` closes with nothing made. Late answers after it closed
 * change nothing, and the composer's Draft is never touched.
 */
export function ReplayDialog({
  kind,
  api,
  returnTo,
  done,
  onClose,
}: {
  kind: ReplayKind;
  api: ReplayApi;
  returnTo?: RefObject<HTMLElement | null>;
  done: (made: { chatId: string; warnings: string[]; delivery: Delivery }) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [text, setText] = useState<string>();
  const [missingOk, setMissingOk] = useState(false);
  const open = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const textId = useId();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    open.current = true;
    apiRef.current.preview().then(
      (preview) => {
        if (!open.current) return;
        setText((t) => t ?? preview.original);
        setState({ phase: "ready", preview });
      },
      (e) => open.current && setState({ phase: "refused", why: messageOf(e) }),
    );
    return () => void (open.current = false);
  }, []);

  const busy = state.phase === "making";
  const close = () => !busy && onClose();
  const preview = state.phase === "ready" || state.phase === "making" ? state.preview : undefined;
  const missing = preview?.files.filter((f) => f.state === "missing") ?? [];
  const words = (text ?? "").trim();
  const unchanged = kind === "edit" && !!preview && words === preview.original.trim();
  const canMake = !!preview && !busy && (kind === "regenerate" || (!!words && !unchanged)) && (!missing.length || missingOk);

  const make = (p: ReplayPreview) => {
    if (!canMake) return;
    setState({ phase: "making", preview: p });
    apiRef.current.make(p, text ?? p.original).then(
      (made) => open.current && done(made),
      (e) => {
        if (!open.current) return;
        if (e instanceof BranchUnconfirmed) setState({ phase: "unconfirmed", why: e.message });
        else setState({ phase: "ready", preview: p, error: messageOf(e) });
      },
    );
  };

  const Icon = kind === "edit" ? Pencil : RefreshCw;
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog branch-dialog replay-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={state.phase === "loading" || busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title branch-title">
          <Icon size={14} aria-hidden /> {kind === "edit" ? "Edit message" : "Regenerate reply"}
        </h2>
        {state.phase === "loading" && (
          <p className="branch-loading" role="status">
            <Spinner /> Reading this chat's history from Hermes…
          </p>
        )}
        {state.phase === "refused" && (
          <p role="alert" className="branch-error">
            <CircleAlert size={13} aria-hidden /> {state.why}
          </p>
        )}
        {state.phase === "unconfirmed" && (
          <p role="alert" className="branch-unsure">
            <CircleAlert size={13} aria-hidden /> {state.why} Doing this again from the same message won't make a second branch.
          </p>
        )}
        {preview && (
          <>
            {kind === "edit" ? (
              <>
                <label className="field-label" htmlFor={textId}>
                  Your message
                </label>
                <textarea
                  id={textId}
                  className="replay-text"
                  autoFocus
                  rows={Math.min(10, Math.max(3, (text ?? "").split("\n").length + 1))}
                  value={text ?? ""}
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      make(preview);
                    }
                  }}
                />
                {unchanged && <p className="muted small">Change the message to save it as a branch. To get another answer to it as it is, use Regenerate under the reply.</p>}
              </>
            ) : (
              <p>
                Hermes answers your message <q className="branch-quote">{preview.original}</q> again, in a new branch of <b>{preview.parentTitle}</b>. This reply stays as
                it is, and you can switch between the answers under it.
              </p>
            )}
            <section aria-label="What the branch holds" className="branch-section">
              <h3>
                <GitBranch size={12} aria-hidden /> The new branch
              </h3>
              <p className="muted small">
                {preview.before
                  ? `It starts with the ${plural(preview.before, "message")} before this one`
                  : "It starts with no earlier messages"}
                {preview.hidden ? " and the project's instructions" : ""}, then {kind === "edit" ? "your edited message" : "your message, sent again"}, which Hermes
                answers. <b>{preview.parentTitle}</b> stays as it is.
              </p>
            </section>
            <section aria-label="Left out of the branch" className="branch-section">
              <h3>Left out</h3>
              {preview.later.messages.length ? (
                <>
                  <p className="muted small">
                    The {plural(preview.later.messages.length, "later message")} ({plural(preview.later.yours, "of yours", "of yours")},{" "}
                    {plural(preview.later.replies, "reply", "replies")}) aren't in the branch. They stay in {preview.parentTitle}.
                  </p>
                  <ol className="branch-history replay-later">
                    {preview.later.messages.slice(0, SHOWN_LATER).map((m, i) => (
                      <li key={i} className={m.role}>
                        <span className="branch-who">{m.role === "user" ? "You" : "Hermes"}</span> {m.excerpt}
                      </li>
                    ))}
                    {preview.later.messages.length > SHOWN_LATER && <li className="muted">and {plural(preview.later.messages.length - SHOWN_LATER, "more")}</li>}
                  </ol>
                </>
              ) : (
                <p className="muted small">Nothing: no message comes after {kind === "edit" ? "this one" : "this reply"}.</p>
              )}
            </section>
            {preview.files.length > 0 && (
              <section aria-label="Files sent again" className="branch-section">
                <h3>
                  <FileText size={12} aria-hidden /> Files sent again
                </h3>
                <ul className="branch-files">
                  {preview.files.map((f) => (
                    <li key={f.path} className={f.state}>
                      <span className="mono">{f.path}</span>{" "}
                      <span className="branch-file-state">
                        {f.state === "there"
                          ? "On the server: Hermes reads it again."
                          : f.state === "missing"
                            ? "No longer on the server: Hermes can't read it."
                            : "Couldn't check whether it's still on the server."}
                      </span>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 && (
                  <label className="branch-ack">
                    <input type="checkbox" checked={missingOk} disabled={busy} onChange={(e) => setMissingOk(e.target.checked)} /> Send anyway: the message still names{" "}
                    {missing.length === 1 ? "this file" : "these files"}, and Hermes won't find {missing.length === 1 ? "it" : "them"}.
                  </label>
                )}
              </section>
            )}
            <dl className="files-meta branch-meta">
              <dt>Model</dt>
              <dd>{preview.model ? `${modelLabel(preview.model)}, as this chat` : "The profile's model"}</dd>
            </dl>
            <p className="branch-warning">
              <Wrench size={13} aria-hidden />
              <span>
                {kind === "edit" ? "Editing" : "Regenerating"} sends a message again; it doesn't undo anything.{" "}
                {preview.later.toolCalls ? `${plural(preview.later.toolCalls, "tool call")} ran after this message. ` : ""}
                Files Hermes changed, commands it ran and anything it sent stay as they are, and the branch's tools work on the same server.
              </span>
            </p>
            {state.phase === "ready" && state.error && (
              <p role="alert" className="branch-error">
                <CircleAlert size={13} aria-hidden /> {state.error}
              </p>
            )}
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" disabled={busy} autoFocus={!preview} onClick={close}>
            {preview ? "Cancel" : "Close"}
          </button>
          {preview && (
            <button className="btn primary" disabled={!canMake} onClick={() => make(preview)}>
              {busy ? (
                <>
                  <Spinner /> Making the branch…
                </>
              ) : kind === "edit" ? (
                "Save as branch"
              ) : (
                "Regenerate"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
