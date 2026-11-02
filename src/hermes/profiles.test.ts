import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { type ChatCache, connect } from "./transport";

/** Signed in to a server with a `work` profile beside `default`. */
async function signedIn(cache: ChatCache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [row("home-1", 1, { pinned: true })];
  server.otherProfiles = { work: [row("work-1", 1, { pinned: true }), row("work-2", 2)] };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const ids = () => hermes.getSnapshot().chats.map((c) => c.id).sort();
  return { server, hermes, ids };
}

const sessionLists = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "GET" && r.path === "/api/sessions").map((r) => r.query.get("profile"));

/** Holds back the server's answers to `GET /api/sessions` until the returned function is called. */
function holdLists(server: FakeHermes) {
  const list = server.rest["GET /api/sessions"];
  const held: (() => void)[] = [];
  server.rest["GET /api/sessions"] = (req: RestRequest) => new Promise((resolve) => held.push(() => resolve(list(req))));
  return () => {
    server.rest["GET /api/sessions"] = list;
    held.splice(0).forEach((release) => release());
  };
}

describe("Profiles", () => {
  it("lists the server's profiles through dashboard REST", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { aegis: [], work: [] };
    expect(await hermes.profiles()).toEqual(["default", "aegis", "work"]);
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/profiles" });
  });

  it("starts in the default profile the first time", async () => {
    const { server, hermes, ids } = await signedIn();
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(server.wsProfiles).toEqual(["default"]);
    expect(ids()).toEqual(["home-1"]);
  });

  it("switches to another profile's chats, over a socket opened for it", async () => {
    const { server, hermes, ids } = await signedIn();
    await hermes.switchProfile("work");
    await hermes.idle();

    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" });
    expect(server.wsProfiles).toEqual(["default", "work"]);
    expect(sessionLists(server).at(-1)).toBe("work");
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("starts, opens and replies to chats in the profile it shows", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("work");
    await hermes.idle();

    const id = await hermes.newChat();
    await hermes.send(id, "hello work");
    await hermes.open("work-2");
    await hermes.idle();
    expect(server.last("session.create")!.params).toMatchObject({ profile: "work" });
    expect(server.last("prompt.submit")!.params).toMatchObject({ profile: "work", text: "hello work" });
    expect(server.last("session.resume")!.params).toMatchObject({ session_id: "work-2", profile: "work" });
    expect(server.store("work")!.find((s) => s.id === id)?.pinned).toBe(true);
    expect(server.store("work")!.find((s) => s.id === "work-2")?.last_read_at).not.toBeNull();
  });

  it("shows the profile's last synced list at once, before the new socket is open", async () => {
    const cache = memoryCache();
    cache.saved.work = [{ id: "work-1", title: "Cached", source: "app", settled: false, updatedAt: 0, items: [] }];
    const { server, hermes } = await signedIn(cache);
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";

    const switching = hermes.switchProfile("work");
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", chats: [{ id: "work-1", title: "Cached" }] });
    await switching;
    expect(hermes.getSnapshot().status).not.toBe("connected");
    await hermes.close();
  });

  it("keeps a slow list of the old profile from replacing the new one", async () => {
    const { server, hermes, ids } = await signedIn();
    const release = holdLists(server);
    const oldSync = hermes.sync();
    await hermes.switchProfile("work");
    release();
    await oldSync;
    await hermes.idle();
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("still settles a chat in the old profile when the owner switches straight after", async () => {
    const { server, hermes } = await signedIn();
    const settling = hermes.settle("home-1");
    await hermes.switchProfile("work");
    await settling;
    await hermes.idle();
    const pins = server.restRequests.filter((r) => r.method === "PATCH" && "pinned" in (r.body ?? {}));
    expect(pins.map((r) => editFlags(r.body))).toEqual([{ pinned: false, profile: "default" }]);
    expect(server.sessions[0].pinned).toBe(false);
  });

  it("does nothing when the owner picks the profile already shown", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("default");
    expect(server.opened).toBe(1);
  });

  it("switches while reconnecting, and connects to the new profile", async () => {
    const { server, hermes, ids } = await signedIn();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    server.drop();
    await hermes.reconnect();
    server.refuse = undefined;

    await hermes.switchProfile("work");
    await hermes.idle();
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" });
    expect(server.wsProfiles.at(-1)).toBe("work");
    expect(ids()).toEqual(["work-1", "work-2"]);
    await hermes.close();
  });

  it("remembers the last profile for the next sign-in", async () => {
    const cache = memoryCache();
    const first = await signedIn(cache);
    await first.hermes.switchProfile("work");
    await first.hermes.close();

    const { server, hermes, ids } = await signedIn(cache);
    expect(hermes.getSnapshot().profile).toBe("work");
    expect(server.wsProfiles).toEqual(["work"]);
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("says so when the remembered profile is gone from the server", async () => {
    const { hermes } = await signedIn(memoryCache({ profile: "retired" }));
    expect(hermes.getSnapshot()).toMatchObject({ profile: "retired", chats: [] });
    expect(hermes.getSnapshot().syncError).toMatch(/Couldn't refresh the chat list: .*Profile 'retired' not found/);
  });
});

describe("Switching profile", () => {
  it("shows the switch under way until the new profile's list is read, and only then remembers it", async () => {
    const cache = memoryCache();
    const { server, hermes } = await signedIn(cache);
    const release = holdLists(server);
    await hermes.switchProfile("work");
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected", switching: { from: "default" } });
    expect(cache.profile).toBeUndefined();

    release();
    await hermes.idle();
    expect(hermes.getSnapshot().switching).toBeUndefined();
    expect(cache.profile).toBe("work");
  });

  it("says why when the new profile can't be reached, and goes back when asked", async () => {
    const cache = memoryCache();
    const { server, hermes, ids } = await signedIn(cache);
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    await hermes.switchProfile("work");
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", switching: { from: "default", error: expect.stringMatching(/Connection refused/) } });

    server.refuse = undefined;
    await hermes.switchProfile("default");
    await hermes.idle();
    expect(hermes.getSnapshot()).toMatchObject({ profile: "default", status: "connected" });
    expect(hermes.getSnapshot().switching).toBeUndefined();
    expect(ids()).toEqual(["home-1"]);
    expect(cache.profile).toBe("default");
    await hermes.close();
  });

  it("clears the reason while it tries again, and finishes the switch once it connects", async () => {
    const { server, hermes, ids } = await signedIn();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    await hermes.switchProfile("work");
    server.refuse = undefined;
    const retry = hermes.reconnect();
    expect(hermes.getSnapshot().switching).toEqual({ from: "default" });
    await retry;
    await hermes.idle();
    expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" });
    expect(hermes.getSnapshot().switching).toBeUndefined();
    expect(ids()).toEqual(["work-1", "work-2"]);
  });

  it("says why when the profile is gone from the server, and doesn't remember it", async () => {
    const cache = memoryCache();
    const { hermes } = await signedIn(cache);
    await hermes.switchProfile("retired");
    await hermes.idle();
    expect(hermes.getSnapshot().switching).toEqual({ from: "default", error: expect.stringMatching(/Profile 'retired' not found/) });
    expect(cache.profile).toBeUndefined();
  });

  it("brings back a reply running and an Approval waiting in a profile when the owner switches back to it", async () => {
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Clean up the logs");
    await hermes.sync();
    const { id: requestId } = server.askApproval(server.runtimeIdOf(id)!);
    const card = () => hermes.getSnapshot().chats.find((c) => c.id === id)?.items.find((i) => i.kind === "approval");
    expect(card()).toMatchObject({ id: requestId });

    await hermes.switchProfile("work");
    await hermes.idle();
    expect(hermes.getSnapshot().chats.some((c) => c.id === id)).toBe(false);

    await hermes.switchProfile("default");
    await hermes.idle();
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat.running).toBe(true);
    expect(card()).toMatchObject({ id: requestId });
    expect(card() && "answer" in card()! ? (card() as { answer?: string }).answer : undefined).toBeUndefined();
  });

  it("comes straight back to the old profile over a socket it still listens to", async () => {
    const { server, hermes } = await signedIn();
    await Promise.all([hermes.switchProfile("work"), hermes.switchProfile("default")]);
    await hermes.idle();
    expect(hermes.getSnapshot()).toMatchObject({ profile: "default", status: "connected" });
    expect(server.wsProfiles.at(-1)).toBe("default");
    await expect(hermes.newChat()).resolves.toMatch(/abc123/);
  });

  it("resumes a reply that was running when the connection dropped, once the owner switches back", async () => {
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Summarise the logs");
    await hermes.sync();
    server.refuse = "ssh: connect to host hermes port 22: Connection refused";
    server.drop();
    await hermes.switchProfile("work");
    server.refuse = undefined;
    await hermes.reconnect();
    await hermes.idle();

    await hermes.switchProfile("default");
    await hermes.idle();
    expect(server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toContain(id);
  });

  it("keeps a waiting Approval to bring back when the owner leaves its profile again before its list loads", async () => {
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    await hermes.send(id, "Clean up the logs");
    await hermes.sync();
    const { id: requestId } = server.askApproval(server.runtimeIdOf(id)!);
    await hermes.switchProfile("work");
    await hermes.idle();

    const release = holdLists(server);
    await hermes.switchProfile("default");
    await hermes.switchProfile("work");
    release();
    await hermes.idle();
    await hermes.switchProfile("default");
    await hermes.idle();
    const card = hermes.getSnapshot().chats.find((c) => c.id === id)?.items.find((i) => i.kind === "approval");
    expect(card).toMatchObject({ id: requestId });
  });

  it("doesn't show a search started in the old profile under the new one", async () => {
    const { server, hermes } = await signedIn();
    let answer!: () => void;
    server.rest["GET /api/sessions/search"] = () => new Promise((resolve) => (answer = () => resolve({ results: [{ id: "home-1", title: "Home" }] })));
    const searching = hermes.search("home");
    await hermes.switchProfile("work");
    answer();
    await expect(searching).rejects.toThrow(/work profile/);
  });

  it("doesn't put a chat started in the old profile into the new one's list", async () => {
    const { server, hermes, ids } = await signedIn();
    const create = server.handlers["session.create"];
    let answer!: () => void;
    server.handlers["session.create"] = (r) => void (answer = () => create(r));
    const starting = hermes.newChat();
    // Hermes answers after the switch has begun, before the old socket is let go.
    const switching = hermes.switchProfile("work");
    answer();
    await expect(starting).rejects.toThrow();
    await switching;
    await hermes.idle();
    expect(ids()).toEqual(["work-1", "work-2"]);
  });
});
