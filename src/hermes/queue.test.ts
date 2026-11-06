// Queued messages (ADR 0018): lined up while a reply runs, sent by this app one at a time once each reply has ended,
// kept on this computer per connection, profile and chat. These run the real transport against FakeHermes, and the
// real chat cache over a localStorage that outlives a restart, the way App wires them together.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { isOutgoing, QUEUE_LIMIT } from "./model";
import { restartHold, unsaved } from "./unsaved";
import { snapshotDrafts } from "./updates";
import { type Hermes, connect } from "./transport";

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
const SCRIPT = { path: "/home/liam/rotate.sh", name: "rotate.sh", size: 9, kind: "file" as const };

let store: Map<string, string>;
/** While set, writes to localStorage throw, as when it is full. */
let full = false;
beforeEach(() => {
  store = new Map();
  full = false;
  unsaved.clear();
  restartHold.on = false;
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

async function launch(server: FakeHermes, connection = nas) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(connection));
  await hermes.sync();
  return hermes;
}

/** The chat `c1`, open in the app, with a reply running for "Check the disks". */
async function replying() {
  const server = new FakeHermes();
  server.sessions = [row("c1", 0)];
  server.transcripts.c1 = [
    { role: "user", text: "How full is the NAS?", row_id: 1 },
    { role: "assistant", text: "82% used.", row_id: 2 },
  ];
  server.files[SCRIPT.path] = "#!/bin/sh";
  let hermes = await launch(server);
  await hermes.open("c1");
  expect(await hermes.send("c1", "Check the disks")).toEqual({ delivery: "accepted" });
  const h = () => hermes;
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "c1")!;
  const runtime = () => chat().runtimeId!;
  const ctx = {
    server,
    hermes: h,
    chat,
    queue: () => hermes.getSnapshot().queues.c1,
    texts: () => hermes.getSnapshot().queues.c1?.items.map((i) => i.text) ?? [],
    /** The prompts that reached Hermes after the first, in order. */
    sent: () =>
      server.requests
        .filter((r) => r.method === "prompt.submit")
        .slice(1)
        .map((r) => r.params),
    stream: (text: string) => {
      server.event(runtime(), "message.start");
      server.event(runtime(), "message.delta", { text });
    },
    finish: async (payload: Record<string, unknown> = { status: "complete" }) => {
      server.event(runtime(), "message.complete", payload);
      await flush();
    },
    /** Closes the app and launches it again on the same computer. */
    relaunch: async () => {
      await hermes.close();
      hermes = await launch(server);
      return hermes;
    },
  };
  ctx.stream("Checking");
  return ctx;
}

describe("Queueing while a reply streams", () => {
  it("sends two queued messages in order, one per finished reply, each once, asking Hermes to hold rather than interrupt", async () => {
    const q = await replying();
    expect(q.hermes().enqueue("c1", "Then the SMART data")).toBeUndefined();
    expect(q.hermes().enqueue("c1", "Then the RAID")).toBeUndefined();
    await flush();
    expect(q.sent()).toEqual([]);
    expect(q.texts()).toEqual(["Then the SMART data", "Then the RAID"]);

    await q.finish();
    expect(q.sent()).toEqual([expect.objectContaining({ text: "Then the SMART data", queued: true })]);
    expect(q.texts()).toEqual(["Then the RAID"]);
    expect(q.chat()).toMatchObject({ running: true });

    q.stream("SMART ok");
    await flush();
    expect(q.sent()).toHaveLength(1);
    await q.finish();
    expect(q.sent().map((p) => p.text)).toEqual(["Then the SMART data", "Then the RAID"]);
    expect(q.queue()).toBeUndefined();

    await q.finish();
    expect(q.sent()).toHaveLength(2);
    // Each shows once in the chat, confirmed.
    expect(
      q
        .chat()
        .items.filter((i) => i.kind === "user" && i.text.startsWith("Then"))
        .map((i) => i.kind === "user" && !i.outgoing),
    ).toEqual([true, true]);
  });

  it("sends a queued message's files with it", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "Run this", [SCRIPT]);
    await q.finish();
    const fileAttach = q.server.requests.filter((r) => r.method === "file.attach");
    expect(fileAttach.map((r) => r.params.name)).toEqual(["rotate.sh"]);
    expect(q.sent()[0].text).toMatch(/rotate\.sh[\s\S]*Run this$/);
  });

  it("edits, reorders and removes queued messages before they go", async () => {
    const q = await replying();
    for (const t of ["one", "two", "three"]) q.hermes().enqueue("c1", t);
    const [one, two, three] = q.queue()!.items;
    expect(q.hermes().editQueued("c1", two.id, "two, edited")).toBe(true);
    q.hermes().moveQueued("c1", three.id, 0);
    q.hermes().moveQueued("c1", three.id, -1); // already first
    q.hermes().moveQueued("c1", one.id, 7);
    expect(q.texts()).toEqual(["three", "two, edited", "one"]);
    q.hermes().removeQueued("c1", one.id);
    expect(q.texts()).toEqual(["three", "two, edited"]);
    expect(q.queue()!.items.map((i) => i.id)).toEqual([three.id, two.id]);
    // Empty words with no files would send nothing.
    expect(q.hermes().editQueued("c1", two.id, "  ")).toBe(false);
    await q.finish();
    expect(q.sent().map((p) => p.text)).toEqual(["three"]);
  });

  it("holds the queue while a message in it is being edited", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "draft");
    const release = q.hermes().holdQueue("c1");
    await q.finish();
    expect(q.sent()).toEqual([]);
    q.hermes().editQueued("c1", q.queue()!.items[0].id, "final");
    release();
    release(); // twice is once
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["final"]);
  });

  it("pauses and resumes: nothing goes while paused, the next goes once resumed", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "later");
    q.hermes().pauseQueue("c1");
    await q.finish();
    expect(q.sent()).toEqual([]);
    expect(q.queue()).toMatchObject({ paused: "You paused it." });
    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["later"]);
  });

  it("refuses more than the limit, and nothing empty", async () => {
    const q = await replying();
    for (let i = 0; i < QUEUE_LIMIT; i++) expect(q.hermes().enqueue("c1", `m${i}`)).toBeUndefined();
    expect(q.hermes().enqueue("c1", "one too many")).toMatch(/up to 20 messages/);
    expect(q.hermes().enqueue("c1", "  ")).toMatch(/nothing to queue/);
    expect(q.queue()!.items).toHaveLength(QUEUE_LIMIT);
  });
});

describe("The queue pauses when the owner should look first", () => {
  it("after Stop: the stopped reply's next message waits", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "next");
    await q.hermes().stop("c1");
    await q.finish({ status: "interrupted", text: "Checking" });
    expect(q.sent()).toEqual([]);
    expect(q.queue()).toMatchObject({ paused: expect.stringContaining("stopped") });
  });

  it("after a reply Hermes asked an Approval in", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "next");
    const { id } = q.server.askApproval(q.chat().runtimeId!);
    await flush();
    await q.hermes().answerApproval("c1", id!, "once");
    await q.finish();
    expect(q.sent()).toEqual([]);
    expect(q.queue()).toMatchObject({ paused: expect.stringContaining("Approval") });
  });

  it("after a reply that failed", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "next");
    await q.finish({ status: "error", failure_reason: "rate limited" });
    expect(q.sent()).toEqual([]);
    expect(q.queue()).toMatchObject({ paused: expect.stringContaining("failed") });
  });

  it("when Hermes refuses a queued message: it becomes a Failed message with Retry, and the rest wait", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "first");
    q.hermes().enqueue("c1", "second");
    q.server.rejectPrompt = { code: 4009, message: "session busy" };
    await q.finish();
    await flush();
    expect(q.chat().items.filter(isOutgoing)).toMatchObject([{ text: "first", outgoing: { state: "failed", reason: "session busy" } }]);
    expect(q.texts()).toEqual(["second"]);
    expect(q.queue()!.paused).toMatch(/didn't go/);
    // Resuming with the Failed message still there sends nothing: it is settled first.
    q.server.rejectPrompt = undefined;
    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent()).toHaveLength(1);
    q.hermes().dismiss("c1", q.chat().items.find(isOutgoing)!.id);
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("when a queued file has gone missing: Failed with its file kept for Retry, and the queue paused", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "Run this", [SCRIPT]);
    delete q.server.files[SCRIPT.path];
    await q.finish();
    await flush();
    expect(q.chat().items.filter(isOutgoing)).toMatchObject([
      { text: "Run this", outgoing: { state: "failed", reason: expect.stringContaining("Couldn't attach rotate.sh"), attachments: [SCRIPT] } },
    ]);
    expect(q.sent()).toEqual([]);
  });
});

describe("Uncertain sends, reconnects and restarts", () => {
  it("a drop after a queued message went out and before Hermes answered: no automatic second copy, before or after reconnecting", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "first");
    q.hermes().enqueue("c1", "second");
    q.server.dropOnPrompt = "stored";
    await q.finish();
    await flush();
    expect(q.chat().items.filter(isOutgoing)).toMatchObject([{ text: "first", outgoing: { state: "unknown" } }]);
    expect(q.queue()!.paused).toBeDefined();

    await q.hermes().reconnect();
    await q.hermes().idle();
    await flush();
    // The history has it, so it shows from there; nothing went again, and "second" waits for the owner.
    expect(q.chat().items.some(isOutgoing)).toBe(false);
    expect(q.server.transcripts.c1.filter((m) => m.text === "first")).toHaveLength(1);
    expect(q.sent().map((p) => p.text)).toEqual(["first"]);
    expect(q.texts()).toEqual(["second"]);

    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("a restart with a queued message whose send is unknown: the history settles it, the queue comes back paused, nothing goes twice", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "first");
    q.hermes().enqueue("c1", "second");
    // Hermes stores it, then the app closes before the answer.
    q.server.handlers["prompt.submit"] = (r) =>
      q.server.storeMessage(q.server.runtime.get(String(r.params.session_id))!, { role: "user", text: String(r.params.text), row_id: 3 });
    await q.finish();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["first"]);
    q.server.handlers["prompt.submit"] = new FakeHermes().handlers["prompt.submit"].bind(q.server);

    const hermes = await q.relaunch();
    expect(hermes.getSnapshot().queues.c1).toMatchObject({ items: [{ text: "second" }], paused: expect.stringContaining("closed") });
    await hermes.idle();
    await flush();
    expect(q.chat().items.some(isOutgoing)).toBe(false);
    expect(q.sent().map((p) => p.text)).toEqual(["first"]);

    hermes.resumeQueue("c1");
    await hermes.idle();
    await flush();
    await hermes.idle();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("a queued message never sent survives a restart with its files, and goes only once resumed", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "Run this", [SCRIPT]);
    const hermes = await q.relaunch();
    expect(hermes.getSnapshot().queues.c1).toMatchObject({ items: [{ text: "Run this", attachments: [SCRIPT] }], paused: expect.any(String) });
    await flush();
    expect(q.sent()).toEqual([]);
    hermes.resumeQueue("c1");
    // The chat isn't loaded on this connection yet: it is loaded first, then the message goes.
    await hermes.idle();
    await flush();
    await hermes.idle();
    expect(q.sent().map((p) => p.text)).toEqual([expect.stringContaining("Run this")]);
  });
});

describe("Review findings", () => {
  it("storage full as one queued message would go: it stays queued, unsent, and nothing reaches Hermes", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "only one");
    full = true;
    await q.finish();
    expect(q.sent()).toEqual([]);
    expect(q.chat().items.some(isOutgoing)).toBe(false);
    expect(q.queue()).toMatchObject({ items: [{ text: "only one" }], paused: expect.stringContaining("storage is full") });
    // Storage itself, as a cold start would read it, still has the queue as it was, so a crash now loses nothing.
    const raw = [...store].filter(([k]) => k.startsWith("hermes-chat.queue."));
    expect(raw.map(([, v]) => JSON.parse(v).items.map((i: { text: string }) => i.text))).toEqual([["only one"]]);
    expect([...store.keys()].some((k) => k.startsWith("hermes-chat.outbox."))).toBe(false);
    full = false;
    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["only one"]);
  });

  it("storage full with more queued: the queue can't let go of the next one, so it isn't sent", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "first");
    q.hermes().enqueue("c1", "second");
    full = true;
    await q.finish();
    expect(q.sent()).toEqual([]);
    expect(q.texts()).toEqual(["first", "second"]);
    expect(q.queue()!.paused).toMatch(/storage is full/);
    // Leaves nothing held in memory for the next test.
    full = false;
    for (const i of q.queue()!.items) q.hermes().removeQueued("c1", i.id);
  });

  it("an update's restart holds every queue from its snapshot on, so the restarted app can't send one twice", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "first");
    snapshotDrafts(localStorage);
    await q.finish();
    expect(q.sent()).toEqual([]);
    expect(q.texts()).toEqual(["first"]);
  });

  it("a queued message Hermes holds behind another client's turn pauses the queue: no turn's end sends the next", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "A");
    q.hermes().enqueue("c1", "B");
    const base = q.server.handlers["prompt.submit"];
    q.server.handlers["prompt.submit"] = (r) => q.server.respond(r.id, { status: "queued" });
    await q.finish();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    expect(q.queue()).toMatchObject({ items: [{ text: "B" }], paused: expect.stringContaining("held") });
    q.server.handlers["prompt.submit"] = base;
    // The other client's turn, then A's own, start and end: B still waits for the owner.
    q.stream("other");
    await q.finish();
    q.stream("A's answer");
    await q.finish();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A", "B"]);
  });

  it("the held pause outlasts an empty queue: a message queued after the held one waits for Resume too", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "A");
    const base = q.server.handlers["prompt.submit"];
    q.server.handlers["prompt.submit"] = (r) => q.server.respond(r.id, { status: "queued" });
    await q.finish();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    q.server.handlers["prompt.submit"] = base;
    q.hermes().enqueue("c1", "B");
    expect(q.queue()).toMatchObject({ items: [{ text: "B" }], paused: expect.stringContaining("held") });
    q.stream("other");
    await q.finish();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    q.hermes().resumeQueue("c1");
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A", "B"]);
  });

  it("a turn that ends while Hermes's answer for a held message is on its way doesn't send the next", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "A");
    q.hermes().enqueue("c1", "B");
    let answer = () => {};
    q.server.handlers["prompt.submit"] = (r) => void (answer = () => q.server.respond(r.id, { status: "queued" }));
    await q.finish();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    // Another client's turn ends first, then Hermes answers that it holds A.
    q.stream("other");
    await q.finish();
    answer();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    expect(q.queue()).toMatchObject({ items: [{ text: "B" }], paused: expect.stringContaining("held") });
  });

  it("Hermes answers it holds a queued message, then the connection drops: nothing stays running, nothing goes on its own", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "A");
    q.hermes().enqueue("c1", "B");
    q.server.handlers["prompt.submit"] = (r) => {
      q.server.respond(r.id, { status: "queued" });
      q.server.drop();
    };
    await q.finish();
    await flush();
    q.server.handlers["prompt.submit"] = new FakeHermes().handlers["prompt.submit"].bind(q.server);
    await q.hermes().reconnect();
    await q.hermes().idle();
    await flush();
    expect(q.chat().running).toBeFalsy();
    expect(q.queue()).toMatchObject({ items: [{ text: "B" }], paused: expect.any(String) });
    expect(q.sent().map((p) => p.text)).toEqual(["A"]);
    q.hermes().resumeQueue("c1");
    await q.hermes().idle();
    await flush();
    expect(q.sent().map((p) => p.text)).toEqual(["A", "B"]);
  });
});

describe("Isolation", () => {
  it("switching profile never sends a queued message in the other profile, and switching back shows it, paused", async () => {
    const q = await replying();
    q.server.otherProfiles = { work: [row("w1", 0, { title: "Work chat" })] };
    q.hermes().enqueue("c1", "default only");
    const runtime = q.chat().runtimeId!;
    await q.hermes().switchProfile("work");
    await q.hermes().idle();
    expect(q.hermes().getSnapshot().queues).toEqual({});
    // The old profile's reply ends meanwhile: nothing of it reaches the profile shown.
    q.server.event(runtime, "message.complete", { status: "complete" });
    await flush();
    expect(q.sent()).toEqual([]);

    await q.hermes().switchProfile("default");
    await q.hermes().idle();
    expect(q.hermes().getSnapshot().queues.c1).toMatchObject({ items: [{ text: "default only" }], paused: expect.any(String) });
    expect(q.sent()).toEqual([]);
  });

  it("another connection on this computer doesn't see the queue", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "nas only");
    expect(localChatCache(nas).loadQueues("default").c1.items).toHaveLength(1);
    expect(localChatCache({ ...nas, sshTarget: "liam@other" }).loadQueues("default")).toEqual({});
    expect(localChatCache({ ...nas, username: "someone" }).loadQueues("default")).toEqual({});
  });

  it("deleting the chat discards its queue", async () => {
    const q = await replying();
    q.hermes().enqueue("c1", "never");
    q.hermes().pauseQueue("c1");
    await q.finish();
    expect(await q.hermes().delete("c1")).toBe(true);
    expect(localChatCache(nas).loadQueues("default")).toEqual({});
  });
});

describe("Storage", () => {
  it("when storage is full, the queue is kept for this run, says so, and an update's restart still keeps it", async () => {
    const q = await replying();
    full = true;
    q.hermes().enqueue("c1", "can't be saved");
    expect(q.queue()).toMatchObject({ items: [{ text: "can't be saved" }], unsaved: true });
    const snapshot = JSON.parse(snapshotDrafts(localStorage));
    const key = Object.keys(snapshot).find((k) => k.startsWith("hermes-chat.queue."))!;
    expect(JSON.parse(snapshot[key]).items[0].text).toBe("can't be saved");
    // Kept in memory across a profile switch, too.
    q.server.otherProfiles = { work: [] };
    await q.hermes().switchProfile("work");
    await q.hermes().switchProfile("default");
    expect(q.hermes().getSnapshot().queues.c1).toMatchObject({ items: [{ text: "can't be saved" }], unsaved: true });
    // Once storage takes a write again, it is saved as usual.
    full = false;
    q.hermes().editQueued("c1", q.hermes().getSnapshot().queues.c1.items[0].id, "saved now");
    expect(q.hermes().getSnapshot().queues.c1).not.toHaveProperty("unsaved");
    q.hermes().removeQueued("c1", q.hermes().getSnapshot().queues.c1.items[0].id);
    expect(localChatCache(nas).loadQueues("default")).toEqual({});
  });

  it("a malformed kept queue loads as nothing", () => {
    store.set(`hermes-chat.queue.${JSON.stringify(["ssh", "liam@hermes", "liam", "default", "c1"])}`, "{not json");
    store.set(
      `hermes-chat.queue.${JSON.stringify(["ssh", "liam@hermes", "liam", "default", "c2"])}`,
      JSON.stringify({ items: [{ id: 1 }, { id: "a", text: "ok" }] }),
    );
    expect(localChatCache(nas).loadQueues("default")).toEqual({ c2: { items: [{ id: "a", text: "ok" }] } });
  });
});

describe("Sending directly is unchanged", () => {
  it("a chat with nothing queued sends as before, without asking Hermes to hold it", async () => {
    const server = new FakeHermes();
    server.sessions = [row("c1", 0)];
    const hermes: Hermes = await launch(server);
    await hermes.open("c1");
    await hermes.send("c1", "Hello");
    expect(server.requests.find((r) => r.method === "prompt.submit")!.params).not.toHaveProperty("queued");
  });
});
