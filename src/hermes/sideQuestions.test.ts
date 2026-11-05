// @vitest-environment jsdom
// Side questions (`/btw`, ADR 0069): asked through `prompt.btw` on the chat's live session, answered by the
// `btw.complete` that names their task id, and never part of the chat, its Saved copy or a reply running alongside.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { SIDE_QUESTIONS_KEPT, connect, type Hermes } from "./transport";
import { listServerCommands } from "./commands";
import { localChatCache } from "./chatCache";
import { chatMarkdown } from "./exportChat";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const HISTORY: TranscriptMessage[] = [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }];

async function opened(server = new FakeHermes()) {
  server.sessions = [row("backup", 1, { title: "Nightly backup" }), row("vpn", 2, { title: "Slow VPN" })];
  server.transcripts = { backup: HISTORY, vpn: [{ role: "user", text: "Why is the VPN slow?" }, { role: "assistant", text: "MTU." }] };
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  await hermes.open("backup");
  const chat = (id = "backup") => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  return { server, hermes, chat, runtime: server.runtimeIdOf("backup")! };
}

const task = (n = 0) => `btw_${String(n + 1).padStart(6, "0")}`;

describe("Whether /btw is offered", () => {
  it("follows Hermes's command catalog, as /steer does, and no quick or plugin command can take its place", async () => {
    const list = (res: Record<string, unknown>) => listServerCommands(async () => res, "default").then((l) => [...l.listed]);
    expect(await list({ canon: { "/steer": "/steer", "/btw": "/btw" } })).toEqual(["steer", "btw"]);
    expect(await list({ canon: { "/steer": "/steer" } })).toEqual(["steer"]);
    // `prompt.btw` is a method of its own, which `command.dispatch`'s quick and plugin commands never reach.
    expect(await list({ canon: { "/btw": "/btw" }, plugin_commands: { btw: "Plugin" }, categories: [{ name: "User commands", pairs: [["/btw", "x"]] }], plugin_discovery_error: "boom" })).toEqual(["btw"]);
  });
});

describe("A side question", () => {
  it("goes to the chat's live session, and its answer is matched by task id, outside the transcript", async () => {
    const { server, hermes, chat, runtime } = await opened();
    const before = chat().items;

    const asking = hermes.askSideQuestion("backup", "Which repo was it?");
    expect(chat().sideQuestions).toEqual([{ id: expect.any(String), question: "Which repo was it?", state: "asking" }]);
    expect(await asking).toBe(true);
    expect(server.last("prompt.btw")?.params).toEqual({ session_id: runtime, text: "Which repo was it?" });
    expect(chat().sideQuestions?.[0]).toMatchObject({ state: "asking", taskId: task() });

    // Another task's answer, such as one asked in another Hermes client, isn't this one's.
    server.event(runtime, "btw.complete", { task_id: "btw_other", question: "Something else?", text: "No." });
    await hermes.idle();
    expect(chat().sideQuestions?.[0].state).toBe("asking");

    server.event(runtime, "btw.complete", { task_id: task(), question: "Which repo was it?", text: "The `restic` repo on the NAS." });
    await hermes.idle();
    expect(chat().sideQuestions).toEqual([
      { id: expect.any(String), question: "Which repo was it?", taskId: task(), state: "answered", answer: "The `restic` repo on the NAS." },
    ]);
    expect(chat().items).toBe(before);
    expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(false);
    expect(localChatCache(nas).loadTranscript("default", "backup")?.items.map((i) => i.kind === "user" || i.kind === "assistant" ? i.text : i.kind) ?? []).not.toContain(
      "The `restic` repo on the NAS.",
    );
    expect(chatMarkdown(chat(), new Date())).not.toMatch(/Which repo|NAS/);
  });

  it("leaves a reply running alongside alone, before and after its answer", async () => {
    const { server, hermes, chat, runtime } = await opened();
    await hermes.send("backup", "Unlock it and run the backup");
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Unlocking" });
    await hermes.idle();

    expect(await hermes.askSideQuestion("backup", "How long will it take?")).toBe(true);
    server.event(runtime, "message.delta", { text: " the repo" });
    server.event(runtime, "btw.complete", { task_id: task(), question: "How long will it take?", text: "About ten minutes." });
    await hermes.idle();
    expect(chat().running).toBe(true);
    expect(chat().items.at(-1)).toMatchObject({ kind: "assistant", text: "Unlocking the repo" });
    expect(server.requests.filter((r) => r.method === "command.dispatch" || r.method === "session.interrupt")).toEqual([]);

    server.event(runtime, "message.complete", { status: "complete", text: "Unlocking the repo" });
    await hermes.idle();
    expect(chat().running).toBe(false);
    expect(chat().items.filter((i) => i.kind === "assistant").map((i) => i.text)).toEqual(["The restic repo was locked.", "Unlocking the repo"]);
    expect(chat().sideQuestions?.[0]).toMatchObject({ state: "answered", answer: "About ten minutes." });
  });

  it("keeps its answer when it comes before Hermes's reply naming its task", async () => {
    const { server, hermes, chat, runtime } = await opened();
    const reply = server.handlers["prompt.btw"];
    server.handlers["prompt.btw"] = (r) => {
      server.event(runtime, "btw.complete", { task_id: "btw_early1", question: String(r.params.text), text: "Quick answer." });
      server.respond(r.id, { task_id: "btw_early1" });
    };
    expect(await hermes.askSideQuestion("backup", "Quick one?")).toBe(true);
    expect(chat().sideQuestions?.[0]).toMatchObject({ taskId: "btw_early1", state: "answered", answer: "Quick answer." });
    server.handlers["prompt.btw"] = reply;
  });

  it("doesn't hold an answer no question claims once none waits for its task id", async () => {
    const { server, hermes, chat, runtime } = await opened();
    // Another question's answer comes while this one waits for its task id, and nobody here asked it.
    server.handlers["prompt.btw"] = (r) => {
      server.event(runtime, "btw.complete", { task_id: "btw_stray", question: "Dismissed?", text: "A stale answer." });
      server.respond(r.id, { task_id: "btw_first" });
    };
    expect(await hermes.askSideQuestion("backup", "First?")).toBe(true);
    // Had the stray answer been kept, a later question Hermes happens to give that id would show it.
    let answer!: () => void;
    server.handlers["prompt.btw"] = (r) => (answer = () => server.respond(r.id, { task_id: "btw_stray" }));
    const asking = hermes.askSideQuestion("backup", "Second?");
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer();
    expect(await asking).toBe(true);
    expect(chat().sideQuestions?.map((q) => [q.question, q.state])).toEqual([
      ["First?", "asking"],
      ["Second?", "asking"],
    ]);
  });

  it("shows why there's no answer: Hermes's failure, an empty answer, a refusal, an older Hermes, a dropped connection", async () => {
    const { server, hermes, chat, runtime } = await opened();
    await hermes.askSideQuestion("backup", "First?");
    await hermes.askSideQuestion("backup", "Second?");
    server.event(runtime, "btw.complete", { task_id: task(0), question: "First?", text: "error: No credentials for the side question model" });
    server.event(runtime, "btw.complete", { task_id: task(1), question: "Second?", text: "" });
    await hermes.idle();
    expect(chat().sideQuestions?.map((q) => [q.question, q.state === "failed" && q.error])).toEqual([
      ["First?", "No credentials for the side question model"],
      ["Second?", "Hermes had no answer to it."],
    ]);

    server.handlers["prompt.btw"] = (r) => server.fail(r.id, 5035, "backend is retiring; reconnect to continue");
    expect(await hermes.askSideQuestion("backup", "Third?")).toBe(false);
    expect(chat().sideQuestions?.at(-1)).toMatchObject({ question: "Third?", state: "failed", error: "backend is retiring; reconnect to continue" });

    server.handlers["prompt.btw"] = (r) => server.fail(r.id, -32601, "unknown method: prompt.btw");
    expect(await hermes.askSideQuestion("backup", "Fourth?")).toBe(false);
    expect(chat().sideQuestions?.at(-1)).toMatchObject({ state: "failed", error: "This Hermes can't answer side questions here. Updating Hermes may add it." });
  });

  it("fails, saying so, when the connection drops before its answer, and a late answer changes nothing", async () => {
    const { server, hermes, chat, runtime } = await opened();
    await hermes.askSideQuestion("backup", "Still there?");
    server.drop();
    await hermes.idle();
    expect(chat().sideQuestions?.[0]).toMatchObject({ state: "failed", error: "The connection to Hermes dropped before it answered." });
    server.event(runtime, "btw.complete", { task_id: task(), question: "Still there?", text: "Yes." });
    await hermes.idle();
    expect(chat().sideQuestions?.[0].state).toBe("failed");
  });

  it(`stacks up to ${SIDE_QUESTIONS_KEPT} per chat, newest last, each in its own chat, and goes when dismissed`, async () => {
    const { hermes, chat } = await opened();
    await hermes.open("vpn");
    for (const q of ["One?", "Two?", "Three?", "Four?"]) await hermes.askSideQuestion("backup", q);
    await hermes.askSideQuestion("vpn", "MTU?");
    expect(chat().sideQuestions?.map((q) => q.question)).toEqual(["Two?", "Three?", "Four?"]);
    expect(chat("vpn").sideQuestions?.map((q) => q.question)).toEqual(["MTU?"]);

    hermes.dismissSideQuestion("backup", chat().sideQuestions![1].id);
    expect(chat().sideQuestions?.map((q) => q.question)).toEqual(["Two?", "Four?"]);
    hermes.dismissSideQuestion("vpn", chat("vpn").sideQuestions![0].id);
    expect(chat("vpn").sideQuestions).toBeUndefined();
  });

  it("isn't asked for a chat that isn't open on Hermes, and says so on its card", async () => {
    const { server, hermes, chat } = await opened();
    expect(await hermes.askSideQuestion("vpn", "MTU?")).toBe(false);
    expect(chat("vpn").sideQuestions?.[0]).toMatchObject({ state: "failed", error: "This chat isn't open on Hermes." });
    expect(server.requests.some((r) => r.method === "prompt.btw")).toBe(false);
  });
});
