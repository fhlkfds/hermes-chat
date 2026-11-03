// @vitest-environment jsdom
// Projects against a fake Hermes that answers `projects.*`, `GET /api/fs/list` and `GET /api/git/worktrees` the way the
// deployed `bf0203a` did when probed with a throwaway HERMES_HOME (research doc "Projects").
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { ProjectGoneError, ProjectsStore, projectName, remotePath } from "./projects";
import { PROJECTS_KEY, PROJECTS_VERSION, projectLinks, projectScope, readLinks, type LinksStorage } from "./projectLinks";
import { localChatCache } from "./chatCache";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const CONNECTION = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const SCOPE = projectScope(CONNECTION, "default");

/** A server with two chats, a repository with one extra worktree, and a plain folder. */
function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  s.otherProfiles = { work: [] };
  s.serverDirs = new Set(["/srv", "/srv/app", "/srv/app-feature", "/srv/notes"]);
  s.serverFiles = { "/srv/notes/todo.md": "" };
  s.repos = [[{ path: "/srv/app", branch: "main" }, { path: "/srv/app-feature", branch: "feature/login" }]];
  return s;
}

/** A map-backed storage that can be told to refuse writes, as a full localStorage does. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const st = {
    full: false,
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (st.full) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
  return st satisfies LinksStorage;
}

async function setUp(s = server(), storage: LinksStorage = memoryStorage(), profile = "default") {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  const store = new ProjectsStore(hermes.projects, projectLinks(storage), projectScope(CONNECTION, profile), profile);
  return { s, hermes, store, storage };
}

const sent = (s: FakeHermes, method: string) => s.requests.filter((r) => r.method === method).map((r) => r.params);

describe("Hermes's projects", () => {
  it("lists the profile's projects, naming the profile", async () => {
    const s = server();
    s.projects.default = [{ id: "p_1", slug: "budget", name: "Budget", primary_path: "/srv/app", archived: false, created_at: 1, folders: [{ path: "/srv/app", label: null, is_primary: true, added_at: 1 }] }];
    const { store } = await setUp(s);
    await store.load();
    expect(sent(s, "projects.list")).toEqual([{ profile: "default" }]);
    expect(store.getSnapshot()).toMatchObject({ loaded: true, error: undefined, projects: [{ id: "p_1", name: "Budget", folders: [{ path: "/srv/app", primary: true }], archived: false }] });
  });

  it("creates, renames and deletes a project in Hermes, and shows the new one", async () => {
    const { s, store } = await setUp();
    const p = await store.create("  Home lab  ");
    expect(sent(s, "projects.create")).toEqual([{ profile: "default", name: "Home lab" }]);
    expect(store.getSnapshot().selectedId).toBe(p.id);
    await store.rename(p.id, "Homelab");
    expect(sent(s, "projects.update")).toEqual([{ profile: "default", id: p.id, name: "Homelab" }]);
    expect(s.projects.default[0].name).toBe("Homelab");
    expect(store.getSnapshot().projects.map((q) => q.name)).toEqual(["Homelab"]);
    await store.delete(p.id);
    expect(s.projects.default).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({ projects: [], selectedId: undefined });
  });

  it("refuses an empty name before sending anything, and says why Hermes refused one", async () => {
    const { s, store } = await setUp();
    await expect(store.create("   ")).rejects.toThrow("Give the project a name.");
    expect(sent(s, "projects.create")).toEqual([]);
    const p = await store.create("Lab");
    s.handlers["projects.update"] = (r) => s.fail(r.id, 5063, "project name must not be empty");
    await expect(store.rename(p.id, "x")).rejects.toThrow("Project name must not be empty.");
    expect(store.getSnapshot().projects[0].name).toBe("Lab");
  });

  it("keeps a project's chats and their folders when the project is deleted", async () => {
    const { s, hermes, store } = await setUp();
    await store.load();
    const p = await store.create("Lab");
    await store.addFolder(p.id, "/srv/app");
    store.setChat(p.id, "backup", true);
    const restBefore = s.restRequests.length;
    await store.delete(p.id);
    // Nothing but the project went: no session was edited or deleted, and the folder is still listed.
    expect(s.restRequests.slice(restBefore).filter((r) => r.method !== "GET")).toEqual([]);
    expect(sent(s, "projects.delete")).toEqual([{ profile: "default", id: p.id }]);
    expect(s.sessions.map((r) => r.id)).toEqual(["backup", "nas"]);
    expect(s.serverDirs.has("/srv/app")).toBe(true);
    await hermes.sync();
    expect(hermes.getSnapshot().chats.map((c) => c.id).sort()).toEqual(["backup", "nas"]);
    expect(store.getSnapshot().chats).toEqual({});
  });

  it("says so when the server has no projects", async () => {
    const s = server();
    s.handlers["projects.list"] = (r) => s.fail(r.id, -32601, "unknown method: projects.list");
    const { store } = await setUp(s);
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ loaded: false, error: "Couldn't read the projects: This Hermes server has no projects. Update Hermes to use them." });
  });

  it("keeps what it showed when a read fails, and an older read can't overwrite a newer one", async () => {
    const s = server();
    const { store, hermes } = await setUp(s);
    const p = await store.create("Lab");
    s.handlers["projects.list"] = (r) => s.fail(r.id, 5061, "database is locked");
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ error: "Couldn't read the projects: database is locked", projects: [{ id: p.id }] });

    // Reads are serialized; a superseded read with an old list cannot prune the cached associations.
    store.setChat(p.id, "nas", true);
    const answers: (() => void)[] = [];
    s.handlers["projects.list"] = (r) => {
      const list = answers.length ? structuredClone(s.projects.default) : [];
      answers.push(() => s.respond(r.id, { projects: list, active_id: null }));
    };
    const first = store.load();
    const second = store.load();
    await hermes.idle();
    answers[0]();
    await first;
    await expect.poll(() => answers.length).toBe(2);
    answers[1]();
    await second;
    expect(store.getSnapshot()).toMatchObject({ loaded: true, error: undefined, projects: [{ id: p.id }] });
    expect(store.getSnapshot().chats).toEqual({ [p.id]: ["nas"] });
  });

  it("keeps a stale list reply from erasing a newly created project's chat links", async () => {
    const { s, store, hermes, storage } = await setUp();
    let answer!: () => void;
    s.handlers["projects.list"] = (r) => { answer = () => s.respond(r.id, { projects: [], active_id: null }); };
    const loading = store.load();
    await hermes.idle();
    const creating = store.create("New lab");
    await hermes.idle();
    expect(sent(s, "projects.create")).toEqual([]);
    answer();
    await loading;
    const p = await creating;
    store.setChat(p.id, "nas", true);
    expect(projectLinks(storage).read(SCOPE)).toMatchObject({ selected: p.id, chats: { [p.id]: ["nas"] } });
  });

  it("keeps each profile's projects apart", async () => {
    const s = server();
    s.projects.work = [{ id: "p_w", slug: "w", name: "Work thing", primary_path: null, archived: false, created_at: 1, folders: [] }];
    const storage = memoryStorage();
    const { store, hermes } = await setUp(s, storage);
    const work = new ProjectsStore(hermes.projects, projectLinks(storage), projectScope(CONNECTION, "work"), "work");
    await store.load();
    await work.load();
    expect(sent(s, "projects.list")).toEqual([{ profile: "default" }, { profile: "work" }]);
    expect(store.getSnapshot().projects).toEqual([]);
    expect(work.getSnapshot().projects.map((p) => p.name)).toEqual(["Work thing"]);
  });

  it("reads again what another window stored", async () => {
    const storage = memoryStorage();
    const links = projectLinks(storage);
    expect(links.read(SCOPE).chats).toEqual({});
    projectLinks(storage).setChat(SCOPE, "p_1", "nas", true);
    expect(links.read(SCOPE).chats).toEqual({ p_1: ["nas"] });
  });
});

describe("folders", () => {
  it("adds a folder only after checking it is there on the server", async () => {
    const { s, store } = await setUp();
    const p = await store.create("App");
    await store.addFolder(p.id, "/srv/app/");
    expect(s.restRequests.find((r) => r.path === "/api/fs/list")?.query.get("path")).toBe("/srv/app");
    expect(sent(s, "projects.add_folder")).toEqual([{ profile: "default", id: p.id, path: "/srv/app" }]);
    expect(store.getSnapshot().projects[0].folders).toEqual([{ path: "/srv/app", primary: true }]);
  });

  it("refuses a folder that isn't there, a file, or a relative path, without adding anything", async () => {
    const { s, store } = await setUp();
    const p = await store.create("App");
    await expect(store.addFolder(p.id, "/srv/gone")).rejects.toThrow("There's no folder at /srv/gone on the server.");
    await expect(store.addFolder(p.id, "/srv/notes/todo.md")).rejects.toThrow("/srv/notes/todo.md is a file on the server, not a folder.");
    await expect(store.addFolder(p.id, "code/app")).rejects.toThrow("starting with /");
    await expect(store.addFolder(p.id, "/srv/../etc")).rejects.toThrow("without . or ..");
    expect(sent(s, "projects.add_folder")).toEqual([]);
    expect(s.projects.default[0].folders).toEqual([]);
  });

  it("removes a folder reference, and the folder stays on the server", async () => {
    const { s, store } = await setUp();
    const p = await store.create("App");
    await store.addFolder(p.id, "/srv/app");
    await store.addFolder(p.id, "/srv/notes");
    await store.removeFolder(p.id, "/srv/app");
    expect(store.getSnapshot().projects[0].folders).toEqual([{ path: "/srv/notes", primary: true }]);
    expect(s.serverDirs.has("/srv/app")).toBe(true);
  });

  it("lists a repository's existing worktrees, and never asks for one to be made", async () => {
    const { s, hermes } = await setUp();
    expect(await hermes.projects.worktrees("/srv/app-feature")).toEqual([
      { path: "/srv/app", branch: "main", main: true, detached: false },
      { path: "/srv/app-feature", branch: "feature/login", main: false, detached: false },
    ]);
    expect(await hermes.projects.worktrees("/srv/notes")).toEqual([]);
    expect(s.restRequests.every((r) => r.method === "GET" && !/worktree\/add|fs\/mkdir/.test(r.path))).toBe(true);
  });
});

describe("templates offered only in a project", () => {
  const tpl = (name: string, project?: { scope: string; id: string }) => ({ id: name, name, description: "", body: "x", ...(project && { project: { ...project, name: "P" } }) });

  it("are kept when the project is deleted here, then offered in every chat; other projects' stay theirs", async () => {
    const { store } = await setUp();
    const lab = await store.create("Lab");
    const ops = await store.create("Ops");
    const work = projectScope(CONNECTION, "work");
    setUIPrefs({ templates: [tpl("A", { scope: SCOPE, id: lab.id }), tpl("B", { scope: SCOPE, id: ops.id }), tpl("C", { scope: work, id: lab.id }), tpl("D")] });
    await store.delete(lab.id);
    expect(getUIPrefs().templates).toEqual([tpl("A"), tpl("B", { scope: SCOPE, id: ops.id }), tpl("C", { scope: work, id: lab.id }), tpl("D")]);
  });

  it("are kept when a write finds the project deleted in another client", async () => {
    const { s, store } = await setUp();
    const p = await store.create("Lab");
    setUIPrefs({ templates: [tpl("A", { scope: SCOPE, id: p.id })] });
    s.projects.default = [];
    await expect(store.rename(p.id, "Lab 2")).rejects.toBeInstanceOf(ProjectGoneError);
    expect(getUIPrefs().templates).toEqual([tpl("A")]);
  });
});

describe("a project deleted in another Hermes client", () => {
  it("goes from the list at the next read, with which chats were in it", async () => {
    const { s, store } = await setUp();
    const p = await store.create("Lab");
    store.setChat(p.id, "nas", true);
    s.projects.default = [];
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ projects: [], selectedId: undefined, chats: {} });
  });

  it("goes as soon as a write finds it missing", async () => {
    const { s, store } = await setUp();
    const p = await store.create("Lab");
    s.projects.default = [];
    await expect(store.rename(p.id, "Lab 2")).rejects.toBeInstanceOf(ProjectGoneError);
    expect(store.getSnapshot().projects).toEqual([]);
  });
});

describe("which chats are in a project", () => {
  it("is kept on this computer only, per connection and profile", async () => {
    const storage = memoryStorage();
    const { s, store } = await setUp(server(), storage);
    const p = await store.create("Lab");
    store.setChat(p.id, "backup", true);
    store.setChat(p.id, "nas", true);
    store.setChat(p.id, "backup", false);
    expect(store.getSnapshot().chats).toEqual({ [p.id]: ["nas"] });
    expect(store.projectsOf("nas")).toEqual(new Set([p.id]));
    // Hermes heard nothing about it.
    expect(s.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(s.requests.map((r) => r.method).filter((m) => m.startsWith("projects.") && m !== "projects.create")).toEqual([]);
    // The other profile keeps its own.
    expect(projectLinks(storage).read(projectScope(CONNECTION, "work")).chats).toEqual({});
  });

  it("survives a restart and Clear local cache", async () => {
    const storage = memoryStorage();
    const { store } = await setUp(server(), storage);
    const p = await store.create("Lab");
    store.setChat(p.id, "nas", true);
    // Clear local cache works on the real localStorage; put the document there too.
    localStorage.setItem(PROJECTS_KEY, storage.data.get(PROJECTS_KEY)!);
    localChatCache(CONNECTION).clear();
    expect(localStorage.getItem(PROJECTS_KEY)).toBe(storage.data.get(PROJECTS_KEY));
    const again = projectLinks(memoryStorage({ [PROJECTS_KEY]: localStorage.getItem(PROJECTS_KEY)! })).read(SCOPE);
    expect(again).toMatchObject({ selected: p.id, chats: { [p.id]: ["nas"] }, known: [{ id: p.id, name: "Lab" }] });
  });

  it("keeps every folder's primary flag across a fresh storage reader", async () => {
    const storage = memoryStorage();
    const { store } = await setUp(server(), storage);
    const p = await store.create("Lab");
    await store.addFolder(p.id, "/srv/app");
    await store.addFolder(p.id, "/srv/notes");
    const fresh = projectLinks(storage).read(SCOPE);
    expect(fresh.known).toEqual(store.getSnapshot().projects);
    expect(fresh.known[0].folders).toEqual([{ path: "/srv/app", primary: true }, { path: "/srv/notes", primary: false }]);
  });

  it("forgets a deleted chat", async () => {
    const { store } = await setUp();
    const p = await store.create("Lab");
    store.setChat(p.id, "nas", true);
    store.forgetChat("nas");
    expect(store.getSnapshot().chats).toEqual({});
  });

  it("is held in memory when the storage is full", async () => {
    const storage = memoryStorage();
    const { store } = await setUp(server(), storage);
    const p = await store.create("Lab");
    storage.full = true;
    store.setChat(p.id, "nas", true);
    expect(store.getSnapshot().chats).toEqual({ [p.id]: ["nas"] });
  });
});

describe("the stored document", () => {
  const stored = (doc: unknown) => memoryStorage({ [PROJECTS_KEY]: JSON.stringify(doc) });
  const project = { id: "p_1", slug: "lab", name: "Lab", archived: false, created_at: 1, folders: [] };

  it("is written with its version", async () => {
    const storage = memoryStorage();
    const links = projectLinks(storage);
    links.setChat(SCOPE, "p_1", "nas", true);
    expect(JSON.parse(storage.data.get(PROJECTS_KEY)!)).toEqual({ v: PROJECTS_VERSION, scopes: { [SCOPE]: { chats: { p_1: ["nas"] }, known: [] } } });
  });

  it("reads a document written without a version as version 1", () => {
    expect(projectLinks(stored({ scopes: { [SCOPE]: { selected: "p_1", chats: { p_1: ["nas"] }, known: [project] } } })).read(SCOPE)).toMatchObject({
      selected: "p_1",
      chats: { p_1: ["nas"] },
      known: [{ id: "p_1", name: "Lab" }],
    });
  });

  it("reads what it knows of a newer document, and keeps the rest when writing", () => {
    const otherScope = { selected: "p_other", chats: { p_other: ["chat"] }, known: [], colour: "blue" };
    const storage = stored({ v: 7, later: { x: 1 }, scopes: { [SCOPE]: { selected: "p_1", chats: { p_1: ["nas", 3, "nas"] }, known: [project, { id: 5 }], colour: "red" }, other: otherScope } });
    const links = projectLinks(storage);
    expect(links.read(SCOPE)).toEqual({ selected: "p_1", chats: { p_1: ["nas"] }, known: [{ id: "p_1", name: "Lab", folders: [], archived: false }] });
    links.setChat(SCOPE, "p_1", "backup", true);
    const doc = JSON.parse(storage.data.get(PROJECTS_KEY)!);
    expect(doc).toMatchObject({ v: 7, later: { x: 1 }, scopes: { [SCOPE]: { colour: "red" }, other: otherScope } });
    expect(doc.scopes[SCOPE].chats).toEqual({ p_1: ["backup", "nas"] });
    links.select(SCOPE, undefined);
    const allChats = JSON.parse(storage.data.get(PROJECTS_KEY)!);
    expect(allChats.scopes[SCOPE].selected).toBeUndefined();
    expect(allChats.scopes[SCOPE].colour).toBe("red");
    links.forgetProject(SCOPE, "p_1");
    expect(JSON.parse(storage.data.get(PROJECTS_KEY)!).scopes[SCOPE].colour).toBe("red");
  });

  it("starts empty from anything it can't read", () => {
    for (const raw of ["{not json", "[]", "null", '"x"', JSON.stringify({ v: "two", scopes: { [SCOPE]: { chats: { p: ["a"] } } } })])
      expect(projectLinks(memoryStorage({ [PROJECTS_KEY]: raw })).read(SCOPE)).toEqual({ chats: {}, known: [] });
    expect(readLinks({ v: 1, scopes: { [SCOPE]: "nope", other: { chats: "x", known: "y" } } })).toEqual({ other: { chats: {}, known: [] } });
  });
});

describe("what the owner types", () => {
  it("tidies a folder path", () => {
    expect(remotePath("  /srv//app/  ")).toBe("/srv/app");
    expect(remotePath("/")).toBe("/");
    expect(() => remotePath("")).toThrow("full path");
    expect(() => remotePath("~/code")).toThrow("starting with /");
    expect(() => remotePath("/srv/a\nb")).toThrow("can't have");
  });

  it("trims a project name and caps its length", () => {
    expect(projectName("  Lab ")).toBe("Lab");
    expect(() => projectName("x".repeat(201))).toThrow("under 200");
  });
});
