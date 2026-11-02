// Projects (GLOSSARY.md "Project", ADR 0007): the switcher under the profile's name, which narrows the chat list to one
// project's chats, and the project screen, where a project is renamed or deleted and its folders added and taken out.
// The project and its folders are Hermes's; which chats are in it is kept on this computer.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, FolderGit2, Folder, FolderKanban, GitBranch, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import type { Project, Worktree } from "../hermes/projects";
import { Spinner, composing, useReturnFocus } from "./bits";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const chatsText = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;

/** Unread chats: in the whole list, outside the project shown, and in each project. */
export type ProjectUnread = { all: number; hidden: number; of: (projectId: string) => number };

/**
 * The project the chat list shows, with a ▾ that opens the profile's projects, "All chats" first, and New project.
 * Opening it reads the projects from Hermes again. A dot on it shows Unread chats the list doesn't show, as the profile
 * switcher does for other profiles. Beside it, the shown project's settings.
 */
export function ProjectSwitcher({
  projects,
  selected,
  unread,
  loading,
  error,
  connected,
  onOpen,
  onSelect,
  onCreate,
  onManage,
}: {
  /** The projects that can be shown: archived ones are left out. */
  projects: Project[];
  selected?: Project;
  unread: ProjectUnread;
  loading: boolean;
  error?: string;
  connected: boolean;
  onOpen: () => void;
  onSelect: (id: string | undefined) => void;
  onCreate: (name: string) => Promise<unknown>;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const name = selected?.name ?? "All chats";
  const tip = [
    selected ? `Showing the chats in ${selected.name}` : "Showing every chat",
    unread.hidden > 0 && `${unread.hidden} unread ${unread.hidden === 1 ? "chat isn't" : "chats aren't"} shown`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="project-switch" ref={box}>
      <button className="project-btn" title={tip} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)}>
        <FolderKanban size={14} className="project-icon" />
        <span className="project-name">{name}</span>
        {unread.hidden > 0 && <span className="dot" aria-label="Unread chats not shown" />}
        <ChevronDown size={13} className="profile-chev" />
      </button>
      {selected && (
        <button className="icon-btn project-manage" title={`Project settings for ${selected.name}`} onClick={onManage}>
          <Settings2 size={14} />
        </button>
      )}
      {open && (
        <ProjectMenu
          projects={projects}
          selectedId={selected?.id}
          unread={unread}
          loading={loading}
          error={error}
          connected={connected}
          onPick={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onCreate={async (n) => {
            await onCreate(n);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function UnreadCount({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="profile-unread" aria-label={`${n} unread`}>
      <span className="dot" />
      {n}
    </span>
  );
}

/** The open project menu. Closing it puts focus back on the switcher. */
function ProjectMenu({
  projects,
  selectedId,
  unread,
  loading,
  error,
  connected,
  onPick,
  onCreate,
  onClose,
}: {
  projects: Project[];
  selectedId?: string;
  unread: ProjectUnread;
  loading: boolean;
  error?: string;
  connected: boolean;
  onPick: (id: string | undefined) => void;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string>();
  useReturnFocus();

  const create = () => {
    if (saving) return;
    setSaving(true);
    setCreateError(undefined);
    onCreate(name).catch((e) => {
      setCreateError(`Couldn't make the project: ${messageOf(e)}`);
      setSaving(false);
    });
  };

  const option = (id: string | undefined, label: string, n: number) => (
    <button
      key={id ?? ""}
      role="option"
      aria-selected={id === selectedId}
      autoFocus={id === selectedId && !naming}
      className={`profile-option ${id === selectedId ? "on" : ""}`}
      onClick={() => onPick(id)}
    >
      <span className="row-title">{label}</span>
      {id === selectedId ? <Check size={14} /> : <UnreadCount n={n} />}
    </button>
  );

  return (
    <div className="profile-menu project-menu" onKeyDown={(e) => e.key === "Escape" && !composing(e) && (naming ? setNaming(false) : onClose())}>
      <div className="profile-options" role="listbox" aria-label="Projects">
        {option(undefined, "All chats", unread.all)}
        {projects.map((p) => option(p.id, p.name, unread.of(p.id)))}
      </div>
      {!projects.length && !loading && !error && <div className="profile-hint">No projects in this profile yet.</div>}
      {loading && !projects.length && <div className="profile-hint">Loading projects…</div>}
      {error && <div className="profile-hint err">{error}</div>}
      {naming ? (
        <div className="project-new">
          <input
            className="profile-filter"
            aria-label="New project name"
            placeholder="Project name"
            autoFocus
            value={name}
            readOnly={saving}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !composing(e) && create()}
          />
          {saving && <Spinner />}
          {createError && <div className="profile-hint err" role="alert">{createError}</div>}
        </div>
      ) : (
        <button
          className="profile-option project-create"
          disabled={!connected}
          title={connected ? "Make a project in this profile, in every Hermes client" : "Connect to Hermes to make a project"}
          onClick={() => setNaming(true)}
        >
          <span className="row-title">
            <Plus size={13} /> New project…
          </span>
        </button>
      )}
    </div>
  );
}

/** What was found on the server for one of a project's folders: why it can't be opened, or its repository's worktrees. */
type FolderFacts = { problem?: string; worktrees: Worktree[] };

/** The worktree `path` is, if it is one, and the repository's own checkout. */
function gitOf(path: string, trees: Worktree[]) {
  return { tree: trees.find((t) => t.path === path), main: trees.find((t) => t.main) };
}

function GitNote({ path, facts }: { path: string; facts?: FolderFacts }) {
  if (!facts) return null;
  if (facts.problem) return <div className="folder-note err">{facts.problem}</div>;
  const { tree, main } = gitOf(path, facts.worktrees);
  if (!facts.worktrees.length) return null;
  if (!tree) return <div className="folder-note">Inside the git repository at {main?.path ?? facts.worktrees[0].path}</div>;
  const branch = tree.detached ? "detached HEAD" : (tree.branch ?? "no branch");
  return (
    <div className="folder-note">
      <GitBranch size={11} /> {branch} · {tree.main ? "the repository's main worktree" : `a worktree of ${main?.path ?? "a repository"}`}
    </div>
  );
}

/**
 * A project's own screen, over the chat pane like Settings: its name, its folders on the server, how many chats are in
 * it, and Delete. A folder is checked on the server before it is added, and each folder shows the connection it is on
 * and its path there. A folder in a git repository shows its branch, and the repository's other worktrees can be added
 * as folders. Nothing on the server is created: no folder, repository or worktree.
 */
export function ProjectScreen({
  project,
  profile,
  connection,
  connected,
  chats,
  unlisted,
  onRename,
  onDelete,
  onAddFolder,
  onRemoveFolder,
  readFolder,
  onClose,
}: {
  project: Project;
  profile: string;
  /** The connection the folders are on, as the owner typed it. */
  connection?: string;
  connected: boolean;
  /** The project's chats in the list now. */
  chats: number;
  /** The project's chats the list doesn't hold: older than it reaches, or archived or deleted elsewhere. */
  unlisted: number;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onAddFolder: (path: string) => Promise<unknown>;
  onRemoveFolder: (path: string) => Promise<unknown>;
  /** Reads what the server has at a folder; reads only. */
  readFolder: (path: string) => Promise<FolderFacts>;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [path, setPath] = useState("");
  const [folderError, setFolderError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [facts, setFacts] = useState<Record<string, FolderFacts>>({});

  // What the server has at each folder, read again when the folders change or the connection comes back.
  const folderKey = project.folders.map((f) => f.path).join("\n");
  useEffect(() => {
    if (!connected) return;
    let current = true;
    for (const { path: p } of project.folders)
      void readFolder(p).then(
        (f) => current && setFacts((all) => ({ ...all, [p]: f })),
        () => {},
      );
    return () => {
      current = false;
    };
  }, [folderKey, connected]);

  const run = async (what: string, fn: () => Promise<unknown>, onError = setError) => {
    setBusy(what);
    onError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      onError(messageOf(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const rename = async () => {
    if (name.trim() === project.name) return setRenaming(false);
    if (await run("rename", () => onRename(name))) setRenaming(false);
  };

  const addFolder = async (p: string) => {
    if (await run(`add ${p}`, () => onAddFolder(p), setFolderError)) setPath("");
  };

  // The worktrees of each repository the project's folders are in, that the project doesn't have yet.
  const inProject = new Set(project.folders.map((f) => f.path));
  const others = new Map<string, Worktree>();
  for (const f of project.folders)
    for (const t of facts[f.path]?.worktrees ?? []) if (!inProject.has(t.path)) others.set(t.path, t);

  const offline = connected ? undefined : "Connect to Hermes to change this project.";

  return (
    <div className="settings project-screen">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        {renaming ? (
          <div className="project-rename">
            <input
              className="row-rename"
              aria-label="Project name"
              autoFocus
              value={name}
              readOnly={busy === "rename"}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (composing(e)) return;
                if (e.key === "Enter") void rename();
                else if (e.key === "Escape") {
                  setName(project.name);
                  setRenaming(false);
                  setError(undefined);
                }
              }}
            />
            <button className="btn" disabled={busy === "rename"} onClick={() => void rename()}>
              {busy === "rename" ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <h1 className="project-title">
            <FolderKanban size={20} /> <span>{project.name}</span>
            <button
              className="icon-btn"
              title={offline ?? "Rename this project, in every Hermes client"}
              disabled={!connected}
              onClick={() => {
                setName(project.name);
                setRenaming(true);
              }}
            >
              <Pencil size={14} />
            </button>
          </h1>
        )}
        {error && (
          <p className="sign-in-error small" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          A project in the <span className="mono">{profile}</span> profile. Hermes keeps the project and its folders, so other Hermes clients
          show them too. Which chats are in it is kept on this computer.
        </p>

        <section>
          <h2>Folders</h2>
          <p className="muted">
            Folders on the server this project is about. Hermes Chat adds only folders that are already there, and taking one out of the
            project leaves it on the server.
          </p>
          {project.folders.length ? (
            <ul className="folder-list">
              {project.folders.map((f) => (
                <li key={f.path} className="folder-row">
                  {facts[f.path]?.worktrees.length ? <FolderGit2 size={16} className="folder-icon" /> : <Folder size={16} className="folder-icon" />}
                  <div className="folder-main">
                    <div className="folder-name">
                      {baseName(f.path)}
                      {f.primary && <span className="badge">Main folder</span>}
                    </div>
                    <div className="folder-where">
                      <span className="mono folder-conn" title="The connection this folder is on">
                        {connection ?? "Not connected"}
                      </span>
                      <span className="mono folder-path" title="The folder's path on the server">
                        {f.path}
                      </span>
                    </div>
                    <GitNote path={f.path} facts={facts[f.path]} />
                  </div>
                  <button
                    className="btn"
                    disabled={!connected || !!busy}
                    title={offline ?? "Take this folder out of the project. It stays on the server."}
                    aria-label={`Remove ${f.path} from the project`}
                    onClick={() => void run(`remove ${f.path}`, () => onRemoveFolder(f.path), setFolderError)}
                  >
                    <X size={14} /> Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-hint">No folders yet.</div>
          )}
          <div className="folder-add">
            <label className="field">
              <span className="field-label">Add a folder on the server</span>
              <input
                placeholder="/home/you/code/project"
                value={path}
                disabled={!connected}
                spellCheck={false}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !composing(e) && path.trim() && void addFolder(path)}
              />
            </label>
            <button className="btn" disabled={!connected || !path.trim() || !!busy} title={offline} onClick={() => void addFolder(path)}>
              <Plus size={14} /> {busy === `add ${path}` ? "Checking…" : "Add folder"}
            </button>
          </div>
          {folderError && (
            <div className="field-hint err" role="alert">
              {folderError}
            </div>
          )}
          {others.size > 0 && (
            <div className="worktrees">
              <h3>Other worktrees of these repositories</h3>
              <p className="muted small">These worktrees are already on the server. Adding one puts it in the project; nothing is created.</p>
              <ul className="folder-list">
                {[...others.values()].map((t) => (
                  <li key={t.path} className="folder-row">
                    <GitBranch size={15} className="folder-icon" />
                    <div className="folder-main">
                      <div className="folder-name">{t.detached ? "detached HEAD" : (t.branch ?? "no branch")}</div>
                      <div className="folder-where">
                        <span className="mono folder-conn">{connection}</span>
                        <span className="mono folder-path">{t.path}</span>
                      </div>
                    </div>
                    <button className="btn" disabled={!connected || !!busy} aria-label={`Add the worktree ${t.path}`} onClick={() => void addFolder(t.path)}>
                      <Plus size={14} /> Add
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section>
          <h2>Chats</h2>
          <p className="muted">
            {chats ? `${chatsText(chats)} in the list.` : "No chats in the list yet."} Put a chat in this project from its right-click menu; a
            chat started while the list shows this project is put in it too.
            {unlisted > 0 &&
              ` ${chatsText(unlisted)} in this project ${unlisted === 1 ? "isn't" : "aren't"} in the list: older than a month, or archived or deleted. Pull older history in Settings, or open the archived chats, to see them.`}
          </p>
        </section>

        <section>
          <h2>Delete project</h2>
          <div className="settings-row">
            <p className="muted">Deletes the project in every Hermes client. Its chats stay in Hermes, and its folders stay on the server.</p>
            {!confirmDelete ? (
              <button className="btn" disabled={!connected} title={offline} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} /> Delete project
              </button>
            ) : (
              <div className="confirm" onKeyDown={(e) => e.key === "Escape" && setConfirmDelete(false)}>
                <span>
                  Delete {project.name}? {chats + unlisted ? `Its ${chatsText(chats + unlisted)} stay in Hermes and in the list.` : ""} Nothing on the
                  server is deleted but the project.
                </span>
                <div className="confirm-actions">
                  <button className="btn" autoFocus onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  <button className="btn danger" disabled={busy === "delete"} onClick={() => void run("delete", onDelete)}>
                    {busy === "delete" ? "Deleting…" : "Delete project"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
