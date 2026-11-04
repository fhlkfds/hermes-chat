// Capabilities through the real transport (transport.ts), against FakeHermes as a new Hermes and as Hermes 0.16.0: what
// a connection learns, that its checks only read, that a write Hermes can't take is never sent, that chat still works
// on the older server, that the canonical protocol is still refused, and that a profile switch or a reconnect while a
// check is under way can't let an older connection's answers through.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import { CapabilityUnsupportedError } from "./capabilities";
import { ProtocolMismatchError, connect, type Hermes } from "./transport";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

async function signedIn(server: FakeHermes) {
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  return hermes;
}

/** Waits for the check a connection runs a moment after it opens. */
async function checked(hermes: Hermes) {
  const before = hermes.capabilities.getSnapshot().checkedAt;
  await expectSoon(() => {
    const snap = hermes.capabilities.getSnapshot();
    return !snap.checking && snap.checkedAt !== undefined && snap.checkedAt !== before;
  }, 6000);
}

async function expectSoon(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const writesSent = (server: FakeHermes) => server.restRequests.filter((r: RestRequest) => r.method !== "GET");
const rpcSent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);

describe("capabilities over the transport", () => {
  it("learns what a new Hermes has, reading only", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1)];
    const hermes = await signedIn(server);
    const writesBefore = writesSent(server).length;
    await checked(hermes);
    const snap = hermes.capabilities.getSnapshot();
    expect(snap.facts).toMatchObject({ version: "0.17.0", commit: "74b2ed65e6c1d2a3b4c5d6e7f8091a2b3c4d5e6f", protocol: "legacy", authProviders: ["basic"], flags: ["per_session_exclusive_submit"] });
    for (const id of ["chat", "approvals", "projects", "commands", "liveSessions", "memory", "toolsets", "persona", "skills", "serverFiles", "scheduledJobs", "automations", "outputs"] as const)
      expect(hermes.capabilities.get(id).state, id).toBe("supported");
    // Nothing the check sent wrote: no REST write, and no JSON-RPC method beyond the reads it names.
    expect(writesSent(server).length).toBe(writesBefore);
    for (const m of ["projects.create", "learning.edit", "learning.delete", "command.dispatch", "slash.exec"]) expect(rpcSent(server, m)).toEqual([]);
    // /api/status's path, process id and install id are never kept.
    expect(JSON.stringify(snap)).not.toMatch(/fixture\/\.hermes|4242|install-1f2e/);
  });

  it("finds what Hermes 0.16.0 lacks, and keeps chat working there", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.asOlderHermes();
    const hermes = await signedIn(server);
    await checked(hermes);
    const state = (id: Parameters<Hermes["capabilities"]["get"]>[0]) => hermes.capabilities.get(id).state;
    expect(hermes.capabilities.getSnapshot().facts.version).toBe("0.16.0");
    expect([state("chat"), state("approvals"), state("projects"), state("memory"), state("serverFiles"), state("outputs")]).toEqual([
      "supported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect([state("toolsets"), state("persona"), state("scheduledJobs"), state("automations")]).toEqual(["supported", "supported", "supported", "supported"]);

    // Chat itself: a new chat, a message, and its reply, as on any legacy server.
    const id = await hermes.newChat();
    expect(await hermes.send(id, "Fixture: say hi")).toEqual({ delivery: "accepted" });
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.start");
    server.event(runtime, "message.complete", { text: "Hi.", status: "complete" });
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)!.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
  });

  it("never sends a write for a feature Hermes lacks", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.asOlderHermes();
    const hermes = await signedIn(server);
    await checked(hermes);
    await expect(hermes.projects.create("default", "Fixture")).rejects.toThrow(/doesn't support Projects, so nothing was sent/);
    expect(rpcSent(server, "projects.create")).toEqual([]);
    // Reads still go, so Hermes can still show the feature is there after all.
    await hermes.projects.list("default").catch(() => {});
    expect(rpcSent(server, "projects.list").length).toBeGreaterThan(0);
  });

  it("refuses REST writes for a route Hermes lacks, before they reach the server", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.soulRoutes = false;
    server.cron.missing = true;
    const hermes = await signedIn(server);
    await checked(hermes);
    expect(hermes.capabilities.get("persona").state).toBe("unsupported");
    expect(hermes.capabilities.get("scheduledJobs").state).toBe("unsupported");
    const before = writesSent(server).length;
    await expect(hermes.persona.save("default", { exists: false, content: "" }, "Fixture persona")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(hermes.cron.setPaused("default", { id: "j1" } as never, true)).rejects.toThrow();
    expect(writesSent(server).slice(before)).toEqual([]);
  });

  it("learns about the toolset switches only from Settings → Toolsets' own check", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.toolsetRoutes = "read-only";
    const hermes = await signedIn(server);
    await checked(hermes);
    // Diagnostics can't check it by reading, and sends no PUT itself.
    expect(hermes.capabilities.get("toolsetSwitches").state).toBe("unknown");
    expect(writesSent(server).filter((r) => r.path.startsWith("/api/tools"))).toEqual([]);
    expect(await hermes.toolsets.writeSupport("default")).toMatchObject({ ok: false });
    expect(hermes.capabilities.get("toolsetSwitches")).toMatchObject({ state: "unsupported", source: "observed" });
  });

  it("still refuses the canonical session protocol", async () => {
    const server = new FakeHermes();
    server.readyPayload = { ...server.readyPayload, session_authority: true };
    await expect(connect(server.openPipe)).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("drops a check's answers when the profile changes while it is under way", { timeout: 10_000 }, async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    // The first connection's check of the file browser is held back until after the switch, then answers 404.
    const files = server.rest["GET /api/files"];
    let release!: () => void;
    let first = true;
    server.rest["GET /api/files"] = (req) => {
      if (!first) return files(req);
      first = false;
      return new Promise((_, reject) => (release = () => reject(new Error(`The dashboard answered 404: {"detail":"Not Found"}`))));
    };
    const hermes = await signedIn(server);
    await expectSoon(() => !first, 6000);
    await hermes.switchProfile("work");
    release();
    await checked(hermes);
    expect(server.wsProfiles).toEqual(["default", "work"]);
    // The late 404 was for the old connection, so it settles nothing: the new connection's own check found the route.
    expect(hermes.capabilities.get("serverFiles").state).toBe("supported");
  });

  it("reads again on reconnect, and tells another build apart", { timeout: 15_000 }, async () => {
    const server = new FakeHermes();
    server.asOlderHermes();
    const hermes = await signedIn(server);
    await checked(hermes);
    expect(hermes.capabilities.get("serverFiles").state).toBe("unsupported");
    // Hermes is updated on the server: the connection drops, and the next one finds the new build.
    const updated = new FakeHermes();
    server.health = updated.health;
    server.status = updated.status;
    server.rest["GET /api/health"] = updated.rest["GET /api/health"].bind(updated);
    server.rest["GET /api/files"] = updated.rest["GET /api/files"].bind(updated);
    server.rest["GET /api/fs/list"] = updated.rest["GET /api/fs/list"].bind(updated);
    server.drop("server restarted");
    await expectSoon(() => hermes.getSnapshot().status === "connected", 8000);
    await checked(hermes);
    expect(hermes.capabilities.getSnapshot().facts.version).toBe("0.17.0");
    expect(hermes.capabilities.get("serverFiles").state).toBe("supported");
  });
});
