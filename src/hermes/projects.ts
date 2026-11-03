// Projects: named groups of chats and of folders on the server (GLOSSARY.md "Project", ADR 0007). The project itself,
// its name and its folders, is Hermes's own: the profile's `projects.db`, read and written with the legacy `projects.*`
// JSON-RPC on `/api/ws`, so the official desktop app and `hermes projects` see the same ones. Hermes doesn't record which
// chats belong to a project, so that, and which project the list shows, is kept on this computer (projectLinks.ts).
//
// Folders are only references. Nothing here creates, moves or deletes a folder, a repository or a worktree on the
// server: a folder is checked with a read-only directory listing before it is added, and a repository's worktrees are
// read with `git worktree list` (dashboard REST `GET /api/git/worktrees`), never added.
import { savedDefaults, type DefaultsDoc, type DefaultsDraft, type ProjectDefaults } from "./projectDefaults";
import type { ProjectLinks } from "./projectLinks";

/** One of a project's folders: a path on the server. `primary`: the folder Hermes names the project's main one. */
export type ProjectFolder = { path: string; primary: boolean };

/** A project as Hermes stores it. `archived`: archived in another Hermes client; this app lists it no more. */
export type Project = { id: string; name: string; folders: ProjectFolder[]; archived: boolean };

/** One of a git repository's worktrees as `git worktree list` reports it. `main`: the repository's own checkout. */
export type Worktree = { path: string; branch?: string; main: boolean; detached: boolean };

/** How the projects calls reach Hermes: a legacy JSON-RPC request, and a dashboard REST read. */
export type ProjectsIO = {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  get(pathAndQuery: string): Promise<unknown>;
};

/**
 * Hermes's projects for one profile. Every call names the profile, because each profile has its own `projects.db`.
 * Writes answer with the project, or the projects, as Hermes has them afterwards.
 */
export type ProjectsApi = {
  list(profile: string): Promise<Project[]>;
  create(profile: string, name: string): Promise<Project>;
  rename(profile: string, id: string, name: string): Promise<Project>;
  /** Deletes the project and its folder references, never its chats or the folders themselves. */
  delete(profile: string, id: string): Promise<Project[]>;
  addFolder(profile: string, id: string, path: string): Promise<Project>;
  removeFolder(profile: string, id: string, path: string): Promise<Project>;
  /** Resolves if `path` is a folder Hermes can open on the server; rejects saying why not. Reads only. */
  checkFolder(profile: string, path: string): Promise<void>;
  /** The worktrees of the git repository `path` is in; none when it isn't in one. Reads only. */
  worktrees(path: string): Promise<Worktree[]>;
};

/** The longest project name this app sends. Hermes sets no limit; a name this long is a mistake. */
export const PROJECT_NAME_MAX = 200;

// JSON-RPC codes the deployed `bf0203a` answers (`tui_gateway/methods_projects.py`): no such project, invalid
// argument. Older servers have no `projects.*` methods at all.
const NO_SUCH_METHOD = -32601;
const NO_PROJECT = 5062;
const BAD_ARGUMENT = 5063;

/** The project was deleted in another Hermes client meanwhile. */
export class ProjectGoneError extends Error {
  constructor() {
    super("This project isn't on the server any more: it was deleted in another Hermes client.");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const codeOf = (e: unknown) => (isObj(e) && typeof e.code === "number" ? e.code : undefined);
const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/** A projects call's failure as the owner reads it. */
function projectError(e: unknown): Error {
  const code = codeOf(e);
  if (code === NO_SUCH_METHOD) return new Error("This Hermes server has no projects. Update Hermes to use them.");
  if (code === NO_PROJECT) return new ProjectGoneError();
  if (code === BAD_ARGUMENT && e instanceof Error) return new Error(sentence(e.message));
  return e instanceof Error ? e : new Error(String(e));
}

function toFolder(v: unknown): ProjectFolder | undefined {
  if (!isObj(v) || typeof v.path !== "string" || !v.path) return undefined;
  return { path: v.path, primary: v.is_primary === true };
}

/** A project row as `Project.to_dict` sends it (`hermes_cli/projects_db.py`); undefined if it isn't one. */
export function toProject(v: unknown): Project | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") return undefined;
  const folders = Array.isArray(v.folders) ? v.folders.map(toFolder).filter((f): f is ProjectFolder => !!f) : [];
  return { id: v.id, name: v.name, folders, archived: v.archived === true };
}

function toProjects(v: unknown): Project[] {
  if (!isObj(v) || !Array.isArray(v.projects)) throw new Error("Hermes answered without a list of projects.");
  return v.projects.map(toProject).filter((p): p is Project => !!p);
}

function oneProject(v: unknown): Project {
  const p = isObj(v) ? toProject(v.project) : undefined;
  if (!p) throw new Error("Hermes answered without the project.");
  return p;
}

function toWorktree(v: unknown): Worktree | undefined {
  if (!isObj(v) || typeof v.path !== "string" || !v.path) return undefined;
  return {
    path: v.path,
    ...(typeof v.branch === "string" && v.branch && { branch: v.branch }),
    main: v.isMain === true,
    detached: v.detached === true,
  };
}

/** A project's name as the owner typed it, trimmed; throws saying what is wrong with it. */
export function projectName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Give the project a name.");
  if (name.length > PROJECT_NAME_MAX) throw new Error(`Keep the name under ${PROJECT_NAME_MAX} characters.`);
  return name;
}

/**
 * A folder path on the server as the owner typed it, tidied: one slash between parts, none at the end. Throws saying
 * what is wrong with it. It must be absolute: Hermes would read a relative path from its own home folder.
 */
export function remotePath(raw: string): string {
  const path = raw.trim();
  if (!path) throw new Error("Enter the folder's full path on the server.");
  if (!path.startsWith("/")) throw new Error("Enter the folder's full path on the server, starting with /.");
  if (/[\u0000-\u001f]/.test(path)) throw new Error("That path has characters a folder name can't have.");
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("Enter the path without . or .. in it.");
  return `/${parts.join("/")}`;
}

/** Why `GET /api/fs/list` couldn't list a folder (`_FS_LIST_ERRNO`, `hermes_cli/web_routers/files.py`). */
function folderProblem(path: string, error: string): string {
  if (error === "ENOENT") return `There's no folder at ${path} on the server.`;
  if (error === "ENOTDIR") return `${path} is a file on the server, not a folder.`;
  if (error === "EACCES") return `Hermes isn't allowed to open ${path} on the server.`;
  return `Hermes can't open ${path} on the server: ${error}.`;
}

/** The projects calls over `io` (the dashboard's `/api/ws` and REST, see the research doc "Projects"). */
export function projectsApi(io: ProjectsIO): ProjectsApi {
  const call = async (method: string, params: Record<string, unknown>) => {
    try {
      return await io.rpc(method, params);
    } catch (e) {
      throw projectError(e);
    }
  };
  return {
    list: async (profile) => toProjects(await call("projects.list", { profile })),
    create: async (profile, name) => oneProject(await call("projects.create", { profile, name: projectName(name) })),
    rename: async (profile, id, name) => oneProject(await call("projects.update", { profile, id, name: projectName(name) })),
    delete: async (profile, id) => toProjects(await call("projects.delete", { profile, id })),
    addFolder: async (profile, id, path) => oneProject(await call("projects.add_folder", { profile, id, path: remotePath(path) })),
    removeFolder: async (profile, id, path) => oneProject(await call("projects.remove_folder", { profile, id, path })),
    checkFolder: async (profile, raw) => {
      const path = remotePath(raw);
      const res = await io.get(`api/fs/list?${new URLSearchParams({ path, profile })}`);
      const error = isObj(res) ? res.error : "no answer";
      if (typeof error === "string" && error) throw new Error(folderProblem(path, error));
    },
    worktrees: async (path) => {
      const res = await io.get(`api/git/worktrees?${new URLSearchParams({ path })}`);
      const list = isObj(res) && Array.isArray(res.worktrees) ? res.worktrees : [];
      return list.map(toWorktree).filter((w): w is Worktree => !!w);
    },
  };
}

/**
 * What the project switcher and the project screen show, for one connection and profile. `projects`: as Hermes listed
 * them last, or as this computer saved them until Hermes is read. `loaded`: read from Hermes since this opened.
 * `selectedId`: the project the chat list shows, if any. `chats`: each project's chats, by project id. `defaults`: each
 * project's defaults for new chats, kept on this computer (projectDefaults.ts).
 */
export type ProjectsSnapshot = {
  profile: string;
  projects: Project[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  selectedId?: string;
  chats: Readonly<Record<string, readonly string[]>>;
  defaults: Readonly<Record<string, ProjectDefaults>>;
};

/**
 * One connection and profile's projects: Hermes's projects, and the chats this computer has in each. A new store is
 * made for each profile. It writes only its own scope, so an answer that lands after the profile changed is kept for
 * the profile it was for.
 */
export class ProjectsStore {
  private snap: ProjectsSnapshot;
  private listeners = new Set<() => void>();
  private reads = 0;
  /** The projects' defaults as last read (`readDefaults`). */
  private stored: Record<string, ProjectDefaults> = {};
  private defaultsReads = 0;
  // Project writes return whole snapshots. Keep them in order with list reads so an older reply cannot prune
  // associations created after that request, or restore a project that a later request deleted.
  private pending: Promise<unknown> = Promise.resolve();

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => {});
    return result;
  }

  constructor(
    private api: ProjectsApi,
    private links: ProjectLinks,
    /** Where this computer keeps the profile's links (projectLinks.ts `projectScope`). */
    readonly scope: string,
    readonly profile: string,
    /** Where this computer keeps the projects' defaults (projectDefaults.ts). */
    private defaults: DefaultsDoc = savedDefaults,
  ) {
    this.snap = { profile, loaded: false, loading: false, ...this.fromLinks() };
    void this.readDefaults();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  /** The project the chat list shows, while Hermes, or this computer, still has it. */
  selected(): Project | undefined {
    return this.snap.projects.find((p) => p.id === this.snap.selectedId);
  }

  /** The projects `chatId` is in, by id. */
  projectsOf(chatId: string): Set<string> {
    return new Set(Object.entries(this.snap.chats).flatMap(([id, chats]) => (chats.includes(chatId) ? [id] : [])));
  }

  /**
   * Reads the profile's projects from Hermes. A project deleted in another client goes, and with it which chats were
   * in it. A failed read keeps what was shown and says why.
   */
  load(): Promise<void> {
    const n = ++this.reads;
    this.set({ loading: true });
    return this.enqueue(async () => {
      try {
        const projects = await this.api.list(this.profile);
        if (n !== this.reads) return;
        this.links.remember(this.scope, projects);
        this.set({ loaded: true, loading: false, error: undefined, ...this.fromLinks() });
      } catch (e) {
        if (n !== this.reads) return;
        this.set({ loading: false, error: `Couldn't read the projects: ${(e as Error).message}` });
      }
    });
  }

  /** Shows only `id`'s chats in the list; undefined shows every chat. Kept on this computer. */
  select(id: string | undefined) {
    this.links.select(this.scope, id);
    this.set(this.fromLinks());
  }

  /** Makes a project in Hermes, then shows it. */
  create(name: string): Promise<Project> {
    return this.enqueue(async () => {
      const project = await this.api.create(this.profile, name);
      this.keep(project);
      this.select(project.id);
      return project;
    });
  }

  rename(id: string, name: string): Promise<Project> {
    return this.enqueue(() => this.write(id, () => this.api.rename(this.profile, id, name)));
  }

  /**
   * Deletes the project in Hermes. Its chats stay in Hermes, in the list, and its folders stay on the server; only the
   * project and which chats were in it go.
   */
  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const projects = await this.api.delete(this.profile, id);
        this.links.remember(this.scope, projects);
      } catch (e) {
        if (!(e instanceof ProjectGoneError)) throw e;
        this.links.forgetProject(this.scope, id);
      }
      this.forgetDefaults(id);
      this.set(this.fromLinks());
    });
  }

  /** Checks the folder is there on the server, then adds it to the project. Nothing on the server is created. */
  addFolder(id: string, path: string): Promise<Project> {
    return this.enqueue(async () => {
      await this.api.checkFolder(this.profile, path);
      return this.write(id, () => this.api.addFolder(this.profile, id, path));
    });
  }

  /** Takes the folder out of the project. The folder itself stays on the server. */
  removeFolder(id: string, path: string): Promise<Project> {
    return this.enqueue(() => this.write(id, () => this.api.removeFolder(this.profile, id, path)));
  }

  /** Puts `chatId` in project `id`, or takes it out. Kept on this computer; the chat itself doesn't change. */
  setChat(id: string, chatId: string, inProject: boolean) {
    this.links.setChat(this.scope, id, chatId, inProject);
    this.set(this.fromLinks());
  }

  /**
   * Saves project `id`'s defaults for new chats on this computer, over revision `base` (projectDefaults.ts
   * `DefaultsDoc.save`). Chats already started don't change.
   */
  async saveDefaults(id: string, base: number, draft: DefaultsDraft): Promise<ProjectDefaults> {
    try {
      return await this.defaults.save(this.scope, id, base, draft);
    } finally {
      // A conflict means another window or instance saved: show what it saved.
      await this.readDefaults();
    }
  }

  /**
   * Reads the projects' defaults again, as another window or instance may have saved them. Resolves once the
   * snapshot has them; a failed read keeps the ones shown.
   */
  readDefaults(): Promise<void> {
    return this.freshDefaults().then(
      () => {},
      () => {}, // Kept as they were.
    );
  }

  /**
   * The projects' defaults as the file holds them now, for a chat about to start: this read's own answer, whatever other
   * reads are under way. Rejects if the file can't be read, rather than answering what was read before.
   */
  async freshDefaults(): Promise<Readonly<Record<string, ProjectDefaults>>> {
    const n = ++this.defaultsReads;
    const stored = await this.defaults.read(this.scope);
    // Shown only if no newer read was asked for meanwhile; the caller gets this read's answer either way.
    if (n === this.defaultsReads) {
      this.stored = stored;
      this.set(this.fromLinks());
    }
    return stored;
  }

  /** Reads this computer's copies again, after another window changed them. */
  reread() {
    this.set(this.fromLinks());
    void this.readDefaults();
  }

  /** The chat was deleted, so it is in no project any more. */
  forgetChat(chatId: string) {
    this.links.forgetChat(this.scope, chatId);
    this.set(this.fromLinks());
  }

  /** A write to one project. If it was deleted elsewhere meanwhile, it goes from the list too. */
  private async write(id: string, run: () => Promise<Project>): Promise<Project> {
    try {
      const project = await run();
      this.keep(project);
      return project;
    } catch (e) {
      if (e instanceof ProjectGoneError) {
        this.links.forgetProject(this.scope, id);
        this.forgetDefaults(id);
        this.set(this.fromLinks());
      }
      throw e;
    }
  }

  /**
   * Forgets project `id`'s defaults, once Hermes has said it is gone: deleted here, or answering that it no longer
   * exists. A list that merely leaves it out could be older than a save, so it never decides this. Best effort: defaults
   * left behind are never shown or used.
   */
  private forgetDefaults(id: string) {
    void this.defaults.forget(this.scope, id).then(() => this.readDefaults(), () => {});
  }

  private keep(project: Project) {
    const known = this.snap.projects;
    const next = known.some((p) => p.id === project.id) ? known.map((p) => (p.id === project.id ? project : p)) : [...known, project];
    this.links.remember(this.scope, next);
    this.set(this.fromLinks());
  }

  private fromLinks(): Pick<ProjectsSnapshot, "projects" | "selectedId" | "chats" | "defaults"> {
    const { known, selected, chats } = this.links.read(this.scope);
    const ids = new Set(known.map((p) => p.id));
    const defaults = Object.fromEntries(Object.entries(this.stored).filter(([id]) => ids.has(id)));
    return { projects: known, selectedId: known.some((p) => p.id === selected && !p.archived) ? selected : undefined, chats, defaults };
  }

  private set(patch: Partial<ProjectsSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of [...this.listeners]) fn();
  }
}
