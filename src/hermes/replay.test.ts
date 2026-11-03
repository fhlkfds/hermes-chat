// Edit and Regenerate (issue #63, ADR 0032), run through the real transport against FakeHermes: each makes a branch
// through the owner's message and sends the message again in place of its copy there, and the chat it came from is
// never written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import type { Item } from "./model";
import { replaySource, replaysOf, replyAfter, splitRefs } from "./replay";
import { connect, type Hermes } from "./transport";

/**
 * A chat "c1" as Hermes stores it: a hidden project instruction, a question answered after a tool call, a message sent
 * with two files (one gone), and a last exchange.
 */
async function chatWithHistory(over: { server?: FakeHermes; cache?: Parameters<typeof connect>[2] } = {}) {
  const server = over.server ?? new FakeHermes();
  server.sessions = [row("c1", 0.1, { title: "Backup plan", pinned: true }), row("c2", 0.4, { title: "Router photo", pinned: true })];
  server.serverDirs.add("/srv/uploads");
  server.serverFiles["/srv/uploads/policy.md"] = "# Policy";
  server.storeMessage("c1", { role: "user", text: 'Instructions for this chat from the project "Homelab".', display_kind: "hidden" });
  server.storeMessage("c1", { role: "user", text: "Which folders should the backup cover?" });
  server.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
  server.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", context: "ls /srv", result: "photos documents" });
  server.storeMessage("c1", { role: "assistant", text: "Cover /srv/photos and /srv/documents." });
  server.storeMessage("c1", { role: "user", text: "How long should we keep snapshots?" });
  server.storeMessage("c1", { role: "assistant", text: "Keep 14 daily snapshots." });
  server.storeMessage("c1", { role: "user", text: "@file:/srv/uploads/policy.md @file:/srv/uploads/gone.csv\n\nDoes this policy match?" });
  server.storeMessage("c1", { role: "assistant", text: "Mostly: it keeps 7 daily snapshots." });
  server.storeMessage("c2", { role: "user", text: "[image] What router is this?" });
  server.storeMessage("c2", { role: "assistant", text: "A four-port home router." });
  const hermes = await connect(server.openPipe, undefined, over.cache ?? memoryCache());
  await hermes.sync();
  await hermes.open("c1");
  await hermes.idle();
  const chat = (id = "c1") => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const itemWith = (text: string, id = "c1") => chat(id).items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.text.includes(text))!.id;
  const branches = () => server.sessions.filter((s) => s.parent_session_id === "c1");
  return { server, hermes, chat, itemWith, branches };
}

const texts = (items: Item[]) => items.flatMap((i) => (i.kind === "user" || i.kind === "assistant" ? [`${i.kind}: ${i.text}`] : []));
const stored = (server: FakeHermes, id: string) => server.transcripts[id].map((m) => `${m.role}${m.display_kind === "hidden" ? " (hidden)" : ""}: ${m.text}`);

/** Hermes ends the reply running in `chatId`'s branch with `text`, and stores it, as a real turn would. */
async function answer(server: FakeHermes, hermes: Hermes, chatId: string, text: string) {
  server.storeMessage(chatId, { role: "assistant", text });
  server.event(server.runtimeIdOf(chatId)!, "message.complete", { text, status: "complete" });
  await hermes.idle();
}

describe("Edit and Regenerate: the pieces", () => {
  it("finds the owner's message a reply answers, past the reply's earlier segments and tool calls", () => {
    const items: Item[] = [
      { kind: "user", id: "u1", text: "Check the disk" },
      { kind: "assistant", id: "a1", text: "Let me look." },
      { kind: "tool", id: "t1", name: "terminal", status: "done" },
      { kind: "assistant", id: "a2", text: "It's 81% full." },
      { kind: "user", id: "u2", text: "Thanks", outgoing: { state: "failed" } },
    ];
    expect(replaySource(items, "a2", "regenerate")).toEqual({ sourceId: "u1" });
    expect(replaySource(items, "a1", "regenerate")).toEqual({ sourceId: "u1" });
    expect(replaySource(items, "u1", "edit")).toEqual({ sourceId: "u1" });
    // A failed send keeps its own Edit, which takes its words back into the composer.
    expect(replaySource(items, "u2", "edit")).toHaveProperty("error");
    expect(replaySource([{ kind: "assistant", id: "a", text: "Hello" }], "a", "regenerate")).toHaveProperty("error");
  });

  it("keeps the file refs a message starts with apart from its words", () => {
    expect(splitRefs("@file:/a.md\n@file:`/b c.md`\n\nCompare")).toEqual({ refs: "@file:/a.md\n@file:`/b c.md`\n\n", words: "Compare" });
    expect(splitRefs("Compare")).toEqual({ refs: "", words: "Compare" });
    // A ref in the middle of the words is part of them.
    expect(splitRefs("Compare @file:/a.md with last week")).toEqual({ refs: "", words: "Compare @file:/a.md with last week" });
  });

  it("reads the reply after the message sent again, up to the owner's next", () => {
    const spine = [
      { id: 1, role: "user" as const, text: "Q", hidden: false },
      { id: 9, role: "user" as const, text: "Q again", hidden: false },
      { id: 10, role: "assistant" as const, text: "Part one.", hidden: false },
      { id: 12, role: "assistant" as const, text: "Part two.", hidden: false },
      { id: 13, role: "user" as const, text: "Next", hidden: false },
    ];
    expect(replyAfter(spine, 9, 2)).toBe("Part one.\n\nPart two.");
    expect(replyAfter(spine, undefined, 2)).toBe("Part one.\n\nPart two.");
    expect(replyAfter(spine.slice(0, 2), 9, 2)).toBeUndefined();
  });
});

describe("Edit", () => {
  it("previews what the branch keeps and leaves out before anything is sent", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    expect(p).toMatchObject({ kind: "edit", count: 5, before: 3, hidden: 1, original: "How long should we keep snapshots?", refsPrefix: "" });
    expect(p.later).toEqual({
      messages: [
        { role: "assistant", excerpt: "Keep 14 daily snapshots." },
        { role: "user", excerpt: "[2 files] Does this policy match?" },
        { role: "assistant", excerpt: "Mostly: it keeps 7 daily snapshots." },
      ],
      yours: 1,
      replies: 2,
      toolCalls: 0,
    });
    // The tool call before the message ran already, and isn't left out.
    expect((await hermes.previewReplay("c1", itemWith("Which folders"), "edit")).later.toolCalls).toBe(1);
    expect(server.requests.some((r) => r.method === "session.branch" || r.method === "prompt.submit")).toBe(false);
  });

  it("edits an early turn in a new branch, and leaves the original and its later messages as they were", async () => {
    const { server, hermes, chat, itemWith, branches } = await chatWithHistory();
    const before = JSON.stringify(server.transcripts.c1);
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    const { chatId, warnings, delivery } = await hermes.replay(p, "How long should we keep the weekly snapshots?");
    expect(warnings).toEqual([]);
    expect(delivery).toEqual({ delivery: "accepted" });

    // Hermes branches through the owner's message, then the edit replaces the branch's copy of it.
    expect(server.last("session.branch")!.params).toMatchObject({ session_id: chat().runtimeId, count: 5 });
    const submit = server.last("prompt.submit")!;
    expect(submit.params).toMatchObject({ session_id: chat(chatId).runtimeId, text: "How long should we keep the weekly snapshots?", confirm_truncate: true });
    expect(submit.params.confirm_empty_truncate).toBeUndefined();
    expect(server.archived.map((m) => [m.session, m.text])).toEqual([[chatId, "How long should we keep snapshots?"]]);
    expect(stored(server, chatId)).toEqual([
      'user (hidden): Instructions for this chat from the project "Homelab".',
      "user: Which folders should the backup cover?",
      "assistant: Let me look.",
      "assistant: Cover /srv/photos and /srv/documents.",
      "user: How long should we keep the weekly snapshots?",
    ]);
    // The original is untouched, its later messages all there.
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
    expect(texts(chat().items)).toContain("user: How long should we keep snapshots?");
    expect(texts(chat().items)).toContain("assistant: Mostly: it keeps 7 daily snapshots.");
    expect(branches()).toHaveLength(1);

    // The branch shows the edit where the original was, once, and is Active and this app's.
    expect(texts(chat(chatId).items)).toEqual([
      "user: Which folders should the backup cover?",
      "assistant: Let me look.",
      "assistant: Cover /srv/photos and /srv/documents.",
      "user: How long should we keep the weekly snapshots?",
    ]);
    expect(chat(chatId)).toMatchObject({ source: "app", settled: false, running: true });
    expect(hermes.getSnapshot().branches.links[chatId]).toMatchObject({
      parentId: "c1",
      point: { role: "user", rowId: 6 },
      replay: { kind: "edit", sourceRowId: 6, count: 5, excerpt: "How long should we keep snapshots?", edited: "How long should we keep the weekly snapshots?" },
    });
  });

  it("sends the original's files again with the edited words, and lists one that's gone", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("Does this policy match"), "edit");
    expect(p.original).toBe("Does this policy match?");
    expect(p.files).toEqual([
      { path: "/srv/uploads/policy.md", state: "there" },
      { path: "/srv/uploads/gone.csv", state: "missing" },
    ]);
    const { chatId } = await hermes.replay(p, "Does this policy match the 14-day plan?");
    expect(server.last("prompt.submit")!.params.text).toBe("@file:/srv/uploads/policy.md @file:/srv/uploads/gone.csv\n\nDoes this policy match the 14-day plan?");
    // The transcript shows the words; the refs go to Hermes.
    expect(texts(chat(chatId).items).at(-1)).toBe("user: Does this policy match the 14-day plan?");
  });

  it("edits the very first message, which leaves nothing before it", async () => {
    const server = new FakeHermes();
    server.sessions = [row("h1", 0.1, { title: "Weekend hike", pinned: true })];
    server.storeMessage("h1", { role: "user", text: "Suggest a short hike" });
    server.storeMessage("h1", { role: "assistant", text: "Try the cliff path." });
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    await hermes.sync();
    await hermes.open("h1");
    await hermes.idle();
    const first = hermes.getSnapshot().chats.find((c) => c.id === "h1")!.items[0].id;
    const p = await hermes.previewReplay("h1", first, "edit");
    expect(p).toMatchObject({ count: 1, before: 0, later: { replies: 1, yours: 0 } });
    const { chatId, delivery } = await hermes.replay(p, "Suggest a short hike near the coast");
    expect(delivery.delivery).toBe("accepted");
    expect(server.last("session.branch")!.params.count).toBe(1);
    expect(server.last("prompt.submit")!.params).toMatchObject({ confirm_truncate: true, confirm_empty_truncate: true });
    expect(stored(server, chatId)).toEqual(["user: Suggest a short hike near the coast"]);
    expect(stored(server, "h1")).toEqual(["user: Suggest a short hike", "assistant: Try the cliff path."]);
  });

  it("refuses an empty edit without asking Hermes", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    await expect(hermes.replay(p, "   ")).rejects.toThrow("Type the message");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });
});

describe("Regenerate", () => {
  it("regenerates twice: each answer has its own branch, the message sent again as stored, and the model it ran on", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    await hermes.setModel("c1", { provider: "openrouter", model: "deepseek/deepseek-v4", effort: "high" });
    const before = JSON.stringify(server.transcripts.c1);
    const reply = itemWith("Keep 14 daily");

    const p1 = await hermes.previewReplay("c1", reply, "regenerate");
    expect(p1).toMatchObject({ kind: "regenerate", replyItemId: reply, original: "How long should we keep snapshots?", count: 5 });
    // The reply itself is what's replaced; the turn after it is what the branch leaves out.
    expect(p1.later.messages.map((m) => m.excerpt)).toEqual(["[2 files] Does this policy match?", "Mostly: it keeps 7 daily snapshots."]);
    const one = await hermes.replay(p1);
    expect(server.last("prompt.submit")!.params.text).toBe("How long should we keep snapshots?");
    await answer(server, hermes, one.chatId, "Keep 30 daily snapshots.");

    const p2 = await hermes.previewReplay("c1", reply, "regenerate");
    const two = await hermes.replay(p2);
    await answer(server, hermes, two.chatId, "Keep 7 daily and 4 weekly snapshots.");

    expect(one.chatId).not.toBe(two.chatId);
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
    const variants = replaysOf(hermes.getSnapshot().branches.links, "c1", 6, "regenerate");
    expect(variants.map((v) => v.chatId)).toEqual([one.chatId, two.chatId]);
    for (const v of variants) {
      expect(v.link.replay).toMatchObject({ kind: "regenerate", sourceRowId: 6, excerpt: "How long should we keep snapshots?" });
      // Both answer the same message, on the parent's model, which the branch was switched to before it went.
      expect(v.link.replay.model).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4", effort: "high" });
      expect(stored(server, v.chatId).slice(-2)[0]).toBe("user: How long should we keep snapshots?");
    }
    expect((await hermes.readVariant(one.chatId)).text).toBe("Keep 30 daily snapshots.");
    expect((await hermes.readVariant(two.chatId)).text).toBe("Keep 7 daily and 4 weekly snapshots.");
    // The original keeps its own answer.
    expect(texts(chat().items)).toContain("assistant: Keep 14 daily snapshots.");
  });

  it("regenerates the reply to a message sent with files, refs and all", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("Mostly: it keeps"), "regenerate");
    await hermes.replay(p);
    expect(server.last("prompt.submit")!.params.text).toBe("@file:/srv/uploads/policy.md @file:/srv/uploads/gone.csv\n\nDoes this policy match?");
  });

  it("can't regenerate a reply to a message sent with an image, and says why", async () => {
    const { hermes, itemWith } = await chatWithHistory();
    await hermes.open("c2");
    await hermes.idle();
    await expect(hermes.previewReplay("c2", itemWith("four-port", "c2"), "regenerate")).rejects.toThrow("sent with an image");
    await expect(hermes.previewReplay("c2", itemWith("What router", "c2"), "edit")).rejects.toThrow("sent with an image");
  });
});

describe("Edit and Regenerate: when they can't be done", () => {
  it("refuses, with nothing made, when another client added to the chat since the preview", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    // A later turn, from another Hermes client: the prefix is the same, but the chat isn't what the owner saw.
    server.storeMessage("c1", { role: "user", text: "Also back up /etc" });
    await expect(hermes.replay(p, "How long for weekly?")).rejects.toThrow("This chat changed since this opened");
    expect(branches()).toHaveLength(0);
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("refuses when a message before it was edited in another client", async () => {
    const { server, hermes, itemWith, branches } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate");
    server.transcripts.c1[1].text = "Which folders should the nightly backup cover?";
    await expect(hermes.replay(p)).rejects.toThrow("changed");
    expect(branches()).toHaveLength(0);
  });

  it("isn't done while a reply or a tool runs, or an Approval waits, until it has ended", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    const sid = chat().runtimeId!;
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    server.event(sid, "message.start", {});
    server.event(sid, "tool.start", { tool_id: "k9", name: "terminal", context: "sleep 25" });
    await hermes.idle();
    await expect(hermes.previewReplay("c1", itemWith("How long should we keep"), "edit")).rejects.toThrow("Wait for the reply to finish");
    await expect(hermes.replay(p, "Weekly?")).rejects.toThrow("Wait for the reply to finish");
    // Stopping isn't enough: the turn must have ended.
    void hermes.stop("c1");
    await hermes.idle();
    await expect(hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate")).rejects.toThrow("Wait for the reply to finish");
    server.event(sid, "message.complete", { text: "", status: "interrupted" });
    await hermes.idle();
    server.askApproval(sid);
    await hermes.idle();
    await expect(hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate")).rejects.toThrow("waiting for an Approval");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("says this Hermes can't branch, then offers neither until it reconnects", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    server.branchMethod = false;
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    await expect(hermes.replay(p, "Weekly?")).rejects.toThrow("can't branch chats");
    expect(hermes.getSnapshot().cannotBranch).toBe(true);
    await expect(hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate")).rejects.toThrow("can't keep this chat as it is");
    expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(false);
  });

  it("tells the owner when Hermes ignored the cut and kept both messages", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    server.ignoresCut = true;
    const p = await hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate");
    const { chatId } = await hermes.replay(p);
    await hermes.idle();
    expect(hermes.getSnapshot().branchNews).toMatchObject({ chatId, text: expect.stringContaining("didn't replace the message") });
  });

  it("keeps a refused replay in the branch, and Retry sends it in the original's place again", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    const p = await hermes.previewReplay("c1", itemWith("How long should we keep"), "edit");
    const { chatId, delivery } = await hermes.replay(p, "Weekly snapshots?");
    expect(delivery).toEqual({ delivery: "unsent", reason: "session busy" });
    const failed = chat(chatId).items.at(-1)!;
    expect(failed).toMatchObject({ kind: "user", text: "Weekly snapshots?", outgoing: { state: "failed", cut: { prompt: "Weekly snapshots?" } } });
    server.rejectPrompt = undefined;
    await hermes.retry(chatId, failed.id);
    expect(server.last("prompt.submit")!.params).toMatchObject({ text: "Weekly snapshots?", confirm_truncate: true });
    expect(stored(server, chatId).at(-1)).toBe("user: Weekly snapshots?");
    expect(stored(server, chatId).filter((t) => t.includes("How long should we keep"))).toEqual([]);
  });
});

describe("Edit and Regenerate: kept on this computer", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps what each branch replays, and a failed replay's cut, across a restart", async () => {
    const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
    const { server, hermes, itemWith } = await chatWithHistory({ cache: localChatCache(nas) });
    const p = await hermes.previewReplay("c1", itemWith("Keep 14 daily"), "regenerate");
    const { chatId } = await hermes.replay(p);
    server.rejectPrompt = { code: 4009, message: "session busy" };
    const e = await hermes.previewReplay("c1", itemWith("Which folders"), "edit");
    const edited = await hermes.replay(e, "Which folders, besides /etc?");
    await hermes.idle();
    await hermes.close();

    const kept = localChatCache(nas);
    expect(kept.loadBranches("default").links[chatId].replay).toMatchObject({ kind: "regenerate", sourceRowId: 6, count: 5 });
    expect(kept.loadBranches("default").links[edited.chatId].replay).toMatchObject({ kind: "edit", sourceRowId: 2, count: 2 });
    expect(kept.loadOutbox("default")[edited.chatId][0].outgoing).toMatchObject({ state: "failed", cut: { prompt: "Which folders, besides /etc?" } });
  });
});
