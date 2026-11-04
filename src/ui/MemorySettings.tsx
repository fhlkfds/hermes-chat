// Settings → Memory: the built-in memory Hermes keeps for the profile shown, edited one entry at a time on the server
// (memory.ts, GLOSSARY.md "Memory", ADR 0020). Nothing is written until the owner presses Save, and every write is
// checked against the entry as it was read, then read back. An edit Hermes didn't take is kept on screen to copy or put
// in another entry; it is never stored on this computer. Memory text is shown as plain text, never rendered.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, History, Info, RefreshCw, Trash2, Undo2 } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import {
  MEMORY_RESOURCES,
  MemoryConflictError,
  MemoryPermissionError,
  MemoryUnsupportedError,
  MemoryUnsureError,
  MemoryUnverifiedError,
  charCount,
  duplicateProblem,
  entryProblem,
  pyStrip,
  resourceChars,
  resourceOf,
  type MemoryApi,
  type MemoryEntry,
  type MemorySource,
  type MemoryView,
} from "../hermes/memory";

/**
 * The entry open in the editor: as last read from Hermes, and the owner's text for it. `fromKept`: the kept edit the
 * owner put in it, which saving it settles.
 */
type Editing = { entry: MemoryEntry; draft: string; fromKept?: string };
type Notice = { kind: "ok" | "error" | "conflict" | "unsure"; text: string };
/** Why memory couldn't be read: the server or the profile is unsupported here, a permission refusal, or another failure. */
type LoadProblem = { kind: "server" | "profile" | "permission" | "error"; text: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const entriesText = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;
/** An entry's first line, for the list; the editor shows all of it. */
const firstLine = (text: string) => text.split("\n").find((l) => l.trim()) ?? text;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Whether there's an unsaved edit Settings → Memory would lose by closing. */
export const memoryDirty = (editing: Editing | undefined, kept: readonly string[]) =>
  kept.length > 0 || (!!editing && editing.draft !== editing.entry.text);

export function MemorySettings({
  api,
  profile,
  status,
  server,
  onDirtyChange,
  discardSignal = 0,
  source: sourceProp,
  files = true,
}: {
  api: MemoryApi;
  profile: string;
  status: ConnectionStatus;
  /** The file shown, chosen outside (Settings' Memory list, ADR 0051); the owner has already agreed to leave any unsaved edit. */
  source?: MemorySource;
  /** False: the file tabs are drawn elsewhere (Settings' Memory list), so only Reload shows above the entries. */
  files?: boolean;
  /** The server, as Settings names the connection (`routeLabel`). */
  server: string;
  /** Called with whether an unsaved edit is open, and with false once this goes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Changes when the owner chose to discard the unsaved edit from outside (App's question), which drops it here too. */
  discardSignal?: number;
}) {
  const connected = status === "connected";
  const [view, setView] = useState<MemoryView>();
  const [problem, setProblem] = useState<LoadProblem>();
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<MemorySource>(sourceProp ?? "memory");
  const [editing, setEditing] = useState<Editing>();
  const [busy, setBusy] = useState<"save" | "delete" | "reload">();
  // A file picked outside (Settings' list) shows once no save or reload is under way, as the in-page tabs waited by disabling.
  useEffect(() => {
    if (sourceProp && sourceProp !== source && !busy) {
      setSource(sourceProp);
      setEditing(undefined);
    }
  }, [sourceProp, busy]);
  const [notice, setNotice] = useState<Notice>();
  // The owner's texts that Hermes didn't take (a conflict, or a save that read back differently), each kept to copy or
  // to put in an entry until they discard it. A later one never replaces an earlier one.
  const [kept, setKept] = useState<string[]>([]);
  const keep = (text: string) => setKept((k) => (k.includes(text) ? k : [...k, text]));
  // A save whose outcome is unknown, until a read shows whether Hermes has it: the text sent, and the entry it was for
  // (its id, file and text as read before the save).
  const [unsure, setUnsure] = useState<{ text: string; entryId: string; source: MemorySource; from: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Opening another entry or file while the open one has an unsaved edit asks first; this is what it would do.
  const [leaving, setLeaving] = useState<() => void>();
  // Answers for this profile only: a late answer after the screen went away, or after a newer read, is dropped.
  const alive = useRef(true);
  const reads = useRef(0);
  const textArea = useRef<HTMLTextAreaElement>(null);

  const dirty = memoryDirty(editing, kept);
  useEffect(() => onDirtyChange(dirty), [dirty]);
  const discards = useRef(discardSignal);
  useEffect(() => {
    if (discardSignal === discards.current) return;
    discards.current = discardSignal;
    setEditing(undefined);
    setKept([]);
    setUnsure(undefined);
    setLeaving(undefined);
    setConfirmDelete(false);
    setNotice(undefined);
  }, [discardSignal]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, []);

  /** Puts a fresh read on screen, keeping the open edit if its entry is still there as it was. */
  const show = (next: MemoryView, opts: { keep?: Editing } = {}) => {
    setView(next);
    setProblem(undefined);
    const open = opts.keep ?? editing;
    if (!open) return;
    const still = next.resources[open.entry.source].entries.find((e) => e.id === open.entry.id);
    if (still) return setEditing({ ...open, entry: still });
    // The entry changed or went: an edit in it is kept, never dropped.
    if (open.draft !== open.entry.text) {
      keep(open.draft);
      setNotice({ kind: "conflict", text: "The entry you were editing changed on the server, or was removed. Your edit is kept below; nothing was saved." });
    }
    setEditing(undefined);
  };

  const failLoad = (e: unknown) => {
    if (e instanceof MemoryUnsupportedError) setProblem({ kind: e.reason, text: e.message });
    else if (e instanceof MemoryPermissionError) setProblem({ kind: "permission", text: e.message });
    else setProblem({ kind: "error", text: `Couldn't read memory from Hermes: ${messageOf(e)}` });
  };

  const load = async (why: "first" | "reload") => {
    const n = ++reads.current;
    if (why === "reload") {
      setBusy("reload");
      // Questions lapse: what they'd act on could change under the read.
      setLeaving(undefined);
      setConfirmDelete(false);
    }
    setLoading(true);
    try {
      const next = await api.load(profile);
      if (!alive.current || n !== reads.current) return;
      if (unsure !== undefined) {
        // A read settles a save whose answer was lost, as far as it can. Only the file the save was for counts. While
        // the entry's old text is still there, the save didn't happen (an edit replaces it). Once it's gone, a match
        // isn't proof: another client may have removed the entry and given another one the same words. So the edit is
        // never moved onto a matching entry; anything not already in memory is kept for the owner to place.
        const entries = next.resources[unsure.source].entries;
        const oldThere = entries.some((e) => e.text === unsure.from);
        const match = entries.find((e) => e.text === unsure.text);
        const mine = editing?.entry.id === unsure.entryId ? editing : undefined;
        setUnsure(undefined);
        if (oldThere) {
          setNotice({
            kind: "unsure",
            text: mine
              ? "Hermes doesn't have your edit: reading memory back doesn't show it. Your edit is still here to save again."
              : "Hermes doesn't have the edit whose answer was lost: reading memory back doesn't show it.",
          });
          return show(next);
        }
        if (!mine) {
          setNotice({
            kind: "unsure",
            text: match
              ? "Memory now has an entry with the words of the edit whose answer was lost, so that save may have gone through."
              : "Hermes doesn't have the edit whose answer was lost: reading memory back doesn't show it.",
          });
          return show(next);
        }
        setView(next);
        setProblem(undefined);
        if (match && pyStrip(mine.draft) === unsure.text) {
          // Nothing typed since, and memory has those words: nothing is lost. The entry opens unedited; nothing is written.
          setSource(match.source);
          setEditing({ entry: match, draft: match.text });
          setNotice({ kind: "ok", text: "Reading memory back shows an entry with the words you saved. Check it's the one you meant." });
          return;
        }
        if (mine.draft !== mine.entry.text) keep(mine.draft);
        setEditing(undefined);
        setNotice({
          kind: "unsure",
          text: match
            ? "Hermes has an entry with the words you saved, so the save may have gone through, but the entry you were editing changed or went. Your edit is kept below; nothing more was saved."
            : "Hermes doesn't have your edit, and the entry you were editing changed or went. Your edit is kept below; nothing more was saved.",
        });
        return;
      } else if (why === "reload") setNotice(undefined);
      show(next);
    } catch (e) {
      if (!alive.current || n !== reads.current) return;
      if (editing && editing.draft !== editing.entry.text && e instanceof MemoryUnsupportedError) {
        keep(editing.draft);
        setEditing(undefined);
      }
      failLoad(e);
    } finally {
      if (alive.current && n === reads.current) {
        setLoading(false);
        setBusy(undefined);
      }
    }
  };

  // Read once connected; after a drop, the screen keeps what it read, and the owner's edit, until Reload.
  useEffect(() => {
    if (connected && !view && !problem && !loading) void load("first");
  }, [connected]);

  /** Runs `go` now, or once the owner agrees to drop the open entry's unsaved edit. A kept edit stays either way. */
  const leaveEntry = (go: () => void) => {
    const run = () => {
      setLeaving(undefined);
      setConfirmDelete(false);
      setNotice(undefined);
      go();
    };
    if (editing && editing.draft !== editing.entry.text) setLeaving(() => run);
    else run();
  };

  // While a save, removal or read is under way, the open entry and file stay put, so its answer lands where it belongs.
  const open = (entry: MemoryEntry) => {
    if (!busy && editing?.entry.id !== entry.id) leaveEntry(() => setEditing({ entry, draft: entry.text }));
  };

  const pickSource = (s: MemorySource) => {
    if (!busy && s !== source)
      leaveEntry(() => {
        setSource(s);
        setEditing(undefined);
      });
  };

  const save = async () => {
    if (!editing || busy) return;
    const at = editing;
    setBusy("save");
    // A question about opening something else lapses: what it would open could change under the save.
    setLeaving(undefined);
    setNotice(undefined);
    try {
      const { view: next, entry } = await api.save(profile, at.entry, at.draft);
      if (!alive.current) return;
      setView(next);
      setEditing({ entry, draft: entry.text });
      setKept((k) => k.filter((t) => t !== at.fromKept && pyStrip(t) !== entry.text));
      setNotice({ kind: "ok", text: `Saved, and read back from Hermes. New chats on ${profile} start with it. Restore previous version puts back what it replaced.` });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof MemoryConflictError || e instanceof MemoryUnverifiedError) {
        setView(e.view);
        keep(at.draft);
        setEditing(undefined);
        setNotice({
          kind: "conflict",
          text: e instanceof MemoryConflictError ? e.message : `${e.message} Your edit is kept below.`,
        });
      } else if (e instanceof MemoryUnsureError) {
        setUnsure({ text: pyStrip(at.draft), entryId: at.entry.id, source: at.entry.source, from: at.entry.text });
        setNotice({ kind: "unsure", text: e.message });
      } else if (e instanceof MemoryUnsupportedError) {
        keep(at.draft);
        setEditing(undefined);
        failLoad(e);
      } else setNotice({ kind: "error", text: `${messageOf(e)} Your edit is still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const remove = async () => {
    if (!editing || busy) return;
    const at = editing;
    setBusy("delete");
    setLeaving(undefined);
    setConfirmDelete(false);
    setNotice(undefined);
    try {
      const next = await api.remove(profile, at.entry);
      if (!alive.current) return;
      setView(next);
      // Only the entry removed closes; anything opened meanwhile stays as it is.
      setEditing((cur) => (cur?.entry.id === at.entry.id ? undefined : cur));
      setNotice({ kind: "ok", text: "Removed, and read back from Hermes: the entry is gone." });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof MemoryConflictError || e instanceof MemoryUnverifiedError) {
        setView(e.view);
        if (at.draft !== at.entry.text) keep(at.draft);
        setEditing(undefined);
        setNotice({ kind: "conflict", text: e instanceof MemoryConflictError ? "This entry changed on the server, or was removed, since you opened it. Nothing was removed." : e.message });
      } else if (e instanceof MemoryUnsureError) setNotice({ kind: "unsure", text: e.message });
      else if (e instanceof MemoryUnsupportedError) failLoad(e);
      else setNotice({ kind: "error", text: messageOf(e) });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const resource = view?.resources[source];
  const meta = resourceOf(source);
  const filePath = view?.home ? `${view.home.replace(/\/+$/, "")}/memories/${meta.file}` : meta.file;
  const changed = !!editing && editing.draft !== editing.entry.text;
  const draftProblem = changed && editing ? (entryProblem(editing.draft) ?? (view && duplicateProblem(editing.draft, editing.entry, view.resources[editing.entry.source].entries))) : undefined;
  // What this app's last save of the open entry replaced, unless that's already in the editor.
  const before = editing && api.replacedBy(profile, editing.entry);
  const restorable = before && before.text !== editing?.draft ? before : undefined;
  const restore = (r: NonNullable<typeof restorable>, at: MemoryEntry) =>
    leaveEntry(() => {
      // Only into the entry it was for, in case another opened meanwhile.
      setEditing((cur) => (cur?.entry.id === at.id ? { ...cur, draft: r.text, fromKept: undefined } : cur));
      // The Restore button goes once its text is in the editor, so focus moves there rather than to the page.
      textArea.current?.focus();
      setNotice({ kind: "ok", text: `The text your save at ${clock(r.savedAt)} replaced is in the editor. Save to put it back on Hermes; nothing has changed there yet.` });
    });

  return (
    <>
      <section aria-labelledby="memory-heading">
        <h2 id="memory-heading">Memory</h2>
        <p className="muted">
          What Hermes remembers between chats on this profile: its own notes, and what it knows about you. It's kept in two files on the server, and
          editing here changes them there. The agent also adds, changes and removes entries itself during chats.
        </p>
        <dl className="memory-identity">
          <div>
            <dt>Server</dt>
            <dd className="mono">{server}</dd>
          </div>
          <div>
            <dt>Profile</dt>
            <dd className="mono">{profile}</dd>
          </div>
          {view && (
            <div>
              <dt>File</dt>
              <dd className="mono">{filePath}</dd>
            </div>
          )}
        </dl>

        {problem ? (
          <div className={`memory-state ${problem.kind}`} role="alert">
            {problem.kind === "server" || problem.kind === "profile" ? <Info size={14} /> : <AlertTriangle size={14} />}
            <div>
              <div className="memory-state-title">
                {problem.kind === "server"
                  ? "This Hermes server can't edit memory"
                  : problem.kind === "profile"
                    ? "This profile's memory can't be edited here"
                    : problem.kind === "permission"
                      ? "Hermes refused"
                      : "Couldn't read memory"}
              </div>
              <div className="small">{problem.text}</div>
            </div>
            {problem.kind !== "server" && (
              <button className="btn" disabled={!connected || loading} onClick={() => void load("reload")}>
                <RefreshCw size={14} /> {loading ? "Trying…" : "Try again"}
              </button>
            )}
          </div>
        ) : !view ? (
          <div className="memory-state" role="status">
            <div className="small muted">{connected ? "Reading memory from Hermes…" : "Not connected to Hermes. Memory shows once it's connected."}</div>
          </div>
        ) : (
          <>
            {!connected && (
              <div className="memory-state warn" role="status">
                <AlertTriangle size={14} />
                <div className="small">Not connected to Hermes. This is memory as last read; reconnect to save or reload.</div>
              </div>
            )}
            {view.provider && (
              <p className="muted small">
                <Info size={12} /> This profile also uses the <span className="mono">{view.provider}</span> memory provider. What it stores is kept by that
                provider, not in these files, and isn't shown here. Its settings are under External memory below.
              </p>
            )}
            <div className={`memory-resources ${files ? "" : "memory-toolbar"}`} role={files ? "tablist" : undefined} aria-label={files ? "Memory files" : undefined}>
              {files && MEMORY_RESOURCES.map((r) => {
                const n = view.resources[r.source].entries.length;
                return (
                  <button
                    key={r.source}
                    role="tab"
                    id={`memory-tab-${r.source}`}
                    aria-selected={source === r.source}
                    aria-controls="memory-panel"
                    className={`memory-resource ${source === r.source ? "on" : ""}`}
                    disabled={!!busy && source !== r.source}
                    onClick={() => pickSource(r.source)}
                  >
                    <span className="memory-resource-name">{r.name}</span>
                    <span className="mono muted">{r.file}</span>
                    <span className="muted small">{entriesText(n)}</span>
                  </button>
                );
              })}
              <button
                className="btn memory-reload"
                disabled={!connected || !!busy}
                onClick={() => void load("reload")}
                title="Read memory from Hermes again. An edit you're making is kept."
              >
                <RefreshCw size={14} /> {busy === "reload" ? "Reloading…" : "Reload"}
              </button>
            </div>

            <div id="memory-panel" role={files ? "tabpanel" : undefined} aria-labelledby={files ? `memory-tab-${source}` : undefined}>
              <p className="muted small memory-about">
                {meta.about} {resource && `${entriesText(resource.entries.length)}, ${resourceChars(resource.entries).toLocaleString()} characters.`}
              </p>
              {resource && !resource.entries.length ? (
                <div className="memory-empty muted small">
                  {resource.bytes
                    ? `Hermes lists no entries, though ${meta.file} holds ${resource.bytes.toLocaleString()} bytes. Hermes may not be able to read the file.`
                    : `There's nothing in ${meta.file} yet. Hermes adds to it during chats.`}
                </div>
              ) : (
                <ul className="memory-entries" aria-label={`${meta.name} entries`}>
                  {resource?.entries.map((e) => (
                    <li key={e.id}>
                      <button className={`memory-entry ${editing?.entry.id === e.id ? "on" : ""}`} aria-current={editing?.entry.id === e.id || undefined}
                        disabled={!!busy && editing?.entry.id !== e.id}
                        onClick={() => open(e)}
                      >
                        <span className="memory-entry-text">{firstLine(e.text)}</span>
                        <span className="muted small">{charCount(e.text).toLocaleString()} characters</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {leaving && (
                <div className="confirm memory-leave" role="alertdialog" aria-label="Discard your edit?">
                  <span className="confirm-msg">Discard your unsaved edit to this entry? Nothing of it has been saved to Hermes.</span>
                  <div className="confirm-actions">
                    <button className="btn" autoFocus onClick={() => setLeaving(undefined)}>
                      Keep editing
                    </button>
                    <button className="btn danger" onClick={leaving}>
                      Discard edit
                    </button>
                  </div>
                </div>
              )}

              {editing && (
                <div className="memory-editor" role="group" aria-label={`Edit entry in ${meta.file}`}>
                  <label className="field">
                    <span className="field-label">
                      Entry in <span className="mono">{meta.file}</span>
                      {changed && <span className="badge warn">Unsaved</span>}
                    </span>
                    <textarea
                      ref={textArea}
                      className="memory-text"
                      value={editing.draft}
                      spellCheck={false}
                      rows={Math.min(14, Math.max(4, editing.draft.split("\n").length + 1))}
                      disabled={!!busy}
                      onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                    />
                    <span className={`field-hint ${draftProblem ? "err" : ""}`}>
                      {draftProblem ?? `${charCount(pyStrip(editing.draft)).toLocaleString()} characters. Hermes refuses an edit that takes the file past its limit.`}
                    </span>
                  </label>
                  {kept.map(
                    (text, i) =>
                      editing.draft !== text && (
                        <button key={i} className="btn small-btn" disabled={!!busy} onClick={() => {
                            // The text it replaces is kept too, if it was an unsaved edit.
                            if (editing.draft !== editing.entry.text) keep(editing.draft);
                            setEditing({ ...editing, draft: text, fromKept: text });
                          }}
                        >
                          <Undo2 size={14} /> {kept.length === 1 ? "Put your kept edit in this entry" : `Put kept edit ${i + 1} in this entry`}
                        </button>
                      ),
                  )}
                  {confirmDelete ? (
                    <div className="confirm" role="alertdialog" aria-label="Remove this entry?">
                      <span className="confirm-msg">
                        <Trash2 size={12} /> Remove this entry from {meta.file} on the server? Hermes forgets it in new chats. It can't be undone from here.
                      </span>
                      <div className="confirm-actions">
                        <button className="btn" autoFocus onClick={() => setConfirmDelete(false)}>
                          Keep it
                        </button>
                        <button className="btn danger" disabled={!connected || !!busy} onClick={() => void remove()}>
                          Remove entry
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="memory-actions">
                      <div className="confirm-actions">
                        <button className="btn danger" disabled={!connected || !!busy || changed} onClick={() => setConfirmDelete(true)} title={changed ? "Save or cancel your edit first." : undefined}>
                          <Trash2 size={14} /> {busy === "delete" ? "Removing…" : "Delete"}
                        </button>
                        {restorable && (
                          <button className="btn" disabled={!!busy} onClick={() => restore(restorable, editing.entry)} title={`The text your save at ${clock(restorable.savedAt)} replaced.`}>
                            <History size={14} /> Restore previous version
                          </button>
                        )}
                      </div>
                      <div className="confirm-actions">
                        <button
                          className="btn"
                          disabled={!!busy}
                          onClick={() => {
                            setEditing(undefined);
                            setNotice(undefined);
                          }}
                        >
                          Cancel
                        </button>
                        <button className="btn primary" disabled={!connected || !changed || !!draftProblem || !!busy} onClick={() => void save()}>
                          {busy === "save" ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {notice && (
                <div className={`memory-notice ${notice.kind}`} role={notice.kind === "ok" ? "status" : "alert"}>
                  {notice.kind === "ok" ? <Check size={14} /> : <AlertTriangle size={14} />}
                  <span>{notice.text}</span>
                </div>
              )}

              <p className="muted small settings-note">
                To add a memory, ask Hermes in a chat to remember it. Hermes has no call for adding one from another app. Restore previous version
                puts back what a save from here replaced, while the entry still holds what you saved, until you sign out or close Hermes Chat. It's kept
                only in this app's memory, never on the server or this computer's disk, and a removed entry can't be put back from here.
              </p>
            </div>
          </>
        )}

        {kept.map((text, i) => {
          const name = kept.length === 1 ? "Your kept edit" : `Your kept edit ${i + 1}`;
          return (
            <div key={i} className="memory-recovered" role="group" aria-label={name}>
              <div className="field-label">
                {name} <span className="muted small">(not saved anywhere; leaving this screen asks before it goes)</span>
              </div>
              <textarea className="memory-text" readOnly value={text} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} aria-label={name} />
              <div className="confirm-actions">
                <button className="btn" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>
                  <Copy size={14} /> Copy
                </button>
                <button className="btn" aria-label={`Discard ${name.toLowerCase()}`} onClick={() => setKept((k) => k.filter((t) => t !== text))}>
                  Discard it
                </button>
              </div>
              <p className="muted small">Open an entry and put this edit in it to save it there, after checking what Hermes has now.</p>
            </div>
          );
        })}
      </section>

      <section>
        <h2>When edits take effect</h2>
        <p className="muted">
          Hermes reads memory into a chat when the chat starts, so a saved edit reaches chats started after it, from any Hermes client. A chat that's
          already going keeps the memory it started with until Hermes compresses its history, when it reads memory again. Saving changes only the file;
          it never restarts Hermes. Hermes leaves out of a chat any entry that looks like an attempt to take over the agent, and shows a note in its
          place.
        </p>
      </section>
    </>
  );
}
