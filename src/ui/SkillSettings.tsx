// Settings → Skills: the skills Hermes offers the model in the profile shown, listed with where each comes from and
// whether it's on, switched on or off, and their SKILL.md edited (skills.ts, GLOSSARY.md "Skill", ADR 0030). Nothing is
// written until the owner presses Save, every save is checked against the file as opened and read back, and an edit
// Hermes didn't take stays on screen. Skill text is instructions for the agent, shown as plain text only, never run or
// rendered. Installing skills from elsewhere isn't done here.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Copy, GitMerge, History, Info, RefreshCw, Search } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import { merge3 } from "../hermes/textEdit";
import {
  ESSENTIAL_SKILLS,
  SkillsError,
  declaredName,
  skillProblems,
  type ReferenceCheck,
  type SkillFile,
  type SkillRow,
  type SkillsApi,
  type SkillsView,
} from "../hermes/skills";

/** The skill open in the editor: its row, SKILL.md as last read from Hermes, and the owner's text. */
type Editing = { row: SkillRow; base: SkillFile; draft: string };
type Notice = { kind: "ok" | "error" | "conflict" | "unsure"; text: string };
type LoadProblem = { kind: "unsupported" | "permission" | "error"; text: string };
type RowNote = { name: string; kind: "ok" | "failed"; text: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SOURCE: Record<string, string> = { hub: "Skills Hub", bundled: "Built in", external: "External folder", agent: "Local" };
const sourceLabel = (s: string) => SOURCE[s] ?? s;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** An element id for a skill's row: one per name, without spaces (ids go in `aria-labelledby` lists). */
const domId = (name: string) => `skill-${encodeURIComponent(name)}`;

/** What happens after an edit is saved, for the notice and the screen's note. */
const EDIT_EFFECT =
  "The agent reads SKILL.md each time it loads the skill, so its next load, in any chat, gets this text. The name and description in the skills list the agent sees reach chats started from now on.";
const switchEffect = (on: boolean) =>
  on
    ? "New chats list it among their skills. A chat already going doesn't list it, but can still load it by name."
    : "New chats leave it out, and from now on Hermes refuses to load it in any chat, even one already going.";

export function SkillSettings({
  api,
  profile,
  status,
  server,
  onDirtyChange,
  discardSignal = 0,
}: {
  api: SkillsApi;
  profile: string;
  status: ConnectionStatus;
  /** The server, as Settings names the connection (`routeLabel`). */
  server: string;
  /** Called with whether an unsaved edit is open, and with false once this goes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Changes when the owner chose to discard the unsaved edit from outside (App's question), which drops it here too. */
  discardSignal?: number;
}) {
  const connected = status === "connected";
  const [view, setView] = useState<SkillsView>();
  const [problem, setProblem] = useState<LoadProblem>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [toggling, setToggling] = useState<string>();
  const [rowNote, setRowNote] = useState<RowNote>();
  const [opening, setOpening] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  // The server's version when it changed under the edit: kept beside the owner's edit until they merge or pick one.
  const [conflict, setConflict] = useState<SkillFile>();
  // The referenced files a Save found missing, for the text it checked; another edit makes it lapse.
  const [refs, setRefs] = useState<ReferenceCheck & { draft: string }>();
  const [busy, setBusy] = useState<"save" | "reload">();
  const [notice, setNotice] = useState<Notice>();
  // A question before the open edit is dropped or replaced: what it says, and what it would do.
  const [leaving, setLeaving] = useState<{ text: string; go: () => void }>();
  // Answers for this profile only: a late answer after the screen went away, or after a newer request, is dropped.
  const alive = useRef(true);
  const reads = useRef(0);
  const opens = useRef(0);
  const focusAfter = useRef<string | undefined>(undefined);

  const dirty = !!editing && editing.draft !== editing.base.content;
  useEffect(() => onDirtyChange(dirty), [dirty]);
  const discards = useRef(discardSignal);
  useEffect(() => {
    if (discardSignal === discards.current) return;
    discards.current = discardSignal;
    close();
  }, [discardSignal]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, []);
  // Back in the list, focus returns to the skill's Edit button.
  useEffect(() => {
    if (editing || !focusAfter.current) return;
    document.getElementById(`${domId(focusAfter.current)}-edit`)?.focus();
    focusAfter.current = undefined;
  }, [editing]);

  const names = view?.skills.map((s) => s.name) ?? [];

  const load = async () => {
    const n = ++reads.current;
    setLoading(true);
    try {
      const next = await api.list(profile);
      if (!alive.current || n !== reads.current) return;
      setView(next);
      setProblem(undefined);
    } catch (e) {
      if (!alive.current || n !== reads.current) return;
      const kind = e instanceof SkillsError && (e.kind === "unsupported" || e.kind === "permission") ? e.kind : "error";
      // A read that fails while a list is on screen leaves it there, said to be as last read.
      if (view && kind === "error") setRowNote({ name: "", kind: "failed", text: `Couldn't read skills from Hermes again: ${messageOf(e)}` });
      else setProblem({ kind, text: kind === "error" ? `Couldn't read skills from Hermes: ${messageOf(e)}` : messageOf(e) });
    } finally {
      if (alive.current && n === reads.current) setLoading(false);
    }
  };

  // Read once connected; after a drop, the screen keeps what it read, and the owner's edit, until Reload.
  useEffect(() => {
    if (connected && !view && !problem && !loading) void load();
  }, [connected]);

  function close() {
    if (editing) focusAfter.current = editing.row.name;
    setEditing(undefined);
    setConflict(undefined);
    setRefs(undefined);
    setNotice(undefined);
    setLeaving(undefined);
  }

  /** Runs `go` now, or once the owner agrees to drop the open edit. */
  const unlessDirty = (text: string, go: () => void) => (dirty ? setLeaving({ text, go: () => (setLeaving(undefined), go()) }) : go());

  const open = async (row: SkillRow) => {
    if (busy || opening) return;
    const n = ++opens.current;
    setOpening(row.name);
    setRowNote(undefined);
    try {
      const file = await api.read(profile, row.name, names);
      if (!alive.current || n !== opens.current) return;
      setEditing({ row, base: file, draft: file.content });
      setConflict(undefined);
      setRefs(undefined);
      setNotice(undefined);
    } catch (e) {
      if (alive.current && n === opens.current) setRowNote({ name: row.name, kind: "failed", text: `Couldn't open ${row.name}: ${messageOf(e)}` });
    } finally {
      if (alive.current && n === opens.current) setOpening(undefined);
    }
  };

  const toggle = async (row: SkillRow) => {
    if (toggling || !connected) return;
    const want = !row.enabled;
    setToggling(row.name);
    setRowNote(undefined);
    try {
      const r = await api.setEnabled(profile, row.name, want);
      if (!alive.current) return;
      reads.current++; // A list read still under way is older than this one.
      setView(r.view);
      setLoading(false);
      const now = r.view.skills.find((s) => s.name === row.name);
      const state = now ? (now.enabled ? "on" : "off") : "gone from the list";
      setRowNote(
        r.confirmed
          ? { name: row.name, kind: "ok", text: `Turned ${want ? "on" : "off"}, and read back from Hermes. ${switchEffect(want)}` }
          : {
              name: row.name,
              kind: "failed",
              text: r.lost
                ? `Hermes didn't answer (${r.lost.message}), and reading back shows ${row.name} ${state}.`
                : `Hermes answered, but reading back shows ${row.name} ${state}, so the change didn't take.`,
            },
      );
    } catch (e) {
      if (alive.current) setRowNote({ name: row.name, kind: "failed", text: messageOf(e) });
    } finally {
      if (alive.current) setToggling(undefined);
    }
  };

  const save = async (allowMissing: boolean) => {
    if (!editing || busy || skillProblems(editing.draft, declaredName(editing.base)).length) return;
    const at = editing;
    setBusy("save");
    setNotice(undefined);
    setLeaving(undefined);
    try {
      const check = await api.checkReferences(at.base, at.draft);
      if (!alive.current) return;
      setRefs({ ...check, draft: at.draft });
      if (check.outside.length || (check.missing.length && !allowMissing)) return;
      const r = await api.save(profile, at.base, at.draft, names);
      if (!alive.current) return;
      if (r.kind === "saved") {
        setEditing({ ...at, base: r.file, draft: r.file.content });
        setConflict(undefined);
        setRefs(undefined);
        setNotice({ kind: "ok", text: `Saved, and read back from Hermes. ${EDIT_EFFECT}` });
        void load();
      } else if (r.kind === "conflict") {
        setConflict(r.server);
        setNotice({
          kind: "conflict",
          text: "SKILL.md changed on the server since you opened it, so nothing was saved. Your edit is still here, and the server's version is below: merge them, or use the server's.",
        });
      } else if (r.kind === "changed") {
        setConflict(r.server);
        setNotice({ kind: "conflict", text: "Hermes saved your edit, but reading it back found other text: another client wrote SKILL.md too. Your edit and the server's version are both kept." });
      } else setNotice({ kind: "unsure", text: `Hermes may have saved it, but reading it back failed: ${r.problem.message} Your edit is still here; Save again once connected, and it's checked first.` });
    } catch (e) {
      if (alive.current) setNotice({ kind: "error", text: `${messageOf(e)} Your edit is still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const reload = async () => {
    if (!editing || busy) return;
    const at = editing;
    setBusy("reload");
    setNotice(undefined);
    setLeaving(undefined);
    try {
      const file = await api.read(profile, at.base.name, names);
      if (!alive.current) return;
      if (file.path === at.base.path && file.content === at.base.content)
        setNotice({ kind: "ok", text: at.draft === at.base.content ? "Hermes still has this version." : "Hermes still has the version you opened, so your edit is kept." });
      else if (at.draft === at.base.content) {
        setEditing({ ...at, base: file, draft: file.content });
        setNotice({ kind: "ok", text: "Reloaded the newer version Hermes has." });
      } else {
        setConflict(file);
        setNotice({ kind: "conflict", text: "SKILL.md changed on the server since you opened it. Your edit is kept, and the server's version is below." });
      }
      void load();
    } catch (e) {
      if (alive.current) setNotice({ kind: "error", text: `Couldn't read ${at.base.name} again: ${messageOf(e)} Your edit is still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const mergeIn = () => {
    // While a save or reload runs, its answer is for the text it started with: nothing may change that text meanwhile.
    if (!editing || !conflict || busy) return;
    const m = merge3(editing.base.content, editing.draft, conflict.content);
    setEditing({ ...editing, base: conflict, draft: m.text });
    setConflict(undefined);
    setNotice({
      kind: m.conflicts ? "unsure" : "ok",
      text: m.conflicts
        ? `Merged. In ${m.conflicts === 1 ? "one place" : `${m.conflicts} places`} both versions changed the same lines; both are kept between markers. Settle ${m.conflicts === 1 ? "it" : "each"}, then Save.`
        : "Merged the server's changes into your edit. Check it, then Save.",
    });
  };

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    const rows = view?.skills ?? [];
    return q ? rows.filter((s) => `${s.name}\n${s.description}\n${s.category ?? ""}`.toLowerCase().includes(q)) : rows;
  })();
  const off = view?.skills.filter((s) => !s.enabled).length ?? 0;

  return (
    <>
      <section aria-labelledby="skills-heading">
        <h2 id="skills-heading">Skills</h2>
        <p className="muted">
          Instructions Hermes can load for a task, each a SKILL.md file in a folder on the server. The agent sees each skill's name and description,
          and loads the rest when it needs it. Turning a skill off or editing it here changes it on the server, for every Hermes client using this profile.
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
        </dl>

        {problem ? (
          <div className={`memory-state ${problem.kind}`} role="alert">
            {problem.kind === "unsupported" ? <Info size={14} /> : <AlertTriangle size={14} />}
            <div>
              <div className="memory-state-title">
                {problem.kind === "unsupported" ? "This Hermes server can't manage skills" : problem.kind === "permission" ? "Hermes refused" : "Couldn't read skills"}
              </div>
              <div className="small">{problem.text}</div>
            </div>
            {problem.kind !== "unsupported" && (
              <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                <RefreshCw size={14} /> {loading ? "Trying…" : "Try again"}
              </button>
            )}
          </div>
        ) : !view ? (
          <div className="memory-state" role="status">
            <div className="small muted">{connected ? "Reading skills from Hermes…" : "Not connected to Hermes. Skills show once it's connected."}</div>
          </div>
        ) : (
          <>
            {!connected && (
              <div className="memory-state warn" role="status">
                <AlertTriangle size={14} />
                <div className="small">Not connected to Hermes. These are the skills as read at {clock(view.readAt)}; reconnect to change or save them.</div>
              </div>
            )}
            {editing ? (
              <div className="memory-editor skills-editor" role="group" aria-label={`Edit ${editing.row.name}`}>
                <button className="back" autoFocus disabled={!!busy} onClick={() => unlessDirty("Discard your unsaved edit to this skill? Nothing of it has been saved to Hermes.", close)}>
                  <ArrowLeft size={15} /> All skills
                </button>
                <h3 className="mono skills-name">{editing.row.name}</h3>
                <dl className="memory-identity">
                  <div>
                    <dt>File</dt>
                    <dd className="mono">{editing.base.path}</dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{editing.row.scope === "shared" ? "Shared folder" : "This profile"}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{sourceLabel(editing.row.source)}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{editing.row.enabled ? "On" : "Off"}</dd>
                  </div>
                </dl>
                {editing.row.scope === "shared" && (
                  <p className="muted small skills-note">
                    <Info size={12} /> This skill is in a folder the profile's <span className="mono">skills.external_dirs</span> names, outside its own skills
                    folder. Other profiles that list that folder get the edit too.
                  </p>
                )}
                {(editing.row.source === "bundled" || editing.row.source === "hub") && (
                  <p className="muted small skills-note">
                    <Info size={12} />{" "}
                    {editing.row.source === "bundled"
                      ? "This skill came with Hermes. Once edited, Hermes's updates keep your copy and stop updating it."
                      : "This skill came from the Skills Hub. Once edited, hub updates skip it and keep your copy."}
                  </p>
                )}
                <label className="field">
                  <span className="field-label">
                    SKILL.md {dirty && <span className="badge warn">Unsaved</span>}
                  </span>
                  <textarea
                    className="memory-text skills-text"
                    value={editing.draft}
                    spellCheck={false}
                    rows={Math.min(24, Math.max(10, editing.draft.split("\n").length + 1))}
                    disabled={!!busy}
                    onChange={(e) => {
                      setEditing({ ...editing, draft: e.target.value });
                      // A success said about the text before this change no longer holds.
                      if (notice?.kind === "ok") setNotice(undefined);
                    }}
                  />
                </label>
                <SkillProblems editing={editing} refs={refs?.draft === editing.draft ? refs : undefined} busy={!!busy} connected={connected} onSaveAnyway={() => void save(true)} />
                {conflict && (
                  <div className="memory-recovered" role="group" aria-label="The version on the server now">
                    <div className="field-label">
                      On the server now <span className="muted small">(your edit is above; nothing is lost until you choose)</span>
                    </div>
                    <textarea className="memory-text" readOnly value={conflict.content} rows={Math.min(14, Math.max(4, conflict.content.split("\n").length + 1))} aria-label="The version on the server now" />
                    <div className="confirm-actions">
                      <button className="btn" onClick={() => void navigator.clipboard?.writeText(conflict.content).catch(() => {})}>
                        <Copy size={14} /> Copy
                      </button>
                      <button
                        className="btn"
                        disabled={!!busy}
                        onClick={() =>
                          setLeaving({
                            text: "Use the server's version and drop your edit? Nothing of your edit has been saved to Hermes.",
                            go: () => {
                              setLeaving(undefined);
                              setEditing({ ...editing, base: conflict, draft: conflict.content });
                              setConflict(undefined);
                              setNotice(undefined);
                            },
                          })
                        }
                      >
                        Use the server's version
                      </button>
                      <button className="btn primary" disabled={!!busy} onClick={mergeIn}>
                        <GitMerge size={14} /> Merge into my edit
                      </button>
                    </div>
                  </div>
                )}
                {leaving && (
                  <div className="confirm memory-leave" role="alertdialog" aria-label="Discard your edit?">
                    <span className="confirm-msg">{leaving.text}</span>
                    <div className="confirm-actions">
                      <button className="btn" autoFocus onClick={() => setLeaving(undefined)}>
                        Keep editing
                      </button>
                      <button className="btn danger" onClick={leaving.go}>
                        Discard edit
                      </button>
                    </div>
                  </div>
                )}
                <div className="memory-actions">
                  <div className="confirm-actions">
                    <RestoreButton api={api} profile={profile} editing={editing} disabled={!!busy} onRestore={(content, when) =>
                        unlessDirty("Replace your unsaved edit with the earlier version? Nothing of your edit has been saved to Hermes.", () => {
                          setEditing({ ...editing, draft: content });
                          setNotice({ kind: "ok", text: `The version your save at ${clock(when)} replaced is in the editor. Save to put it back on Hermes; nothing has changed there yet.` });
                        })
                      }
                    />
                    <button className="btn" disabled={!connected || !!busy} onClick={() => void reload()} title="Read SKILL.md from Hermes again. An edit you're making is kept.">
                      <RefreshCw size={14} /> {busy === "reload" ? "Reloading…" : "Reload"}
                    </button>
                  </div>
                  <div className="confirm-actions">
                    <button className="btn" disabled={!!busy} onClick={() => unlessDirty("Discard your unsaved edit to this skill? Nothing of it has been saved to Hermes.", close)}>
                      Cancel
                    </button>
                    <button
                      className="btn primary"
                      disabled={!connected || !dirty || !!busy || skillProblems(editing.draft, declaredName(editing.base)).length > 0}
                      onClick={() => void save(false)}
                    >
                      {busy === "save" ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
                {notice && (
                  <div className={`memory-notice ${notice.kind}`} role={notice.kind === "ok" ? "status" : "alert"}>
                    {notice.kind === "ok" ? <Check size={14} /> : <AlertTriangle size={14} />}
                    <span>{notice.text}</span>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="skills-toolbar">
                  <label className="skills-search">
                    <Search size={14} />
                    <input type="search" className="profile-filter" aria-label="Search skills" placeholder="Search names, descriptions and categories" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </label>
                  <span className="muted small" aria-live="polite">
                    {query.trim() ? `${filtered.length} of ${view.skills.length}` : `${view.skills.length}`} {view.skills.length === 1 ? "skill" : "skills"}
                    {off > 0 && `, ${off} off`}
                  </span>
                  <button className="btn" disabled={!connected || loading || !!toggling} onClick={() => void load()} title="Read the skills from Hermes again.">
                    <RefreshCw size={14} /> {loading ? "Reloading…" : "Reload"}
                  </button>
                </div>
                {!view.platformsRead && (
                  <p className="muted small skills-note">
                    <AlertTriangle size={12} /> Couldn't read the profile's per-platform skill lists, or which skills they name, so a skill shown on may still be off in this app's chats.
                  </p>
                )}
                {rowNote?.name === "" && (
                  <div className="switch-status failed" role="alert">
                    {rowNote.text}
                  </div>
                )}
                {!view.skills.length ? (
                  <div className="memory-empty muted small">
                    This profile has no skills yet. The agent can write one during a chat. Installing skills from elsewhere isn't done from Hermes Chat.
                  </div>
                ) : !filtered.length ? (
                  <div className="memory-empty muted small">No skills match “{query.trim()}”.</div>
                ) : (
                  <ul className="toolset-list skills-list" aria-label="Skills">
                    {filtered.map((s) => {
                      const id = domId(s.name);
                      const essential = ESSENTIAL_SKILLS.has(s.name);
                      const offFor = Object.hasOwn(view.offFor, s.name) ? view.offFor[s.name] : undefined;
                      return (
                        <li key={s.name} className="toolset-row">
                          <div className="toolset-head">
                            <div className="toolset-label">
                              <div className="appearance-title">
                                <span id={`${id}-label`} className="mono">
                                  {s.name}
                                </span>
                                <span className="badge off">{sourceLabel(s.source)}</span>
                                {s.scope === "shared" && <span className="badge">Shared folder</span>}
                                {offFor && s.enabled && <span className="badge warn">Off in this app's chats</span>}
                              </div>
                              <div id={`${id}-desc`} className="muted small toolset-desc">
                                {s.description || "No description."}
                              </div>
                              {s.category && <div className="muted small">Category: {s.category}</div>}
                              {offFor && s.enabled && (
                                <div className="muted small toolset-hint">
                                  The profile's <span className="mono">skills.platform_disabled.{offFor.join("/")}</span> list keeps it off in the chats Hermes Chat
                                  starts. This switch doesn't change that list.
                                </div>
                              )}
                            </div>
                            <div className="skills-row-actions">
                              <button className="btn" id={`${id}-edit`} disabled={!!opening || !!toggling} aria-describedby={`${id}-label`} onClick={() => void open(s)}>
                                {opening === s.name ? "Opening…" : "Edit"}
                              </button>
                              {essential ? (
                                <span className="badge" title="Hermes keeps this skill on.">
                                  Always on
                                </span>
                              ) : (
                                <button
                                  className="switch"
                                  role="switch"
                                  aria-checked={s.enabled}
                                  aria-labelledby={`${id}-label`}
                                  aria-describedby={`${id}-desc`}
                                  disabled={!connected || !!toggling || !!opening}
                                  onClick={() => void toggle(s)}
                                >
                                  <span className="switch-knob" />
                                </button>
                              )}
                            </div>
                          </div>
                          {toggling === s.name && (
                            <div className="switch-status" role="status">
                              Turning {s.enabled ? "off" : "on"}…
                            </div>
                          )}
                          {rowNote?.name === s.name && (
                            <div className={`switch-status ${rowNote.kind === "failed" ? "failed" : ""}`} role={rowNote.kind === "failed" ? "alert" : "status"}>
                              {rowNote.text}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section>
        <h2>When changes take effect</h2>
        <p className="muted">
          {EDIT_EFFECT} Turning a skill off keeps it out of chats started from now on, and Hermes then refuses to load it in any chat, even one already
          going. Turning one on lists it in new chats; one already going can still load it by name. Nothing needs restarting or reloading.
        </p>
        <p className="muted small">
          The switch is the profile's <span className="mono">skills.disabled</span> list, which every platform follows. Edits you save here can be undone with
          Restore previous version until you sign out or close Hermes Chat; earlier versions aren't kept on the server or on this computer.
        </p>
      </section>
    </>
  );
}

/** Why the edit can't be saved yet: Hermes's own front matter rules, and the files the body names that aren't there. */
function SkillProblems({
  editing,
  refs,
  busy,
  connected,
  onSaveAnyway,
}: {
  editing: Editing;
  refs?: ReferenceCheck;
  busy: boolean;
  connected: boolean;
  onSaveAnyway: () => void;
}) {
  const problems = editing.draft !== editing.base.content ? skillProblems(editing.draft, declaredName(editing.base)) : [];
  if (!problems.length && !refs?.missing.length && !refs?.outside.length && !refs?.unchecked) return null;
  return (
    <div className="skills-problems" role="alert" aria-label="Fix before saving">
      {problems.length > 0 && (
        <>
          <div className="field-label">Fix before saving</div>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {!!refs?.outside.length && (
        <>
          <div className="field-label">Paths outside the skill's folder</div>
          <ul>
            {refs.outside.map((p) => (
              <li key={p}>
                <span className="mono">{p}</span> leads out of the skill's folder. A skill's files have to be inside it; remove the <span className="mono">..</span>{" "}
                from the path.
              </li>
            ))}
          </ul>
        </>
      )}
      {!!refs?.missing.length && (
        <>
          <div className="field-label">Files the skill names that aren't on the server</div>
          <ul>
            {refs.missing.map((p) => (
              <li key={p}>
                <span className="mono">{p}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            The agent would find nothing there. Fix the path, or add the file in <span className="mono">{editing.base.path.replace(/\/SKILL\.md$/, "/")}</span> on
            the server (Server files can upload it), then Save again.
          </p>
          {!refs.outside.length && !problems.length && (
            <button className="btn" disabled={busy || !connected} onClick={onSaveAnyway}>
              Save with missing files
            </button>
          )}
        </>
      )}
      {refs?.unchecked && <p className="muted small">{refs.unchecked}</p>}
    </div>
  );
}

/** Puts back the text a save from here replaced, for the owner to check and save. Only while this sign-in lasts. */
function RestoreButton({
  api,
  profile,
  editing,
  disabled,
  onRestore,
}: {
  api: SkillsApi;
  profile: string;
  editing: Editing;
  disabled: boolean;
  onRestore: (content: string, when: number) => void;
}) {
  const version = api.versionsOf(profile, editing.base.path).find((v) => v.content !== editing.draft);
  if (!version) return null;
  return (
    <button className="btn" disabled={disabled} onClick={() => onRestore(version.content, version.replacedAt)} title={`The text your save at ${clock(version.replacedAt)} replaced.`}>
      <History size={14} /> Restore previous version
    </button>
  );
}
