// @vitest-environment jsdom
// Project membership kept by Hermes (ADR 0023), against a fake Hermes that answers ADR 0023's proposed
// `projects.chats.*` contract when set up with it, and answers as the deployed `bf0203a` does (no such methods, no
// `chat_membership` in `projects.list`) when not. Two connections to one fake server are two computers.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row, type FakeProject } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { ProjectsStore, type ProjectsApi } from "./projects";
import { PROJECTS_KEY, projectLinks, projectScope, readLinks, type LinksStorage } from "./projectLinks";
import { keepMine, migrationPlan, overlay, queueOp, settle, type ServerLinks } from "./membership";

const running: Hermes[] = [];
// The fake answers one connection at a time, so the computers share one; each has its own store and storage, which is
// where two computers differ.
const connections = new Map<FakeHermes, Promise<Hermes>>();
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  connections.clear();
});

const CONNECTION = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const SCOPE = projectScope(CONNECTION, "default");

const project = (id: string, name: string, archived = false): FakeProject => ({
  id,
  slug: name.toLowerCase(),
  name,
  primary_path: null,
  archived,
  created_at: 1,
  folders: [],
});

/** A server keeping membership (or not), with three chats and two projects. */
function server(keeps = true) {
  const s = new FakeHermes();
  s.sessions = [row("a", 1, { title: "Alpha" }), row("b", 2, { title: "Bravo" }), row("c", 3, { title: "Charlie" })];
  s.projects.default = [project("p_home", "Home"), project("p_work", "Work")];
  if (keeps) s.membership = {};
  return s;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: LinksStorage & { data: Map<string, string> } = { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  return storage;
}

/**
 * One computer: its own connection to `s` and its own storage. `offline` cuts it off: every projects call fails as a
 * dropped connection does, until it is set back.
 */
async function computer(s: FakeHermes, storage = memoryStorage()) {
  if (!connections.has(s))
    connections.set(
      s,
      connect(s.openPipe).then((h) => {
        running.push(h);
        return h;
      }),
    );
  const hermes = await connections.get(s)!;
  const net = { offline: false };
  const gate = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) =>
    net.offline ? Promise.reject(new Error("Not connected to Hermes.")) : fn(...a);
  const real = hermes.projects;
  const api: ProjectsApi = {
    ...real,
    list: gate(real.list),
    listing: gate(real.listing),
    delete: gate(real.delete),
    membership: { list: gate(real.membership.list), apply: gate(real.membership.apply) },
  };
  const store = new ProjectsStore(api, projectLinks(storage), SCOPE, "default");
  return { store, storage, net };
}

const sent = (s: FakeHermes, method: string) => s.requests.filter((r) => r.method === method).map((r) => r.params);
const onServer = (s: FakeHermes) =>
  [...(s.membership?.default?.links.values() ?? [])].filter((l) => l.member).map((l) => `${l.project}:${l.chat}`).sort();
const chatsOf = (store: ProjectsStore) => store.getSnapshot().chats;

/** Puts membership on a computer before Hermes keeps it: the store's local mode, as every computer has it today. */
async function withLocal(s: FakeHermes, links: Record<string, string[]>) {
  const c = await computer(s);
  for (const [p, chats] of Object.entries(links)) for (const chat of chats) c.store.setChat(p, chat, true);
  return c;
}

describe("a server that doesn't keep membership (the deployed Hermes)", () => {
  it("is never sent a membership call, and membership stays on this computer", async () => {
    const s = server(false);
    const { store } = await computer(s);
    await store.load();
    store.setChat("p_home", "a", true);
    await store.sync();
    expect(store.getSnapshot().membership).toMatchObject({ mode: "local", supported: false, pending: [] });
    expect(chatsOf(store)).toEqual({ p_home: ["a"] });
    expect(s.requests.filter((r) => r.method.startsWith("projects.chats"))).toEqual([]);
  });

  it("says nothing either way before the projects are read", async () => {
    const { store } = await computer(server());
    expect(store.getSnapshot().membership).toMatchObject({ mode: "local" });
    expect(store.getSnapshot().membership.supported).toBeUndefined();
  });
});

describe("copying this computer's membership to Hermes", () => {
  it("previews what it will do, and changes nothing until the owner agrees", async () => {
    const s = server();
    s.projects.default.push(project("p_old", "Old", true));
    const m = (s.membership!.default = { revision: 2, links: new Map(), ops: new Map() });
    m.links.set("p_home\nb", { project: "p_home", chat: "b", member: true, rev: 1 });
    m.links.set("p_work\nc", { project: "p_work", chat: "c", member: false, rev: 2 });
    const { store } = await withLocal(s, { p_home: ["a", "b"], p_work: ["c", "a"], p_old: ["a"], p_gone: ["b"] });
    await store.load();
    const { membership } = store.getSnapshot();
    expect(membership.mode).toBe("offer");
    expect(membership.plan?.add.map((x) => `${x.project}:${x.chat}`).sort()).toEqual(["p_home:a", "p_work:a"]);
    expect(membership.plan).toMatchObject({
      already: 1,
      takenOut: [{ project: "p_work", chat: "c" }],
      // Archived Old. Gone was never listed, so this computer already forgot it at the read.
      skipped: 1,
      byProject: { p_home: 1, p_work: 1 },
    });
    expect(sent(s, "projects.chats.apply")).toEqual([]);
    // Until then, the list still shows this computer's.
    expect(chatsOf(store).p_work).toEqual(["a", "c"]);
  });

  it("adds only what Hermes has no record of, keeps a recovery copy, and then shows Hermes's", async () => {
    const s = server();
    const m = (s.membership!.default = { revision: 1, links: new Map(), ops: new Map() });
    m.links.set("p_work\nb", { project: "p_work", chat: "b", member: true, rev: 1 });
    const { store, storage } = await withLocal(s, { p_home: ["a", "b"], p_work: ["b"] });
    await store.load();
    await store.migrate();
    expect(onServer(s)).toEqual(["p_home:a", "p_home:b", "p_work:b"]);
    // One add each: the pair Hermes already had isn't sent.
    expect(sent(s, "projects.chats.apply").flatMap((p) => (p.ops as { session_id: string; project_id: string }[]).map((o) => `${o.project_id}:${o.session_id}`)).sort()).toEqual([
      "p_home:a",
      "p_home:b",
    ]);
    const snap = store.getSnapshot();
    expect(snap.membership).toMatchObject({ mode: "synced", pending: [], error: undefined, restorable: 0 });
    expect(snap.membership.recovery?.chats).toEqual({ p_home: ["b", "a"], p_work: ["b"] });
    expect(readLinks(JSON.parse(storage.data.get(PROJECTS_KEY)!))[SCOPE].recovery?.chats).toEqual({ p_home: ["b", "a"], p_work: ["b"] });
  });

  it("adds nothing when run again, from this computer or another", async () => {
    const s = server();
    const one = await withLocal(s, { p_home: ["a"] });
    await one.store.load();
    await one.store.migrate();
    await one.store.migrate();
    const two = await withLocal(s, { p_home: ["a"], p_work: ["b"] });
    await two.store.load();
    expect(two.store.getSnapshot().membership.plan).toMatchObject({ add: [{ project: "p_work", chat: "b" }], already: 1 });
    await two.store.migrate();
    await two.store.migrate();
    expect(onServer(s)).toEqual(["p_home:a", "p_work:b"]);
    expect([...s.membership!.default.links.values()]).toHaveLength(2);
    expect(sent(s, "projects.chats.apply").flatMap((p) => p.ops as unknown[])).toHaveLength(2);
  });

  it("uses Hermes's straight away when this computer has none to copy", async () => {
    const s = server();
    const a = await withLocal(s, { p_home: ["a"] });
    await a.store.load();
    await a.store.migrate();
    const fresh = await computer(s);
    await fresh.store.load();
    expect(fresh.store.getSnapshot().membership.mode).toBe("synced");
    expect(chatsOf(fresh.store)).toEqual({ p_home: ["a"] });
  });

  it("keeps membership on this computer when the owner says Not now", async () => {
    const s = server();
    const { store } = await withLocal(s, { p_home: ["a"] });
    await store.load();
    store.notNowMigrate();
    store.setChat("p_work", "b", true);
    expect(store.getSnapshot().membership.mode).toBe("local");
    expect(chatsOf(store)).toEqual({ p_home: ["a"], p_work: ["b"] });
    expect(sent(s, "projects.chats.apply")).toEqual([]);
  });

  it("loses nothing when Hermes stops answering partway: the rest waits, shown, and goes at the next sync", async () => {
    const s = server();
    const many = Array.from({ length: 250 }, (_, i) => `chat${i}`);
    const { store } = await withLocal(s, { p_home: many });
    await store.load();
    s.membershipApplyLeft = 1;
    await store.migrate();
    let snap = store.getSnapshot();
    expect(onServer(s)).toHaveLength(200);
    expect(snap.membership).toMatchObject({ mode: "synced", error: "database is locked" });
    expect(snap.membership.pending).toHaveLength(50);
    expect(snap.chats.p_home).toHaveLength(250);
    s.membershipApplyLeft = undefined;
    await store.sync();
    snap = store.getSnapshot();
    expect(onServer(s)).toHaveLength(250);
    expect(snap.membership).toMatchObject({ pending: [], error: undefined });
  });

  it("changes nothing when Hermes can't be read for the copy", async () => {
    const s = server();
    const c = await withLocal(s, { p_home: ["a"] });
    await c.store.load();
    c.net.offline = true;
    await expect(c.store.migrate()).rejects.toThrow("Not connected");
    expect(c.store.getSnapshot().membership.mode).toBe("offer");
    expect(chatsOf(c.store)).toEqual({ p_home: ["a"] });
  });
});

/** Two computers both already synced with Hermes, which has `a` in Home. */
async function twoSynced() {
  const s = server();
  const one = await withLocal(s, { p_home: ["a"] });
  await one.store.load();
  await one.store.migrate();
  const two = await computer(s);
  await two.store.load();
  return { s, one, two };
}

describe("two computers", () => {
  it("each sees the other's changes at the next read, without losing unrelated ones", async () => {
    const { s, one, two } = await twoSynced();
    one.store.setChat("p_home", "b", true);
    two.store.setChat("p_work", "c", true);
    two.store.setChat("p_home", "a", false);
    await one.store.sync();
    await two.store.sync();
    await one.store.load();
    expect(onServer(s)).toEqual(["p_home:b", "p_work:c"]);
    expect(chatsOf(one.store)).toEqual({ p_home: ["b"], p_work: ["c"] });
    expect(chatsOf(two.store)).toEqual({ p_home: ["b"], p_work: ["c"] });
  });

  it("puts one chat in several projects", async () => {
    const { s, one, two } = await twoSynced();
    one.store.setChat("p_work", "a", true);
    await one.store.sync();
    await two.store.sync();
    expect(onServer(s)).toEqual(["p_home:a", "p_work:a"]);
    expect([...two.store.projectsOf("a")].sort()).toEqual(["p_home", "p_work"]);
  });

  it("keeps a change made offline waiting, and sends it on reconnecting", async () => {
    const { s, one, two } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_work", "b", true);
    await one.store.sync();
    let snap = one.store.getSnapshot();
    expect(snap.membership).toMatchObject({ mode: "synced", error: "Not connected to Hermes." });
    expect(snap.membership.pending).toMatchObject([{ project: "p_work", chat: "b", member: true }]);
    expect(one.store.pendingOf("b")).toEqual(new Map([["p_work", "pending"]]));
    expect(snap.chats.p_work).toEqual(["b"]);
    one.net.offline = false;
    await one.store.load();
    snap = one.store.getSnapshot();
    expect(snap.membership).toMatchObject({ pending: [], error: undefined });
    await two.store.load();
    expect(chatsOf(two.store).p_work).toEqual(["b"]);
    expect(onServer(s)).toEqual(["p_home:a", "p_work:b"]);
  });

  it("keeps the waiting change across a restart", async () => {
    const { s, one } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_work", "b", true);
    await one.store.sync();
    const again = await computer(s, one.storage);
    expect(again.store.getSnapshot().membership.pending).toHaveLength(1);
    await again.store.load();
    expect(onServer(s)).toEqual(["p_home:a", "p_work:b"]);
  });

  it("treats the same change made on both as done, not a conflict", async () => {
    const { s, one, two } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_home", "a", false);
    two.store.setChat("p_home", "a", false);
    await two.store.sync();
    one.net.offline = false;
    await one.store.load();
    expect(one.store.getSnapshot().membership.pending).toEqual([]);
    expect(onServer(s)).toEqual([]);
  });

  it("holds a change for the owner when the other computer changed the same chat meanwhile", async () => {
    const { s, one, two } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_home", "a", false);
    // Meanwhile the other computer takes it out and puts it back.
    two.store.setChat("p_home", "a", false);
    await two.store.sync();
    two.store.setChat("p_home", "a", true);
    await two.store.sync();
    one.net.offline = false;
    await one.store.load();
    const snap = one.store.getSnapshot();
    expect(snap.membership.pending).toMatchObject([{ project: "p_home", chat: "a", member: false, conflict: { member: true } }]);
    expect(one.store.pendingOf("a")).toEqual(new Map([["p_home", "conflict"]]));
    // Until the owner decides, the list shows what Hermes has, and nothing more is sent for it.
    expect(snap.chats).toEqual({ p_home: ["a"] });
    const applies = sent(s, "projects.chats.apply").length;
    await one.store.sync();
    expect(sent(s, "projects.chats.apply")).toHaveLength(applies);
    expect(onServer(s)).toEqual(["p_home:a"]);
    return { s, one, two };
  });

  it("sends this computer's side of a conflict when the owner keeps it", async () => {
    const { s, one, two } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_home", "a", false);
    two.store.setChat("p_home", "a", false);
    await two.store.sync();
    two.store.setChat("p_home", "a", true);
    await two.store.sync();
    one.net.offline = false;
    await one.store.load();
    const [conflict] = one.store.getSnapshot().membership.pending;
    await one.store.resolve(conflict.id, "mine");
    expect(onServer(s)).toEqual([]);
    expect(one.store.getSnapshot().membership.pending).toEqual([]);
  });

  it("drops this computer's side of a conflict when the owner keeps Hermes's", async () => {
    const { s, one, two } = await twoSynced();
    one.net.offline = true;
    one.store.setChat("p_home", "a", false);
    two.store.setChat("p_home", "a", false);
    await two.store.sync();
    two.store.setChat("p_home", "a", true);
    await two.store.sync();
    one.net.offline = false;
    await one.store.load();
    const [conflict] = one.store.getSnapshot().membership.pending;
    await one.store.resolve(conflict.id, "theirs");
    expect(onServer(s)).toEqual(["p_home:a"]);
    expect(one.store.getSnapshot()).toMatchObject({ chats: { p_home: ["a"] }, membership: { pending: [] } });
  });
});

describe("chats and projects that go", () => {
  it("deleting a project takes its membership with it, never its chats; a waiting change for it is dropped", async () => {
    const { s, one, two } = await twoSynced();
    one.store.setChat("p_home", "b", true);
    one.store.setChat("p_work", "b", true);
    await one.store.sync();
    two.net.offline = true;
    two.store.setChat("p_home", "c", true);
    two.net.offline = false;
    await one.store.delete("p_home");
    expect(onServer(s)).toEqual(["p_work:b"]);
    expect(s.sessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
    await two.store.load();
    expect(two.store.getSnapshot()).toMatchObject({ chats: { p_work: ["b"] }, membership: { pending: [] } });
  });

  it("takes a deleted chat out of its projects in Hermes", async () => {
    const { s, one } = await twoSynced();
    one.store.setChat("p_work", "a", true);
    await one.store.sync();
    one.store.forgetChat("a");
    await one.store.sync();
    expect(onServer(s)).toEqual([]);
  });

  it("keeps a record for a chat this list doesn't have: it may be older than the list reaches", async () => {
    const { s, one } = await twoSynced();
    one.store.setChat("p_home", "not-listed", true);
    await one.store.sync();
    await one.store.load();
    expect(onServer(s)).toEqual(["p_home:a", "p_home:not-listed"]);
    expect(chatsOf(one.store).p_home).toEqual(["not-listed", "a"]);
  });

  it("drops a change to a project another computer deleted, without touching others", async () => {
    const { s, one, two } = await twoSynced();
    two.net.offline = true;
    two.store.setChat("p_work", "c", true);
    two.store.setChat("p_home", "b", true);
    await one.store.delete("p_work");
    two.net.offline = false;
    await two.store.sync();
    expect(onServer(s)).toEqual(["p_home:a", "p_home:b"]);
    expect(two.store.getSnapshot().membership.pending).toEqual([]);
  });
});

describe("a server that stops keeping membership", () => {
  it("keeps the changes waiting and the last copy shown, and sends nothing", async () => {
    const { s, one } = await twoSynced();
    s.membership = null;
    await one.store.load();
    one.store.setChat("p_work", "b", true);
    await one.store.sync();
    expect(one.store.getSnapshot()).toMatchObject({
      chats: { p_home: ["a"], p_work: ["b"] },
      membership: { mode: "synced", supported: false, pending: [{ chat: "b" }] },
    });
  });
});

describe("putting chats back from the recovery copy", () => {
  it("adds back the pairs Hermes lacks, for projects it still has", async () => {
    const { s, one, two } = await twoSynced();
    two.store.setChat("p_home", "a", false);
    await two.store.sync();
    await one.store.load();
    expect(one.store.getSnapshot().membership.restorable).toBe(1);
    await one.store.restoreRecovery();
    expect(onServer(s)).toEqual(["p_home:a"]);
    expect(one.store.getSnapshot().membership.restorable).toBe(0);
  });
});

describe("the operations themselves", () => {
  const links: ServerLinks = { p: { a: { member: true, rev: 4 }, b: { member: false, rev: 6 } } };

  it("fences each change on the revision it was made over", () => {
    expect(queueOp(links, [], { id: "1", project: "p", chat: "a", member: false, at: 0 })).toMatchObject([{ base: 4 }]);
    expect(queueOp(links, [], { id: "1", project: "p", chat: "c", member: true, at: 0 })).toMatchObject([{ base: 0 }]);
  });

  it("replaces a waiting change to the same pair, and an undo leaves nothing to send", () => {
    const one = queueOp(links, [], { id: "1", project: "p", chat: "a", member: false, at: 0 });
    expect(queueOp(links, one, { id: "2", project: "p", chat: "a", member: true, at: 1 })).toEqual([]);
  });

  it("overlays waiting changes in order, but not those in conflict", () => {
    const pending = [
      { id: "1", project: "p", chat: "c", member: true, base: 0, at: 0 },
      { id: "2", project: "p", chat: "a", member: false, base: 4, at: 0, conflict: { member: true, rev: 9 } },
    ];
    expect(overlay(links, pending)).toEqual({ p: ["c", "a"] });
  });

  it("settles a conflict Hermes has since come round to", () => {
    const pending = [{ id: "2", project: "p", chat: "b", member: true, base: 1, at: 0, conflict: { member: false, rev: 6 } }];
    expect(settle({ p: { b: { member: true, rev: 7 } } }, pending)).toEqual([]);
  });

  it("sends a kept conflict with a new id, over Hermes's revision", () => {
    const [op] = keepMine([{ id: "2", project: "p", chat: "b", member: true, base: 1, at: 0, conflict: { member: false, rev: 6 } }], "2");
    expect(op).toMatchObject({ base: 6, member: true });
    expect(op.id).not.toBe("2");
    expect(op.conflict).toBeUndefined();
  });

  it("plans a copy with each pair once, however often this computer lists it", () => {
    const plan = migrationPlan({ p: ["c", "c", "a"] }, links, [{ id: "p", name: "P", folders: [], archived: false }]);
    expect(plan).toMatchObject({ add: [{ project: "p", chat: "c" }], already: 1 });
  });
});
