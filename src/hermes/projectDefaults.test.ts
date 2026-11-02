// Project defaults for new chats (ADR 0014): how a new chat's values are resolved, how the defaults are kept on this
// computer with revisions, and how a chat starts with them against a fake Hermes that answers `session.create`,
// `session.cwd.set` and `GET /api/fs/list` as the deployed `bf0203a` did when probed live.
import { afterEach, describe, expect, it } from "vitest";
import { connect, type Hermes } from "./transport";
import { catalogFromServer, type ModelPick } from "./models";
import { FakeHermes, modelOptions } from "./fakeHermes";
import { DefaultsConflict, NewerDefaultsError, cleanDraft, instructionsMessage, modelProblem, resolveNewChat, toDefaults } from "./projectDefaults";
import { PROJECTS_KEY, PROJECTS_VERSION, projectLinks, projectScope, type LinksStorage } from "./projectLinks";

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
    expect(() => cleanDraft({ instructions: "x".repeat(20_001) })).toThrow("under 20,000");
    expect(toDefaults({ rev: 3, instructions: 5, model: { provider: "a" }, folder: "relative/dir" })).toEqual({ rev: 3 });
    expect(toDefaults({ rev: 0 })).toBeUndefined();
  });
});

describe("keeping the defaults", () => {
  it("saves with a revision and is read back after a restart", () => {
    const storage = memoryStorage();
    const saved = projectLinks(storage).saveDefaults(SCOPE, "p_1", 0, { instructions: " Be brief. ", model: opus, folder: "/srv/app" });
    expect(saved).toEqual({ rev: 1, instructions: "Be brief.", model: opus, folder: "/srv/app" });
    const doc = JSON.parse(storage.data.get(PROJECTS_KEY)!);
    expect(doc.v).toBe(PROJECTS_VERSION);
    expect(projectLinks(storage).read(SCOPE).defaults).toEqual({ p_1: saved });
  });

  it("refuses a save over one made meanwhile in another window, and keeps the other", () => {
    const storage = memoryStorage();
    const mine = projectLinks(storage);
    const theirs = projectLinks(storage);
    mine.saveDefaults(SCOPE, "p_1", 0, { instructions: "First" });
    // Both windows opened the editor at revision 1; the other saves first.
    theirs.saveDefaults(SCOPE, "p_1", 1, { instructions: "Theirs" });
    let conflict: unknown;
    try {
      mine.saveDefaults(SCOPE, "p_1", 1, { instructions: "Mine" });
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(DefaultsConflict);
    expect((conflict as DefaultsConflict).saved).toEqual({ rev: 2, instructions: "Theirs" });
    expect(mine.read(SCOPE).defaults.p_1.instructions).toBe("Theirs");
    // Choosing to keep theirs' place: saving over the revision now kept.
    expect(mine.saveDefaults(SCOPE, "p_1", 2, { instructions: "Mine" })).toEqual({ rev: 3, instructions: "Mine" });
  });

  it("removing every default keeps the revision, so the project inherits and old editors still conflict", () => {
    const links = projectLinks(memoryStorage());
    links.saveDefaults(SCOPE, "p_1", 0, { folder: "/srv/app" });
    expect(links.saveDefaults(SCOPE, "p_1", 1, {})).toEqual({ rev: 2 });
    expect(() => links.saveDefaults(SCOPE, "p_1", 1, { folder: "/srv/app" })).toThrow(DefaultsConflict);
  });

  it("won't change the defaults in a document a newer Hermes Chat wrote", () => {
    const storage = memoryStorage({ [PROJECTS_KEY]: JSON.stringify({ v: PROJECTS_VERSION + 1, scopes: { [SCOPE]: { chats: {}, known: [], defaults: { p_1: { rev: 4, instructions: "Newer", extra: 1 } } } } }) });
    const links = projectLinks(storage);
    expect(links.read(SCOPE).defaults.p_1).toEqual({ rev: 4, instructions: "Newer" });
    expect(() => links.saveDefaults(SCOPE, "p_1", 4, { instructions: "Older" })).toThrow(NewerDefaultsError);
    expect(JSON.parse(storage.data.get(PROJECTS_KEY)!).scopes[SCOPE].defaults.p_1.extra).toBe(1);
  });

  it("says when the storage won't keep them, and doesn't pretend it did", () => {
    const storage = memoryStorage();
    const links = projectLinks(storage);
    storage.full = true;
    expect(() => links.saveDefaults(SCOPE, "p_1", 0, { instructions: "x" })).toThrow("couldn't keep them");
    storage.full = false;
    expect(links.read(SCOPE).defaults).toEqual({});
  });

  it("keeps each profile's and connection's apart", () => {
    const links = projectLinks(memoryStorage());
    links.saveDefaults(SCOPE, "p_1", 0, { instructions: "Default profile" });
    expect(links.read(projectScope(CONNECTION, "work")).defaults).toEqual({});
    expect(links.read(projectScope({ ...CONNECTION, sshTarget: "other@host" }, "default")).defaults).toEqual({});
  });

  it("are kept through the project's other changes, and go with the project", () => {
    const links = projectLinks(memoryStorage());
    links.saveDefaults(SCOPE, "p_1", 0, { instructions: "Keep" });
    links.setChat(SCOPE, "p_1", "chat", true);
    links.select(SCOPE, "p_1");
    expect(links.read(SCOPE).defaults.p_1.instructions).toBe("Keep");
    links.remember(SCOPE, [{ id: "p_2", name: "Other", folders: [], archived: false }]);
    expect(links.read(SCOPE).defaults).toEqual({});
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
