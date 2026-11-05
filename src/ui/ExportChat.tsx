// The Export dialog: the owner picks the messages, whether tool calls and attachment names go in, and what is redacted,
// and sees the file exactly as Save writes it (exportChat.ts `exportPreview`, ADR 0076). It works on the chat as it was
// when the dialog opened, so a reply that arrives meanwhile doesn't change a file already read.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Download, FileDown } from "lucide-react";
import type { Chat, Item } from "../hermes/model";
import { FIRST_DRAFT, REDACTED, exportPreview, isMessage, saveExport, type ExportDraft, type SaveFile } from "../hermes/exportChat";
import { composing } from "./bits";
import { useModal } from "./modal";

const WHO: Record<string, string> = { user: "You", assistant: "Hermes", thinking: "Hermes, thinking" };

/** A message's first words, on one line. */
function gist(i: Item): string {
  const text = "text" in i ? i.text.replace(/\s+/g, " ").trim() : "";
  return text ? (text.length > 90 ? `${text.slice(0, 90)}…` : text) : "(no text)";
}

/** A secret or picked text, short enough to tell apart in a list without filling it. */
function short(text: string): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > 32 ? `${one.slice(0, 18)}…${one.slice(-8)}` : one;
}

const places = (n: number) => (n === 1 ? "1 place" : `${n} places`);

/** Escape, Cancel or a click outside closes it without saving. `onSaved` gets the notice to show once a file is saved. */
export function ExportChatDialog({
  chat,
  save,
  returnTo,
  onSaved,
  onClose,
}: {
  chat: Chat;
  save?: SaveFile;
  returnTo?: RefObject<HTMLElement | null>;
  onSaved: (notice: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const secretsId = useId();
  const pickHelpId = useId();
  const [shot] = useState(() => chat);
  const [at] = useState(() => new Date());
  const [draft, setDraft] = useState<ExportDraft>(FIRST_DRAFT);
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const preview = useMemo(() => exportPreview(shot, draft, at), [draft]);
  const messages = shot.items.filter(isMessage);
  const tools = shot.items.filter((i) => i.kind === "tool" || i.kind === "approval").length;
  const attached = shot.items.reduce((n, i) => n + (i.kind === "user" ? (i.attachments?.length ?? 0) : 0), 0);
  const chosen = messages.length - messages.filter((m) => draft.leftOut.has(m.id)).length;
  const empty = !chosen && !(draft.toolCalls && tools);

  // Text selected in the preview, for Redact selected text. Read on every change, so a keyboard selection counts too.
  useEffect(() => {
    const read = () => {
      const sel = document.getSelection();
      const inside = !!sel && !sel.isCollapsed && !!pre.current?.contains(sel.anchorNode) && pre.current.contains(sel.focusNode);
      setSelected(inside ? sel.toString().trim() : "");
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);

  const change = (d: Partial<ExportDraft>) => setDraft({ ...draft, ...d });
  const toggle = <T,>(set: ReadonlySet<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };
  const pick = () => {
    if (!selected || draft.picked.includes(selected)) return;
    change({ picked: [...draft.picked, selected] });
    document.getSelection()?.removeAllRanges();
    setSelected("");
  };

  const doSave = async () => {
    setSaving(true);
    setNote(undefined);
    try {
      const notice = await saveExport(preview.markdown, preview.fileName, save);
      if (notice) {
        onSaved(notice);
        onClose();
      }
    } catch (e) {
      setNote(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const parts = preview.markdown.split(REDACTED);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={box}
        className="leave-dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !saving && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <FileDown size={14} aria-hidden /> Export “{shot.title}”
        </h2>
        <p>
          A Markdown file of the chat as it was when you opened this; later messages aren't added. Nothing is uploaded: you choose where to save it.
        </p>
        <fieldset className="export-messages">
          <legend>
            Messages: {chosen} of {messages.length}
          </legend>
          <div className="export-bulk">
            <button className="btn small" onClick={() => change({ leftOut: new Set() })} disabled={chosen === messages.length}>
              All
            </button>
            <button className="btn small" onClick={() => change({ leftOut: new Set(messages.map((m) => m.id)) })} disabled={!chosen}>
              None
            </button>
          </div>
          <ul>
            {messages.map((m, n) => (
              <li key={m.id}>
                <label>
                  <input
                    type="checkbox"
                    autoFocus={n === 0}
                    checked={!draft.leftOut.has(m.id)}
                    onChange={(e) => change({ leftOut: toggle(draft.leftOut, m.id, !e.target.checked) })}
                  />
                  <span>
                    <b>{WHO[m.kind]}:</b> <span className="muted">{gist(m)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <fieldset className="export-include">
          <legend>Also include</legend>
          <label>
            <input type="checkbox" checked={draft.toolCalls} disabled={!tools} onChange={(e) => change({ toolCalls: e.target.checked })} />
            <span>
              Tool calls and Approvals, with their commands and output <span className="muted">({tools})</span>
            </span>
          </label>
          <label>
            <input type="checkbox" checked={draft.attachments} disabled={!attached} onChange={(e) => change({ attachments: e.target.checked })} />
            <span>
              Names of attached files <span className="muted">({attached}; their contents are never included)</span>
            </span>
          </label>
        </fieldset>
        <section className="export-secrets" aria-labelledby={secretsId}>
          <h3 id={secretsId}>Likely secrets</h3>
          <p className="muted small">
            Hermes Chat looks for API keys, bearer and sign-in tokens, private keys, and passwords in links or named as a password. It can't find every
            secret: one written another way, such as a password in a sentence, stays in unless you redact it. Read the file below before you save it.
          </p>
          {preview.secrets.length ? (
            <ul>
              {preview.secrets.map((s) => (
                <li key={s.text}>
                  <label>
                    <input type="checkbox" checked={s.redacted} onChange={(e) => change({ kept: toggle(draft.kept, s.text, !e.target.checked) })} />
                    <span>
                      Redact {s.kind.toLowerCase()} <code>{short(s.text)}</code>
                      {s.times > 1 && <span className="muted"> ({places(s.times)})</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">None found in what you've chosen.</p>
          )}
        </section>
        <div className="export-pick">
          <button className="btn" onClick={pick} disabled={!selected} aria-describedby={pickHelpId}>
            Redact selected text
          </button>
          <span id={pickHelpId} className="muted small">
            Select text in the file below to replace it everywhere it appears.
          </span>
        </div>
        {preview.picked.length > 0 && (
          <ul className="export-picked" aria-label="Text you redacted">
            {preview.picked.map((p) => (
              <li key={p.text}>
                <code>{short(p.text)}</code> <span className="muted">{p.times ? places(p.times) : "not in the file now"}</span>
                <button
                  className="btn small"
                  aria-label={`Keep ${short(p.text)} in the file`}
                  onClick={() => change({ picked: draft.picked.filter((t) => t !== p.text) })}
                >
                  Keep
                </button>
              </li>
            ))}
          </ul>
        )}
        <pre ref={pre} className="export-preview" tabIndex={0} aria-label="The file, exactly as it will be saved">
          {parts.map((t, n) => (
            <span key={n}>
              {n > 0 && <mark>{REDACTED}</mark>}
              {t}
            </span>
          ))}
        </pre>
        {note && (
          <p role="alert" className="logs-problem">
            {note}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void doSave()} disabled={saving || empty}>
            <Download size={14} /> Save…
          </button>
        </div>
      </div>
    </div>
  );
}
