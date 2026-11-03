// The template library, opened from the composer (GLOSSARY.md "Template", ADR 0027): pick one by search and the
// keyboard, fill in its blanks while the whole message shows as it will go, and Insert it into the composer. Insert
// never sends. With a draft already there, the owner chooses to replace it or add after it; Cancel leaves it alone.
import { invoke } from "@tauri-apps/api/core";
import { FileText } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import {
  BODY_MAX,
  IMPORT_MAX_BYTES,
  TEMPLATES_MAX,
  exportFile,
  fieldsOf,
  freeName,
  insertInto,
  offeredHere,
  valueOf,
  problemOf,
  readImport,
  render,
  type Template,
} from "../hermes/templates";
import { useModal } from "./modal";

/** Where the composer is: the connection and profile's project scope, its projects, and the ones this chat is in. */
export type TemplateHere = { scope: string; projects: { id: string; name: string }[]; here: string[] };

type View = { kind: "list" } | { kind: "edit"; base?: Template } | { kind: "fill"; template: Template };
type Status = { text: string; error?: boolean };

const templatesNow = () => getUIPrefs().templates;
const NOT_KEPT = "This computer couldn't keep the change (its storage is full or refused it). It holds only until the app closes.";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Templates({
  here,
  draft,
  onInsert,
  onClose,
  returnTo,
}: {
  here: TemplateHere;
  /** The composer's text now. */
  draft: string;
  /** Puts this text in the composer, in place of the draft. */
  onInsert: (text: string) => void;
  onClose: () => void;
  returnTo: RefObject<HTMLElement | null>;
}) {
  const all = useSyncExternalStore(subscribe, templatesNow);
  const [view, setView] = useState<View>({ kind: "list" });
  const [status, setStatus] = useState<Status>();
  const [selId, setSelId] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();

  const save = (next: Template[], done: string) => setStatus(setUIPrefs({ templates: next }) ? { text: done } : { text: NOT_KEPT, error: true });
  const back = (s?: Status) => {
    setStatus(s);
    setView({ kind: "list" });
  };

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog tpl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          // The edit view asks before dropping changes; it handles Escape itself.
          if (e.key !== "Escape" || e.defaultPrevented || view.kind === "edit") return;
          e.preventDefault();
          if (view.kind === "fill") back();
          else onClose();
        }}
      >
        <h2 id={titleId} className="tpl-title">
          <FileText size={14} aria-hidden />
          {view.kind === "list" ? "Templates" : view.kind === "fill" ? view.template.name : view.base ? "Edit template" : "New template"}
        </h2>
        {view.kind === "list" && (
          <Library
            all={all}
            here={here}
            selId={selId}
            onSelect={setSelId}
            status={status}
            setStatus={setStatus}
            save={save}
            onUse={(template) => {
              setStatus(undefined);
              setView({ kind: "fill", template });
            }}
            onEdit={(base) => {
              setStatus(undefined);
              setView({ kind: "edit", base });
            }}
            onClose={onClose}
          />
        )}
        {view.kind === "edit" && (
          <Editor
            base={view.base}
            all={all}
            here={here}
            onSave={(edited) => {
              // The list as it is now: another window may have changed it since this one drew.
              const now = templatesNow();
              const stored = now.find((o) => o.id === edited.id);
              const exists = !!stored;
              // A project left as it was keeps what happened to it meanwhile, such as losing its scope when the
              // project was deleted (ADR 0027); only a project the owner picked here is written.
              const unchanged = edited.project?.scope === view.base?.project?.scope && edited.project?.id === view.base?.project?.id;
              const { project: _, ...rest } = edited;
              const t: Template = unchanged && stored ? { ...rest, ...(stored.project && { project: stored.project }) } : edited;
              if (!exists && now.length >= TEMPLATES_MAX) return `You have ${TEMPLATES_MAX} templates, the most kept. Delete one first; your text stays here.`;
              const why = problemOf(t, now.filter((o) => o.id !== t.id));
              if (why) return why;
              const kept = setUIPrefs({ templates: exists ? now.map((o) => (o.id === t.id ? t : o)) : [...now, t] });
              // Checked, not assumed: a template the prefs refused isn't there.
              if (!templatesNow().some((o) => o.id === t.id && o.name === t.name && o.body === t.body)) return "This template couldn't be kept. Your text stays here.";
              setSelId(t.id);
              back(kept ? { text: `Saved “${t.name}”.` } : { text: NOT_KEPT, error: true });
            }}
            onCancel={() => back()}
          />
        )}
        {view.kind === "fill" && (
          <Fill
            template={view.template}
            draft={draft}
            onInsert={(text) => {
              onInsert(text);
              onClose();
            }}
            onBack={() => back()}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}

function Library({
  all,
  here,
  selId,
  onSelect,
  status,
  setStatus,
  save,
  onUse,
  onEdit,
  onClose,
}: {
  all: Template[];
  here: TemplateHere;
  selId?: string;
  onSelect: (id: string | undefined) => void;
  status?: Status;
  setStatus: (s: Status | undefined) => void;
  save: (next: Template[], done: string) => void;
  onUse: (t: Template) => void;
  onEdit: (t?: Template) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [deleting, setDeleting] = useState<Template>();
  const file = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => search.current?.focus(), []);

  const offered = all.filter((t) => offeredHere(t, here.scope, here.here));
  const hidden = all.length - offered.length;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = (showAll ? all : offered)
    .filter((t) => {
      const hay = `${t.name}\n${t.description}\n${t.body}`.toLocaleLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const sel = shown.find((t) => t.id === selId) ?? shown[0];
  const optionId = (t: Template) => `${listId}-${t.id}`;
  useEffect(() => {
    if (sel) document.getElementById(optionId(sel))?.scrollIntoView?.({ block: "nearest" });
  }, [sel?.id]);

  const move = (by: number | "start" | "end") => {
    if (!shown.length) return;
    const i = sel ? shown.indexOf(sel) : -1;
    const to = by === "start" ? 0 : by === "end" ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, i + by));
    onSelect(shown[to].id);
    setDeleting(undefined);
  };

  const projectLabel = (t: Template) => {
    if (!t.project) return undefined;
    const known = t.project.scope === here.scope && here.projects.find((p) => p.id === t.project!.id);
    return known ? known.name : `${t.project.name} (not in this profile)`;
  };

  const duplicate = (t: Template) => {
    const all = templatesNow();
    if (all.length >= TEMPLATES_MAX) return setStatus({ text: `You have ${TEMPLATES_MAX} templates, the most kept. Delete one first.`, error: true });
    const copy: Template = { ...t, id: crypto.randomUUID(), name: freeName(t.name, all) };
    onSelect(copy.id);
    save([...all, copy], `Duplicated as “${copy.name}”.`);
  };

  const exportAll = async () => {
    try {
      const path = await invoke<string | null>("templates_export", { json: exportFile(all) });
      if (path) setStatus({ text: `Exported ${all.length} template${all.length === 1 ? "" : "s"} to ${path}. Projects aren't included.` });
    } catch (e) {
      setStatus({ text: `Couldn't export the templates: ${message(e)}`, error: true });
    }
  };

  const importFrom = async (f: File) => {
    try {
      if (f.size > IMPORT_MAX_BYTES) throw new Error("The file is too big to be a templates export.");
      const got = readImport(await f.text(), templatesNow());
      const notes = [
        got.added.length ? `Imported ${got.added.length} template${got.added.length === 1 ? "" : "s"}.` : "Imported nothing.",
        got.skipped && `Skipped ${got.skipped} that ${got.skipped === 1 ? "wasn't a valid template" : "weren't valid templates"}.`,
        got.overLimit && `Left out ${got.overLimit}: ${TEMPLATES_MAX} is the most kept.`,
        ...got.renamed.map((r) => `“${r.from}” was already taken, so it's “${r.to}”.`),
      ].filter(Boolean);
      if (!got.added.length) return setStatus({ text: notes.join(" "), error: true });
      save([...templatesNow(), ...got.added], notes.join(" "));
    } catch (e) {
      setStatus({ text: `Couldn't import ${f.name}: ${message(e)}`, error: true });
    }
  };

  return (
    <>
      <div className="tpl-tools">
        <input
          ref={search}
          className="tpl-search"
          type="search"
          placeholder="Search templates"
          aria-label="Search templates"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={sel ? optionId(sel) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDeleting(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") move(1);
            else if (e.key === "ArrowUp") move(-1);
            else if (e.key === "Home" && shown.length) move("start");
            else if (e.key === "End" && shown.length) move("end");
            else if (e.key === "Enter" && sel) onUse(sel);
            else return;
            e.preventDefault();
          }}
        />
        <button className="btn" onClick={() => onEdit()} disabled={all.length >= TEMPLATES_MAX}>
          New
        </button>
        <button className="btn" onClick={() => file.current?.click()}>
          Import…
        </button>
        <button className="btn" onClick={() => void exportAll()} disabled={!all.length}>
          Export…
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFrom(f);
          }}
        />
      </div>
      <div id={listId} role="listbox" aria-label="Templates" className="tpl-list">
        {shown.map((t) => (
          <div
            key={t.id}
            id={optionId(t)}
            role="option"
            aria-selected={t === sel}
            className={`tpl-option ${t === sel ? "sel" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (t === sel ? onUse(t) : onSelect(t.id))}
            onDoubleClick={() => onUse(t)}
          >
            <span className="tpl-name">{t.name}</span>
            {projectLabel(t) && <span className="tpl-project">{projectLabel(t)}</span>}
            {t.description && <span className="tpl-desc">{t.description}</span>}
          </div>
        ))}
        {!shown.length && (
          <p className="tpl-empty">
            {all.length ? (
              "No template matches."
            ) : (
              <>
                No templates yet. <strong>New</strong> makes one: write the message, with a blank like <code>{"{host}"}</code> wherever it changes.
              </>
            )}
          </p>
        )}
      </div>
      {hidden > 0 && (
        <label className="tpl-check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show {hidden} for other projects
        </label>
      )}
      {status && (
        <p className={`tpl-status ${status.error ? "err" : ""}`} role={status.error ? "alert" : "status"}>
          {status.text}
        </p>
      )}
      {deleting ? (
        <div className="confirm-actions tpl-foot">
          <span className="tpl-ask">Delete “{deleting.name}”? This can't be undone.</span>
          <button className="btn" onClick={() => setDeleting(undefined)} autoFocus>
            Keep
          </button>
          <button
            className="btn danger"
            onClick={() => {
              setDeleting(undefined);
              save(
                templatesNow().filter((t) => t.id !== deleting.id),
                `Deleted “${deleting.name}”.`,
              );
              search.current?.focus();
            }}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="confirm-actions tpl-foot">
          <span className="tpl-keys">↑ ↓ to pick · Enter to use · Esc to close</span>
          <button className="btn" disabled={!sel} onClick={() => sel && onEdit(sel)}>
            Edit
          </button>
          <button className="btn" disabled={!sel} onClick={() => sel && duplicate(sel)}>
            Duplicate
          </button>
          <button className="btn" disabled={!sel} onClick={() => setDeleting(sel)}>
            Delete
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!sel} onClick={() => sel && onUse(sel)}>
            Use
          </button>
        </div>
      )}
    </>
  );
}

const FORMAT_HELP: [string, string][] = [
  ["{name}", "a blank you must fill in"],
  ["{name?}", "optional: left blank, it becomes nothing"],
  ["{name=default}", "optional, with a default value"],
  ["{name...}", "takes several lines; combines: {name...?}"],
  ["\\{", "a literal {, so \\{name} stays {name}"],
];

/** `onSave` answers why it couldn't keep the template, if it couldn't; the editor then stays open with the text. */
function Editor({
  base,
  all,
  here,
  onSave,
  onCancel,
}: {
  base?: Template;
  all: Template[];
  here: TemplateHere;
  onSave: (t: Template) => string | undefined | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(base?.name ?? "");
  const [description, setDescription] = useState(base?.description ?? "");
  const [body, setBody] = useState(base?.body ?? "");
  const [project, setProject] = useState(base?.project);
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), desc: useId(), project: useId(), body: useId(), help: useId() };
  useEffect(() => first.current?.focus(), []);
  const dirty = name !== (base?.name ?? "") || description !== (base?.description ?? "") || body !== (base?.body ?? "") || project?.id !== base?.project?.id;
  const leave = () => (dirty ? setAsking(true) : onCancel());
  const fields = fieldsOf(body);
  // A project from another profile, or one deleted since, stays a choice until the owner changes it.
  const elsewhere = project && !(project.scope === here.scope && here.projects.some((p) => p.id === project.id)) ? project : undefined;

  const submit = () => {
    const t = { name, description, body };
    const why = problemOf(t, all.filter((o) => o.id !== base?.id));
    if (why) return setProblem(why);
    setProblem(onSave({ id: base?.id ?? crypto.randomUUID(), name: name.trim(), description: description.trim(), body, ...(project && { project }) }) || undefined);
  };

  return (
    <form
      className="tpl-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (asking) setAsking(false);
          else leave();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor={ids.name}>
          Name
        </label>
        <input id={ids.name} ref={first} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.desc}>
          Description (optional)
        </label>
        <input id={ids.desc} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.project}>
          Offered in
        </label>
        <select
          id={ids.project}
          value={project ? project.id : ""}
          onChange={(e) => {
            const p = here.projects.find((x) => x.id === e.target.value);
            setProject(p ? { scope: here.scope, id: p.id, name: p.name } : e.target.value && elsewhere ? elsewhere : undefined);
          }}
        >
          <option value="">Every chat</option>
          {here.projects.map((p) => (
            <option key={p.id} value={p.id}>
              Only the project {p.name}
            </option>
          ))}
          {elsewhere && <option value={elsewhere.id}>Only the project {elsewhere.name} (not in this profile)</option>}
        </select>
      </div>
      <div className="field tpl-body-field">
        <label className="field-label" htmlFor={ids.body}>
          Message
        </label>
        <textarea id={ids.body} className="tpl-body" value={body} maxLength={BODY_MAX} aria-describedby={ids.help} onChange={(e) => setBody(e.target.value)} />
        <div id={ids.help} className="field-hint block">
          {fields.length ? (
            <>
              Blanks: {fields.map((f, i) => (
                <span key={f.name}>
                  {i > 0 && ", "}
                  <code>{f.name}</code> {f.required ? "(required)" : f.default ? `(default “${f.default}”)` : "(optional)"}
                  {f.multiline && " multiline"}
                </span>
              ))}
            </>
          ) : (
            "No blanks: it inserts as written."
          )}
        </div>
        <details className="tpl-help">
          <summary>Blank format</summary>
          <dl>
            {FORMAT_HELP.map(([code, what]) => (
              <div key={code}>
                <dt>
                  <code>{code}</code>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p>Names are letters, digits, _ and -. Any other brace stays as written, so JSON and {"{{ jinja }}"} need nothing.</p>
        </details>
      </div>
      {problem && (
        <p className="tpl-status err" role="alert">
          {problem}
        </p>
      )}
      {asking ? (
        <div className="confirm-actions tpl-foot">
          <span className="tpl-ask">Discard your changes to this template?</span>
          <button type="button" className="btn" onClick={() => setAsking(false)} autoFocus>
            Keep editing
          </button>
          <button type="button" className="btn danger" onClick={onCancel}>
            Discard
          </button>
        </div>
      ) : (
        <div className="confirm-actions tpl-foot">
          <span className="tpl-keys">Ctrl+Enter to save</span>
          <button type="button" className="btn" onClick={leave}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      )}
    </form>
  );
}

function Fill({
  template,
  draft,
  onInsert,
  onBack,
  onCancel,
}: {
  template: Template;
  draft: string;
  onInsert: (text: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const fields = fieldsOf(template.body);
  const [values, setValues] = useState<Record<string, string>>({});
  const first = useRef<HTMLElement | null>(null);
  const insertRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  useEffect(() => (first.current ?? insertRef.current)?.focus(), []);
  const out = render(template.body, values);
  const hasDraft = !!draft.trim();
  const ready = !out.missing.length;
  const insert = (how: "replace" | "append") => ready && onInsert(insertInto(draft, out.text, how));

  return (
    <form
      className="tpl-form"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !hasDraft) {
          e.preventDefault();
          insert("replace");
        }
      }}
    >
      {template.description && <p className="tpl-desc">{template.description}</p>}
      {fields.length > 0 && (
        <div className="tpl-fields">
          {fields.map((f, i) => {
            const id = `${baseId}-${i}`;
            const common = {
              id,
              ref: i === 0 ? (el: HTMLElement | null) => void (first.current = el) : undefined,
              value: valueOf(values, f.name) ?? "",
              placeholder: f.default,
              "aria-required": f.required,
              onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f.name]: e.target.value })),
            };
            return (
              <div className="field" key={f.name}>
                <label className="field-label" htmlFor={id}>
                  <code>{f.name}</code>
                  <span className="tpl-tag">{f.required ? "required" : f.default ? `default “${f.default}”` : "optional"}</span>
                </label>
                {f.multiline ? (
                  <textarea {...common} rows={4} />
                ) : (
                  <input {...common} />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="field">
        <span className="field-label" id={`${baseId}-preview`}>
          Message preview: exactly what goes in the composer
        </span>
        <pre className="tpl-preview" aria-labelledby={`${baseId}-preview`} tabIndex={0}>
          {out.segments.map((s, i) =>
            s.field === undefined ? (
              s.text
            ) : (
              <mark key={i} className={s.missing ? "missing" : undefined} title={s.missing ? `${s.field}: still to fill in` : s.field}>
                {s.text}
              </mark>
            ),
          )}
        </pre>
      </div>
      {!ready && (
        <p className="tpl-status" role="status">
          Fill in {out.missing.map((m, i) => <span key={m}>{i > 0 && ", "}<code>{m}</code></span>)} to insert.
        </p>
      )}
      {hasDraft && <p className="tpl-ask">The composer already has a draft. Replace it, or add this after it?</p>}
      <div className="confirm-actions tpl-foot">
        <span className="tpl-keys">{hasDraft ? "Inserting never sends" : "Ctrl+Enter to insert · inserting never sends"}</span>
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {hasDraft ? (
          <>
            <button type="button" className="btn" disabled={!ready} onClick={() => insert("replace")}>
              Replace draft
            </button>
            <button type="button" ref={insertRef} className="btn primary" disabled={!ready} onClick={() => insert("append")}>
              Add after draft
            </button>
          </>
        ) : (
          <button type="button" ref={insertRef} className="btn primary" disabled={!ready} onClick={() => insert("replace")}>
            Insert
          </button>
        )}
      </div>
    </form>
  );
}
