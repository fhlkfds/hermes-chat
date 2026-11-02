import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { inboxAcks, inboxEntries, needsOwner, type InboxEntry } from "./inbox";
import type { OutgoingItem } from "./model";
import { connect, type Hermes } from "./transport";

const nowS = () => Date.now() / 1000;
const unreadRow = (id: string, minutesAgo = 1, over = {}) => row(id, minutesAgo / 1440, { last_read_at: 0, ...over });

/** What the inbox shows for the app's snapshot now. */
const inbox = (hermes: Hermes) => {
  const s = hermes.getSnapshot();
  return inboxEntries({ profile: s.profile, chats: s.chats, connected: s.status === "connected", others: s.others, live: s.live });
};
const brief = (e: InboxEntry) => `${e.kind}${e.ended ? " (ended)" : ""} ${e.profile}/${e.chatId}${e.stale ? " stale" : ""}`;

/** Signed in to `default`, on a server that also has the `work` and `ops` profiles. */
async function signedIn(cache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [row("home-1", 1, { last_read_at: nowS() })];
  server.otherProfiles = {
    work: [unreadRow("work-done"), row("work-busy", 0, { last_read_at: nowS() }), row("work-asks", 0, { last_read_at: nowS() })],
    ops: [row("ops-1", 1, { last_read_at: nowS() })],
  };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  return { server, hermes, cache };
}

/** A new chat in the shown profile with a reply under way. */
async function replying(server: FakeHermes, hermes: Hermes) {
  const id = await hermes.newChat();
  await hermes.send(id, "Clean up the logs");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  return { id, runtime };
}

function storage() {
  const items: Record<string, string> = {};
  return { items, getItem: (k: string) => items[k] ?? null, setItem: (k: string, v: string) => void (items[k] = v) };
}

afterEach(() => void vi.useRealTimers());

describe("The inbox", () => {
  it("shows work finished and asking for approval in background profiles, each with its profile, chat and time", async () => {
    const { server, hermes } = await signedIn();
    const busyAt = nowS() - 5;
    server.liveSessions = [
      { id: "rt-x", session_key: "work-busy", status: "working", last_active: busyAt },
      { id: "rt-y", session_key: "work-asks", status: "waiting", last_active: busyAt },
      // Sitting idle isn't anything the owner needs to know.
      { id: "rt-z", session_key: "ops-1", status: "idle", last_active: busyAt },
    ];
    await hermes.checkOtherProfiles();

    const { entries, unmatched } = inbox(hermes);
    expect(entries.map(brief)).toEqual(["approval work/work-asks", "completed work/work-done", "running work/work-busy"]);
    expect(unmatched).toBe(0);
    expect(entries[0]).toMatchObject({ title: "Chat work-asks", at: busyAt * 1000, summary: expect.stringContaining("waiting for your answer") });
    expect(entries[1]).toMatchObject({ title: "Chat work-done", at: expect.any(Number) });
    expect(entries.filter(needsOwner).length).toBe(2);
    // Reading the server for the inbox resumed, answered or marked nothing.
    expect(server.requests.map((r) => r.method).filter((m) => m !== "client.capabilities")).toEqual(["session.active_list"]);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(server.responses).toEqual([]);
  });

  it("lists every Approval waiting in one chat, and says when Hermes stops waiting on one", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const first = server.askApproval(runtime);
    const second = server.askApproval(runtime, { request_id: "apr-two", command: "shutdown now" });

    expect(inbox(hermes).entries.filter((e) => e.kind === "approval").map((e) => e.itemId)).toEqual([first.id, second.id]);
    expect(inbox(hermes).entries.find((e) => e.kind === "running")).toMatchObject({ chatId: id });

    server.cancelRequest(first.id!, "timeout");
    const approvals = inbox(hermes).entries.filter((e) => e.kind === "approval");
    expect(approvals.map((e) => [e.itemId, !!e.ended, needsOwner(e)])).toEqual([
      [first.id, true, false],
      [second.id, false, true],
    ]);
    // The inbox never quotes the command.
    expect(JSON.stringify(inbox(hermes).entries)).not.toMatch(/rm -rf|shutdown/);
  });

  it("shows each Approval once after reconnects replay it, and never brings back one that expired", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id: chatId, runtime } = await replying(server, hermes);
    server.transcripts[chatId] = [{ role: "user", text: "Clean up the logs" }];
    const waiting = server.askApproval(runtime);
    const expired = server.askApproval(runtime, { request_id: "apr-old" });
    const asked = server.openRequests.get(expired.id!)!;
    server.cancelRequest(expired.id!, "timeout");
    // Hermes lists the expired one again when the chat resumes.
    server.openRequests.set(expired.id!, asked);
    const keys = () => inbox(hermes).entries.filter((e) => e.kind === "approval").map((e) => `${e.key}${e.ended ? " ended" : ""}`);
    expect(keys()).toEqual([`approval default ${chatId} ${waiting.requestId}`, `approval default ${chatId} apr-old ended`]);

    for (let i = 0; i < 3; i++) {
      server.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      await hermes.idle();
    }

    // The waiting one shows once, under the same key; the expired one's card is gone, not back to waiting.
    expect(keys()).toEqual([`approval default ${chatId} ${waiting.requestId}`]);
    expect(inbox(hermes).entries.filter(needsOwner).map((e) => e.itemId)).toEqual([waiting.id]);
  });

  it("keeps a dismissal through reconnects, and shows the entry again only for something newer", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    await hermes.checkOtherProfiles();
    const acks = inboxAcks(storage(), "server");
    const shown = () => inbox(hermes).entries.filter((e) => !acks.isDismissed(e));
    for (const e of shown().filter((e) => e.kind !== "running")) acks.dismiss(e);
    expect(shown().map(brief)).toEqual([expect.stringMatching(/^running default\//)]);

    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(shown().filter((e) => e.kind !== "running")).toEqual([]);

    // New activity in the chat dismissed as completed brings it back.
    server.otherProfiles.work[0].last_active = nowS() + 60;
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(shown().map(brief)).toContain("completed work/work-done");
  });

  it("dismisses the entry only: the chat stays Unread, Active or Settled, and as archived as it was", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(unreadRow("home-unread", 1, { pinned: true }));
    await hermes.sync();
    const chatBefore = hermes.getSnapshot().chats.find((c) => c.id === "home-unread");
    const acks = inboxAcks(storage(), "server");
    const entry = inbox(hermes).entries.find((e) => e.chatId === "home-unread")!;
    expect(entry).toMatchObject({ kind: "completed", profile: "default" });

    acks.dismiss(entry);
    await hermes.sync();
    expect(hermes.getSnapshot().chats.find((c) => c.id === "home-unread")).toEqual(chatBefore);
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(acks.isDismissed(inbox(hermes).entries.find((e) => e.chatId === "home-unread")!)).toBe(true);
  });

  it("tells failed messages from ones Hermes may have, in profiles not shown too", async () => {
    const cache = memoryCache();
    const failed: OutgoingItem = { kind: "user", id: "u-1", text: "hi", outgoing: { state: "failed", reason: "session busy" } };
    const unsure: OutgoingItem = { kind: "user", id: "u-2", text: "deploy", outgoing: { state: "unknown", reason: "dropped" } };
    cache.saveOutbox("work", "work-busy", [failed, unsure]);
    const { hermes } = await signedIn(cache);
    await hermes.checkOtherProfiles();

    const sends = inbox(hermes).entries.filter((e) => e.kind === "failed" || e.kind === "uncertain");
    expect(sends.map((e) => [e.kind, e.profile, e.chatId, e.title, e.itemId])).toEqual([
      ["failed", "work", "work-busy", "Chat work-busy", "u-1"],
      ["uncertain", "work", "work-busy", "Chat work-busy", "u-2"],
    ]);
    expect(sends[1].summary).toBe("A message you sent may not have reached Hermes.");
  });

  it("keeps the title of a new chat whose first message failed, after switching away", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes.send(id, "Draft the email");
    await hermes.switchProfile("work");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.find((e) => e.kind === "failed")).toMatchObject({ profile: "default", chatId: id, title: "Draft the email" });
  });

  it("marks what it last saw from Hermes while the live check fails", async () => {
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-x", session_key: "work-busy", status: "working", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.handlers["session.active_list"] = (r) => server.fail(r.id, 5000, "store busy");
    vi.useFakeTimers({ now: Date.now() + 20_000 });
    await hermes.checkOtherProfiles();

    expect(hermes.getSnapshot().live).toMatchObject({ error: "store busy", checkedAt: expect.any(Number) });
    expect(inbox(hermes).entries.map(brief)).toEqual(["completed work/work-done", "running work/work-busy stale"]);
  });

  it("marks what it last saw from a profile it couldn't check, and puts no live session with a chat meanwhile", async () => {
    const { server, hermes } = await signedIn();
    server.liveSessions = [{ id: "rt-x", session_key: "work-busy", status: "working", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    const list = server.rest["GET /api/sessions"];
    server.rest["GET /api/sessions"] = (req) => {
      if (req.query.get("profile") === "ops") throw new Error("The dashboard answered 503: busy");
      return list(req);
    };
    vi.useFakeTimers({ now: Date.now() + 20_000 });
    await hermes.checkOtherProfiles();

    expect(hermes.getSnapshot().others.byName.ops.error).toContain("503");
    // ops might hold a copy of the same session id, so the running session isn't put with work's chat on a guess.
    const { entries, unmatched } = inbox(hermes);
    expect(entries.map(brief)).toEqual(["completed work/work-done"]);
    expect(unmatched).toBe(1);

    server.rest["GET /api/sessions"] = (req) => {
      if (req.query.get("profile") === "work") throw new Error("The dashboard answered 503: busy");
      return list(req);
    };
    vi.setSystemTime(Date.now() + 20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.map(brief)).toEqual(["completed work/work-done stale"]);
  });

  it("puts a session this app started with its own profile by its runtime id, though a copied profile lists the same id", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.otherProfiles.ops.push(row(id, 0, { title: "A copy" }));
    await hermes.switchProfile("work");
    await hermes.idle();
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();

    expect(inbox(hermes).entries.filter((e) => e.chatId === id).map(brief)).toEqual([`approval default/${id}`]);
  });

  it("goes by the chat on screen, not by an older check, once an Approval there has expired", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    const asked = server.askApproval(runtime);
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.cancelRequest(asked.id!, "timeout");

    expect(inbox(hermes).entries.filter((e) => e.chatId === id && needsOwner(e))).toEqual([]);
  });

  it("shows an Approval once while the connection is down, though a check from before says its chat waits", async () => {
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() }];
    await hermes.checkOtherProfiles();
    server.refuse = "Connection refused";
    server.drop();

    expect(inbox(hermes).entries.filter((e) => e.chatId === id).map(brief)).toEqual([`approval default/${id} stale`]);
  });

  it("keeps an Approval dismissed after switching away, when only a check says its chat waits", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.askApproval(runtime);
    const acks = inboxAcks(storage(), "server");
    acks.dismiss(inbox(hermes).entries.find((e) => e.kind === "approval" && e.chatId === id)!);

    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.switchProfile("work");
    await hermes.idle();
    server.liveSessions = [{ id: runtime, session_key: id, status: "waiting", last_active: nowS() - 1 }];
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    const waiting = () => inbox(hermes).entries.find((e) => e.key === `waiting default ${id}`)!;
    expect(acks.isDismissed(waiting())).toBe(true);

    // Waiting again since then shows again.
    server.liveSessions[0].last_active = nowS() + 5;
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(acks.isDismissed(waiting())).toBe(false);
  });

  it("keeps a failure seen in a profile after switching away from it, pointing at its error", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    const { id, runtime } = await replying(server, hermes);
    server.event(runtime, "message.complete", { status: "error", failure_reason: "provider timed out", text: "" });
    const failed = inbox(hermes).entries.find((e) => e.kind === "failed")!;
    expect(failed).toMatchObject({ profile: "default", chatId: id, itemId: expect.stringMatching(/^e-/) });

    await hermes.switchProfile("work");
    await hermes.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    await hermes.checkOtherProfiles();
    expect(inbox(hermes).entries.find((e) => e.kind === "failed")).toMatchObject({ key: failed.key, itemId: failed.itemId });
    expect(JSON.stringify(hermes.getSnapshot().others)).not.toContain("provider timed out");
  });

  it("asks a server without session.active_list no more, and says so", async () => {
    const { server, hermes } = await signedIn();
    server.handlers["session.active_list"] = (r) => server.fail(r.id, -32601, "method not found");
    await hermes.checkOtherProfiles();
    expect(hermes.getSnapshot().live).toEqual({ sessions: [], unsupported: true });

    vi.useFakeTimers({ now: Date.now() + 60_000 });
    await hermes.checkOtherProfiles();
    expect(server.requests.filter((r) => r.method === "session.active_list")).toHaveLength(1);
  });

  it("asks Hermes at most once in 15 seconds, and drops an answer from a connection that has since dropped", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    let answer: (() => void) | undefined;
    server.handlers["session.active_list"] = (r) => (answer = () => server.respond(r.id, { sessions: [{ session_key: "work-busy", status: "working", last_active: nowS() }] }));
    const first = hermes.checkOtherProfiles();
    void hermes.checkOtherProfiles();
    expect(server.requests.filter((r) => r.method === "session.active_list")).toHaveLength(1);

    server.drop();
    answer!();
    await first;
    expect(hermes.getSnapshot().live).toBeUndefined();
  });

  it("leaves out a live session it can't put with exactly one chat, and counts it", async () => {
    const { server, hermes } = await signedIn();
    // A copied profile can hold the same stored session ids.
    server.otherProfiles.ops.push(row("work-busy", 0));
    server.liveSessions = [
      { id: "rt-1", session_key: "work-busy", status: "working", last_active: nowS() },
      { id: "rt-2", session_key: "somewhere-else", status: "waiting", last_active: nowS() },
    ];
    await hermes.checkOtherProfiles();
    const { entries, unmatched } = inbox(hermes);
    expect(entries.filter((e) => e.kind === "running" || e.kind === "approval")).toEqual([]);
    expect(unmatched).toBe(2);
  });

  it("forgets dismissals after 30 days", () => {
    let now = 1_000_000;
    const store = storage();
    const acks = inboxAcks(store, "server", () => now);
    const e = { key: "completed work a", kind: "completed", profile: "work", chatId: "a", title: "a", at: 5, summary: "" } as InboxEntry;
    acks.dismiss(e);
    expect(inboxAcks(store, "server", () => now).isDismissed(e)).toBe(true);
    // Another server's dismissals are its own.
    expect(inboxAcks(store, "other", () => now).isDismissed(e)).toBe(false);

    // Expired on load, and in the store already open, without another dismissal first.
    now += 31 * 86_400_000;
    expect(acks.isDismissed(e)).toBe(false);
    expect(inboxAcks(store, "server", () => now).isDismissed(e)).toBe(false);
  });
});
