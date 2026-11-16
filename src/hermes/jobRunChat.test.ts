// A Job run's chat against a fake Hermes: it is read from its stored rows and nothing about it is written, however it
// is reached (chatKind.ts, storedTranscript.ts).
import { describe, expect, it } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { inboxEntries } from "./inbox";
import { jobRunTitle } from "./cronJobs";
import { LOAD_ERROR_ID, connect } from "./transport";
import { RestError } from "./pipe";
import { runFilter } from "./chatFilter";
import { memoryCache } from "./memoryCache";

const RUN = "local-run-1";
const PREAMBLE = "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user.]";
const STARTED = Math.floor(Date.now() / 1000) - 3600;

/** A run of the Disk check job as v0.23.1 stores one: the assembled prompt, a tool step and the reply. */
const runRows = (): TranscriptMessage[] => [
  { role: "user", text: `${PREAMBLE}\n\nCheck the disk usage on the server.`, row_id: 101 },
  { role: "assistant", text: "Checking the root filesystem first.", row_id: 102, tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command": "df -h /"}' } }] },
  { role: "tool", tool_call_id: "call_1", name: "terminal", result: '{"output": "61% /", "exit_code": 0}', row_id: 103 },
  { role: "assistant", text: "Nothing needs cleaning tonight.", row_id: 104 },
];

async function signedIn(over: Parameters<typeof row>[2] = {}) {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    // Marked unread on the server, as only another client could have left it.
    row(RUN, 0, { source: "cron", title: "Disk check · Nov 16 14:40", preview: PREAMBLE, started_at: STARTED, last_active: STARTED + 60, last_read_at: 0, ...over }),
  ];
  server.transcripts[RUN] = runRows();
  server.cron.jobs = { default: [] };
  const job = server.cron.add("default", { name: "Disk check", prompt: "Check the disk usage on the server.", schedule: "0 3 * * *" });
  server.cron.runs[job.id] = [{ id: RUN, source: "cron", started_at: STARTED, ended_at: STARTED + 60, end_reason: "cron_complete", profile: "default" }];
  const cache = memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  return { server, hermes, cache, jobId: job.id };
}

type Signed = Awaited<ReturnType<typeof signedIn>>;
const chat = ({ hermes }: Signed) => hermes.getSnapshot().chats.find((c) => c.id === RUN);
const reveal = ({ hermes }: Signed) => hermes.reveal({ chatId: RUN, title: "Disk check", source: "cron", settled: true, updatedAt: STARTED * 1000, snippet: [] });
const writes = ({ server }: Signed) => server.restRequests.filter((r) => r.method !== "GET");
const sent = ({ server }: Signed, method: string) => server.requests.filter((r) => r.method === method);

describe("A job run's chat", () => {
  it("opens from its stored rows, with its tool step named, and starts no session and marks nothing read", async () => {
    const s = await signedIn();
    reveal(s);
    await s.hermes.open(RUN);
    await s.hermes.idle();
    expect(chat(s)!.items.map((i) => [i.kind, i.kind === "tool" ? `${i.name}: ${i.preview}` : "text" in i ? i.text : ""])).toEqual([
      ["user", `${PREAMBLE}\n\nCheck the disk usage on the server.`],
      ["assistant", "Checking the root filesystem first."],
      ["tool", "terminal: df -h /"],
      ["assistant", "Nothing needs cleaning tonight."],
    ]);
    expect(chat(s)).toMatchObject({ title: "Disk check · Nov 16 14:40", jobId: s.jobId, loading: false });
    expect(chat(s)!.runtimeId).toBeUndefined();
    expect(sent(s, "session.resume")).toEqual([]);
    expect(writes(s)).toEqual([]);
    expect(s.server.sessions.find((r) => r.id === RUN)!.last_read_at).toBe(0);
  });

  it("is read again each time it opens, and keeps no copy on this computer", async () => {
    const s = await signedIn();
    reveal(s);
    await s.hermes.open(RUN);
    s.hermes.leave(RUN);
    s.server.transcripts[RUN].push({ role: "assistant", text: "One more line, added by the run.", row_id: 105 });
    await s.hermes.open(RUN);
    expect(chat(s)!.items.at(-1)).toMatchObject({ kind: "assistant", text: "One more line, added by the run." });
    expect(chat(s)!.savedAt).toBeUndefined();
    expect(s.cache.loadTranscript("default", RUN)).toBeUndefined();
    // The list kept for the next start is the chat list, which a run isn't in.
    expect(s.cache.load("default").map((c) => c.id)).toEqual(["backup"]);
  });

  it("refuses a message, a queued message and every change to the chat, and sends Hermes none of them", async () => {
    const s = await signedIn();
    reveal(s);
    await s.hermes.open(RUN);
    expect(await s.hermes.send(RUN, "Carry on")).toEqual({ delivery: "unsent", reason: "A scheduled job's run can't be continued here." });
    expect(s.hermes.enqueue(RUN, "Later")).toBe("A scheduled job's run can't be continued here.");
    await expect(s.hermes.rename(RUN, "Mine now", chat(s)!.title)).rejects.toThrow(/read-only here/);
    await expect(s.hermes.previewBranch(RUN, chat(s)!.items[0].id)).rejects.toThrow(/read-only here/);
    await expect(s.hermes.setModel(RUN, { provider: "p", model: "m" })).rejects.toThrow(/can't be continued here/);
    expect(await s.hermes.delete(RUN)).toBe(false);
    expect(await s.hermes.archive(RUN)).toBe(false);
    await s.hermes.unsettle(RUN);
    await s.hermes.idle();
    expect(chat(s)!.items).toHaveLength(4);
    expect(chat(s)).toMatchObject({ settled: true });
    expect(sent(s, "session.resume")).toEqual([]);
    expect(sent(s, "prompt.submit")).toEqual([]);
    expect(writes(s)).toEqual([]);
  });

  it("isn't marked read when the window comes back to it", async () => {
    const s = await signedIn();
    reveal(s);
    s.hermes.setFocused(false);
    await s.hermes.open(RUN);
    s.hermes.setFocused(true);
    await s.hermes.idle();
    expect(writes(s)).toEqual([]);
  });

  it("names a tool step whose call is on an earlier page of its rows", async () => {
    const s = await signedIn();
    const filler = Array.from({ length: 498 }, (_, i): TranscriptMessage => ({ role: "assistant", text: `Step ${i}`, row_id: 1000 + i }));
    const [prompt, call, result, reply] = runRows();
    s.server.transcripts[RUN] = [prompt, ...filler, call, result, reply];
    reveal(s);
    await s.hermes.open(RUN);
    const pages = s.server.restRequests.filter((r) => r.path === `/api/sessions/${RUN}/messages`).map((r) => Object.fromEntries(r.query));
    expect(pages).toEqual([
      { profile: "default", order: "oldest", limit: "500", offset: "0", inline_images: "false" },
      { profile: "default", order: "oldest", limit: "500", offset: "500", inline_images: "false" },
    ]);
    expect(chat(s)!.items.find((i) => i.kind === "tool")).toMatchObject({ name: "terminal", preview: "df -h /" });
    expect(chat(s)!.items).toHaveLength(502);
  });

  it("says a run Hermes no longer has is gone, and why any other read failed, and reads again on the next open", async () => {
    const s = await signedIn();
    reveal(s);
    s.server.messagesFailure = new RestError(503, '{"detail":"Session store is busy"}');
    await s.hermes.open(RUN);
    expect(chat(s)!.items).toEqual([{ kind: "error", id: LOAD_ERROR_ID, text: expect.stringMatching(/^Couldn't load this chat: .*busy/) }]);
    s.server.messagesFailure = undefined;
    await s.hermes.open(RUN);
    expect(chat(s)!.items).toHaveLength(4);
    s.server.sessions = s.server.sessions.filter((r) => r.id !== RUN);
    await s.hermes.open(RUN);
    expect(chat(s)!.items.at(-1)).toEqual({ kind: "error", id: LOAD_ERROR_ID, text: "This run's chat isn't on the server any more." });
  });

  it("stays out of the list and the unread count through a refresh, though the server marks it unread", async () => {
    const s = await signedIn();
    expect(s.hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["backup"]);
    reveal(s);
    await s.hermes.open(RUN);
    s.hermes.leave(RUN);
    await s.hermes.sync();
    expect(chat(s)).toMatchObject({ source: "cron" });
    expect(chat(s)!.unread).toBeFalsy();
    const lists = s.server.restRequests.filter((r) => r.path === "/api/sessions");
    expect(lists.every((r) => r.query.get("exclude_sources") === "cron")).toBe(true);
  });

  it("makes no Inbox entry, running, unread or failed, here or as a live session", () => {
    const run = { id: RUN, title: "Disk check", source: "cron" as const, settled: true, updatedAt: 1, unread: true, running: true, items: [{ kind: "error" as const, id: "e1", text: "The run failed." }] };
    const sources = { profile: "default", connected: true, others: { byName: {} }, live: { sessions: [{ chatId: "local-run-2", status: "working" as const, at: 2, profile: "default", title: "Disk check", source: "cron" as const }] } };
    expect(inboxEntries({ ...sources, chats: [run] }).entries).toEqual([]);
    // The same chat from another platform is listed for each.
    expect(inboxEntries({ ...sources, chats: [{ ...run, source: "other" }], live: { sessions: [{ ...sources.live.sessions[0], source: "other" }] } }).entries.map((e) => e.kind)).toEqual(["failed", "completed", "running", "running"]);
  });
});

describe("Finding job runs", () => {
  const tags = { exists: () => true, of: () => [] };

  it("asks Hermes for them only when Scheduled jobs is a source asked for", async () => {
    const s = await signedIn();
    const asked = (path: string) => Object.fromEntries(s.server.restRequests.filter((r) => r.path === path && r.query.get("limit") !== "1").at(-1)!.query);
    const query = () => asked("/api/sessions");
    const search = () => asked("/api/sessions/search");
    expect((await runFilter({ sources: ["cron"] }, s.hermes, tags)).found.map((c) => [c.chatId, c.source])).toEqual([[RUN, "cron"]]);
    expect(query()).toMatchObject({ sources: "cron" });
    expect(query()).not.toHaveProperty("exclude_sources");
    expect((await runFilter({ text: "disk", sources: ["cron"] }, s.hermes, tags)).found.map((c) => c.chatId)).toEqual([RUN]);
    expect(search()).toMatchObject({ sources: "cron", q: "disk" });
    expect(search()).not.toHaveProperty("exclude_sources");

    expect((await runFilter({ sources: ["other"] }, s.hermes, tags)).found).toEqual([]);
    expect(query()).toMatchObject({ exclude_sources: "cron" });
    expect((await runFilter({ text: "disk" }, s.hermes, tags)).found).toEqual([]);
    expect(search()).toMatchObject({ exclude_sources: "cron" });
  });

  it("lists them beside another source's chats when both are asked for", async () => {
    const s = await signedIn();
    s.server.sessions.push(row("hook", 2, { source: "webhook", title: "Deploy hook" }));
    expect((await runFilter({ sources: ["other", "cron"] }, s.hermes, tags)).found.map((c) => c.chatId)).toEqual([RUN, "hook"]);
  });

  it("calls a run Hermes hasn't named yet by when it started, never by the scheduler's instructions", async () => {
    const s = await signedIn({ title: null });
    const [found] = (await runFilter({ sources: ["cron"] }, s.hermes, tags)).found;
    expect(found.title).toBe(jobRunTitle(STARTED * 1000));
    expect(found.title).toMatch(/^Scheduled job run · /);
    expect((await s.hermes.findChat(RUN, "default"))!).toMatchObject({ title: jobRunTitle(STARTED * 1000), source: "cron" });
  });
});
