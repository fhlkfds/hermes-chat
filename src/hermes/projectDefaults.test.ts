// Project defaults for new chats (ADR 0017): how a new chat's values are resolved, how the defaults are kept on this
// computer with revisions, and how a chat starts with them against a fake Hermes that answers `session.create`,
// `session.cwd.set` and `GET /api/fs/list` as the deployed `bf0203a` did when probed live.
import { afterEach, describe, expect, it } from "vitest";
import { connect, type Hermes } from "./transport";
import { catalogFromServer, type ModelPick } from "./models";
import { FakeHermes, modelOptions } from "./fakeHermes";
import { DEFAULTS_VERSION, DefaultsConflict, NewerDefaultsError, cleanDraft, defaultsDoc, draftProblem, storageDefaultsFile, type DefaultsFile, instructionsMessage, modelProblem, resolveNewChat, toDefaults } from "./projectDefaults";
import { projectLinks, projectScope, type LinksStorage } from "./projectLinks";
import { ProjectsStore } from "./projects";

const CONNECTION = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const SCOPE = projectScope(CONNECTION, "default");
const opus: ModelPick = { provider: "anthropic", model: "claude-opus-4-5", effort: "high" };
const sonnet: ModelPick = { provider: "anthropic", model: "claude-sonnet-4-5" };
const gpt: ModelPick = { provider: "openai", model: "gpt-5", effort: "low" };

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

describe("what a new chat starts with", () => {
  const project = { name: "Budget", defaults: { rev: 1, instructions: "Use metric units.", model: opus, folder: "/srv/budget" } };

  it("takes the profile's when there is no project", () => {
    const s = resolveNewChat({ sticky: sonnet, profilePick: sonnet, profileEffort: "medium" });
    expect(s).toEqual({
      model: { value: sonnet, from: "profile" },
      effort: { value: "medium", from: "profile" },
      instructions: { from: "profile" },
      folder: { from: "profile" },
    });
  });

  it("names the owner's own model pick apart from the profile's", () => {
    expect(resolveNewChat({ sticky: gpt, profilePick: sonnet }).model).toEqual({ value: gpt, from: "pick" });
  });

  it("takes the project's defaults over the profile's and the owner's sticky pick", () => {
    const s = resolveNewChat({ project, sticky: gpt, profilePick: sonnet, profileEffort: "medium" });
    expect(s.model).toEqual({ value: opus, from: "project" });
    expect(s.effort).toEqual({ value: "high", from: "project" });
    expect(s.instructions).toEqual({ value: "Use metric units.", from: "project" });
    expect(s.folder).toEqual({ value: "/srv/budget", from: "project" });
    expect(s.project).toBe("Budget");
  });

  it("takes a model chosen for the chat over the project's, and keeps the project's other values", () => {
    const s = resolveNewChat({ chosen: gpt, project, sticky: sonnet, profilePick: sonnet });
    expect(s.model).toEqual({ value: gpt, from: "chat" });
    expect(s.effort).toEqual({ value: "low", from: "chat" });
    expect(s.folder.from).toBe("project");
  });

  it("inherits the effort from the profile when the project's model sets none", () => {
    const s = resolveNewChat({ project: { name: "B", defaults: { rev: 1, model: sonnet } }, profileEffort: "medium" });
    expect(s.model.from).toBe("project");
    expect(s.effort).toEqual({ value: "medium", from: "profile" });
  });

  it("goes back to the profile's when a default is removed", () => {
    const s = resolveNewChat({ project: { name: "B", defaults: { rev: 2 } }, sticky: sonnet, profilePick: sonnet });
    expect([s.model.from, s.instructions.from, s.folder.from]).toEqual(["profile", "profile", "profile"]);
  });

  it("refuses a project model Hermes doesn't offer, or can't use now, and never swaps it", () => {
    const catalog = catalogFromServer("default", modelOptions())!;
    const missing = resolveNewChat({ project: { name: "B", defaults: { rev: 1, model: { provider: "anthropic", model: "claude-retired" } } } });
    expect(modelProblem(missing, catalog)).toMatch(/claude-retired \(anthropic\), isn't offered by Hermes/);
    expect(modelProblem(resolveNewChat({ project }), catalog)).toBeUndefined();
    const unavailable = { ...catalog, providers: catalog.providers.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m, available: false })) })) };
    expect(modelProblem(resolveNewChat({ project }), unavailable)).toMatch(/can't be used now/);
    // A model chosen for the chat, or a guessed list, isn't second-guessed.
    expect(modelProblem(resolveNewChat({ chosen: { provider: "x", model: "y" }, project }), catalog)).toBeUndefined();
    expect(modelProblem(missing, { ...catalog, source: "fallback" })).toBeUndefined();
  });

  it("tidies what is kept", () => {
    expect(cleanDraft({ instructions: "  \n ", model: { ...opus, fast: true }, folder: "" })).toEqual({ model: opus });
    expect(draftProblem({ instructions: "x".repeat(20_001) })).toContain("under 20,000");
    expect(cleanDraft({ instructions: "x".repeat(20_001) }).instructions).toHaveLength(20_001);
    expect(toDefaults({ rev: 3, instructions: 5, model: { provider: "a" }, folder: "relative/dir" })).toEqual({ rev: 3 });
    expect(toDefaults({ rev: 0 })).toBeUndefined();
  });
});

describe("keeping the defaults", () => {
  /**
   * A file shared by separate app instances, as defaults_file.rs keeps it: a read, and a compare-and-swap. `beforeSwap`
   * runs between a writer's read and its swap, where another instance's write can land.
   */
  type Shared = { text: string | null; swaps: number; beforeSwap?: () => Promise<void>; file: DefaultsFile };
  function sharedFile(initial: string | null = null): Shared {
    const f: Shared = {
      text: initial,
      swaps: 0,
      file: {
        read: async () => f.text,
        swap: async (expected: string | null, next: string) => {
          const hook = f.beforeSwap;
          f.beforeSwap = undefined;
          await hook?.();
          f.swaps++;
          if (f.text !== expected) return { swapped: false, current: f.text };
          f.text = next;
          return { swapped: true, current: next };
        },
      },
    };
    return f;
  }

  it("saves with a revision and is read back, by another instance too", async () => {
    const f = sharedFile();
    const saved = await defaultsDoc(f.file).save(SCOPE, "p_1", 0, { instructions: " Be brief. ", model: opus, folder: "/srv/app" });
    expect(saved).toEqual({ rev: 1, instructions: "Be brief.", model: opus, folder: "/srv/app" });
    expect(JSON.parse(f.text!)).toEqual({ v: DEFAULTS_VERSION, scopes: { [SCOPE]: { p_1: saved } } });
    expect(await defaultsDoc(f.file).read(SCOPE)).toEqual({ p_1: saved });
  });

  it("refuses a save over one made meanwhile in another instance, and keeps the other", async () => {
    const f = sharedFile();
    const [mine, theirs] = [defaultsDoc(f.file), defaultsDoc(f.file)];
    await mine.save(SCOPE, "p_1", 0, { instructions: "First" });
    await theirs.save(SCOPE, "p_1", 1, { instructions: "Theirs" });
    const conflict = await mine.save(SCOPE, "p_1", 1, { instructions: "Mine" }).catch((e) => e);
    expect(conflict).toBeInstanceOf(DefaultsConflict);
    expect((conflict as DefaultsConflict).saved).toEqual({ rev: 2, instructions: "Theirs" });
    // The owner chooses to save theirs over it: over the revision now kept.
    expect(await mine.save(SCOPE, "p_1", 2, { instructions: "Mine" })).toEqual({ rev: 3, instructions: "Mine" });
  });

  it("can't lose a save that lands between another instance's read and its write", async () => {
    // Both instances opened the editor at revision 1. Theirs saves after mine has read the file, before mine writes.
    const f = sharedFile();
    const [mine, theirs] = [defaultsDoc(f.file), defaultsDoc(f.file)];
    await mine.save(SCOPE, "p_1", 0, { instructions: "First" });
    f.beforeSwap = async () => void (await theirs.save(SCOPE, "p_1", 1, { instructions: "Theirs" }));
    await expect(mine.save(SCOPE, "p_1", 1, { instructions: "Mine" })).rejects.toBeInstanceOf(DefaultsConflict);
    expect((await mine.read(SCOPE)).p_1).toEqual({ rev: 2, instructions: "Theirs" });
  });

  it("keeps another project's save that lands between its read and its write", async () => {
    const f = sharedFile();
    const [mine, theirs] = [defaultsDoc(f.file), defaultsDoc(f.file)];
    f.beforeSwap = async () => void (await theirs.save(SCOPE, "p_2", 0, { instructions: "Theirs" }));
    await mine.save(SCOPE, "p_1", 0, { instructions: "Mine" });
    expect(await mine.read(SCOPE)).toEqual({ p_1: { rev: 1, instructions: "Mine" }, p_2: { rev: 1, instructions: "Theirs" } });
  });

  it("is never written by the projects' other changes, so they can't put an older copy back", async () => {
    const f = sharedFile();
    await defaultsDoc(f.file).save(SCOPE, "p_1", 0, { instructions: "Keep" });
    const before = f.text;
    const storage = memoryStorage();
    const links = projectLinks(storage);
    links.setChat(SCOPE, "p_1", "chat", true);
    links.select(SCOPE, "p_1");
    links.remember(SCOPE, [{ id: "p_2", name: "Other", folders: [], archived: false }]);
    links.forgetProject(SCOPE, "p_2");
    expect(f.text).toBe(before);
  });

  it("removing every default keeps the revision, so the project inherits and old editors still conflict", async () => {
    const d = defaultsDoc(sharedFile().file);
    await d.save(SCOPE, "p_1", 0, { folder: "/srv/app" });
    expect(await d.save(SCOPE, "p_1", 1, {})).toEqual({ rev: 2 });
    await expect(d.save(SCOPE, "p_1", 1, { folder: "/srv/app" })).rejects.toBeInstanceOf(DefaultsConflict);
  });

  it("won't change a document a newer Hermes Chat wrote, in any shape", async () => {
    for (const scopes of [{ [SCOPE]: { p_1: { rev: 4, instructions: "Newer", extra: 1 } } }, [1, 2], "x", null]) {
      const newer = JSON.stringify({ v: DEFAULTS_VERSION + 1, scopes, more: true });
      const f = sharedFile(newer);
      const d = defaultsDoc(f.file);
      await expect(d.save(SCOPE, "p_1", 4, { instructions: "Older" })).rejects.toBeInstanceOf(NewerDefaultsError);
      await d.forget(SCOPE, "p_1");
      expect(f.text).toBe(newer);
      expect(f.swaps).toBe(0);
    }
    expect(await defaultsDoc(sharedFile(JSON.stringify({ v: 2, scopes: { [SCOPE]: { p_1: { rev: 4, instructions: "Newer", extra: 1 } } } })).file).read(SCOPE)).toEqual({
      p_1: { rev: 4, instructions: "Newer" },
    });
  });

  it("refuses an over-long draft, and says when the file can't be written", async () => {
    const f = sharedFile();
    const d = defaultsDoc(f.file);
    await expect(d.save(SCOPE, "p", 0, { instructions: "x".repeat(20_001) })).rejects.toThrow("under 20,000");
    const broken = defaultsDoc({ read: async () => null, swap: async () => Promise.reject(new Error("Read-only file system")) });
    await expect(broken.save(SCOPE, "p_1", 0, { instructions: "x" })).rejects.toThrow("couldn't keep them: Read-only file system");
    expect(f.text).toBeNull();
  });

  it("keeps each profile's and connection's apart", async () => {
    const d = defaultsDoc(sharedFile().file);
    await d.save(SCOPE, "p_1", 0, { instructions: "Default profile" });
    expect(await d.read(projectScope(CONNECTION, "work"))).toEqual({});
    expect(await d.read(projectScope({ ...CONNECTION, sshTarget: "other@host" }, "default"))).toEqual({});
  });

  it("forgets only the project it is told is gone", async () => {
    const d = defaultsDoc(sharedFile().file);
    await d.save(SCOPE, "p_1", 0, { instructions: "Gone" });
    await d.save(SCOPE, "p_2", 0, { instructions: "Kept" });
    await d.save(projectScope(CONNECTION, "work"), "p_1", 0, { instructions: "Other profile" });
    await d.forget(SCOPE, "p_1");
    expect(await d.read(SCOPE)).toEqual({ p_2: { rev: 1, instructions: "Kept" } });
    expect((await d.read(projectScope(CONNECTION, "work"))).p_1.instructions).toBe("Other profile");
  });

  it("keeps a project's defaults when a project list older than their save leaves it out", async () => {
    // Another window made the project and saved its defaults after this one asked Hermes for the list.
    const f = sharedFile();
    const s = new FakeHermes();
    s.projects.default = [];
    const listed = s.handlers["projects.list"];
    let answer!: () => void;
    s.handlers["projects.list"] = (r) => void (answer = () => listed(r));
    const hermes = await connect(s.openPipe);
    try {
      const store = new ProjectsStore(hermes.projects, projectLinks(memoryStorage()), SCOPE, "default", defaultsDoc(f.file));
      const loading = store.load();
      await new Promise((r) => setTimeout(r, 0));
      await defaultsDoc(f.file).save(SCOPE, "p_new", 0, { instructions: "Saved meanwhile" });
      answer();
      await loading;
      await store.readDefaults();
      expect((await defaultsDoc(f.file).read(SCOPE)).p_new).toEqual({ rev: 1, instructions: "Saved meanwhile" });
    } finally {
      await hermes.close();
    }
  });

  it("answers a chat about to start with its own read, even while a later read is under way", async () => {
    const f = sharedFile();
    const read = f.file.read;
    let gate: Promise<void> | undefined;
    f.file = { ...f.file, read: async () => (await gate, read()) };
    await defaultsDoc(f.file).save(SCOPE, "p_1", 0, { instructions: "OLD" });
    const store = new ProjectsStore({} as never, projectLinks(memoryStorage()), SCOPE, "default", defaultsDoc(f.file));
    await store.readDefaults();
    await defaultsDoc(f.file).save(SCOPE, "p_1", 1, { instructions: "NEW" });
    // The chat's read starts, then a background read (the window coming to the front) that hasn't finished.
    const fresh = store.freshDefaults();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const later = store.readDefaults();
    // The chat's read was overtaken, so it isn't shown, but it still answers what the file holds now.
    expect((await fresh).p_1.instructions).toBe("NEW");
    release();
    await later;
  });

  it("forgets a project's defaults once it is deleted here", async () => {
    const f = sharedFile();
    const s = new FakeHermes();
    s.projects.default = [{ id: "p_1", slug: "p", name: "P", primary_path: null, archived: false, created_at: 1, folders: [] }];
    const hermes = await connect(s.openPipe);
    try {
      const store = new ProjectsStore(hermes.projects, projectLinks(memoryStorage()), SCOPE, "default", defaultsDoc(f.file));
      await store.load();
      await store.saveDefaults("p_1", 0, { instructions: "x" });
      expect(store.getSnapshot().defaults.p_1).toEqual({ rev: 1, instructions: "x" });
      await store.delete("p_1");
      await new Promise((r) => setTimeout(r, 0));
      expect(await defaultsDoc(f.file).read(SCOPE)).toEqual({});
    } finally {
      await hermes.close();
    }
  });

  it("uses the localStorage stand-in outside the app, with the same swap", async () => {
    const storage = memoryStorage();
    const file = storageDefaultsFile(() => storage);
    expect(await file.swap(null, "a")).toEqual({ swapped: true, current: "a" });
    expect(await file.swap(null, "b")).toEqual({ swapped: false, current: "a" });
    expect(storage.data.get("hermes-chat.project-defaults")).toBe("a");
  });
});

describe("starting a chat with them", () => {
  const running: Hermes[] = [];
  afterEach(async () => void (await Promise.all(running.splice(0).map((h) => h.close()))));

  async function setUp() {
    const s = new FakeHermes();
    s.serverDirs = new Set(["/srv", "/srv/app"]);
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    await hermes.idle();
    return { s, hermes };
  }
  const creates = (s: FakeHermes) => s.requests.filter((r) => r.method === "session.create").map((r) => r.params);

  it("sends the folder as a deliberate pick, the model and effort, and the instructions once, hidden", async () => {
    const { s, hermes } = await setUp();
    const text = instructionsMessage("Budget", "Use metric units.");
    const id = await hermes.newChat(opus, { folder: "/srv/app", instructions: text });
    expect(creates(s)).toEqual([
      {
        profile: "default",
        source: "gui",
        cwd: "/srv/app",
        cwd_explicit: true,
        messages: [{ role: "user", content: text, display_kind: "hidden" }],
        model: "claude-opus-4-5",
        provider: "anthropic",
        reasoning_effort: "high",
      },
    ]);
    expect(text).toContain('project "Budget"');
    // Sending in it doesn't send the instructions again.
    await hermes.send(id, "Hello", []);
    expect(s.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Hello"]);
  });

  it("sends nothing extra with no defaults", async () => {
    const { s, hermes } = await setUp();
    await hermes.newChat(undefined);
    expect(creates(s)).toEqual([{ profile: "default", source: "gui" }]);
  });

  it("refuses a chat Hermes would have run somewhere else, and leaves nothing behind", async () => {
    const { s, hermes } = await setUp();
    // As live: a cwd Hermes can't find becomes its own home folder, without an error.
    await expect(hermes.newChat(undefined, { folder: "/srv/gone", instructions: "x" })).rejects.toThrow(
      "Hermes didn't start it in /srv/gone: it would have worked in /home/hermes. Nothing was sent.",
    );
    await hermes.idle();
    expect(s.requests.some((r) => r.method === "session.close")).toBe(true);
    expect(s.restRequests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/sessions/20261031_120001_abc123"]);
    expect(hermes.getSnapshot().chats).toEqual([]);
  });

  it("moves a started chat's folder only when Hermes says it did", async () => {
    const { s, hermes } = await setUp();
    const id = await hermes.newChat(undefined);
    await hermes.setFolder(id, "/srv/app");
    expect(s.requests.filter((r) => r.method === "session.cwd.set").map((r) => r.params.cwd)).toEqual(["/srv/app"]);
    await expect(hermes.setFolder(id, "/srv/missing")).rejects.toThrow("working directory does not exist");
  });
});
