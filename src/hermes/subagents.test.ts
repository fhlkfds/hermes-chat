import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";
import { CapabilityUnsupportedError } from "./capabilities";
import { ACTIVITY_MAX, SUBAGENTS_MAX, childrenOf, descendantsOf, onRoster, onSubagentEvent, tally, type SubagentId, type SubagentTree } from "./subagents";

/** A new chat with a reply under way. */
async function replying(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "Audit the repo");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const tree = () => chat().subagents!;
  const agent = (sid: string) => tree().subagents.find((s) => s.id === sid);
  return { server, hermes, id, runtime, chat, tree, agent };
}

/** `subagent.*` frames as `tui_gateway/tool_progress._subagent_payload` builds them at `f0d94882`. */
const who = (subagent_id: string, goal: string, more: Record<string, unknown> = {}) => ({
  goal,
  task_count: 1,
  task_index: 0,
  subagent_id,
  depth: 1,
  model: "claude-sonnet-4-5",
  ...more,
});

const sid = (s: string) => s as SubagentId;
const ids = (tree: SubagentTree, parent?: string) => childrenOf(tree, parent as SubagentId | undefined).map((s) => s.id);

describe("The subagent tree from Hermes's events", () => {
  it("shows parallel and nested subagents under who started them, with purpose, model, state and last activity", async () => {
    const { server, runtime, tree, agent } = await replying();
    server.event(runtime, "subagent.spawn_requested", who("a", "Read the auth code", { task_count: 2, delegation_id: "d1" }));
    server.event(runtime, "subagent.spawn_requested", who("b", "Read the tests", { task_count: 2, task_index: 1, delegation_id: "d1" }));
    server.event(runtime, "subagent.start", who("a", "Read the auth code", { task_count: 2, delegation_id: "d1" }));
    server.event(runtime, "subagent.start", who("b", "Read the tests", { task_count: 2, task_index: 1, delegation_id: "d1" }));
    server.event(runtime, "subagent.start", who("a1", "Check token expiry", { parent_id: "a", depth: 2, model: "gpt-5-mini" }));
    server.event(runtime, "subagent.tool", who("a1", "Check token expiry", { parent_id: "a", depth: 2, model: "gpt-5-mini", tool_name: "read_file", tool_preview: "src/auth.ts", tool_count: 1 }));

    expect(ids(tree())).toEqual(["a", "b"]);
    expect(ids(tree(), "a")).toEqual(["a1"]);
    expect(agent("b")).toMatchObject({ goal: "Read the tests", model: "claude-sonnet-4-5", state: "running", depth: 1, taskIndex: 1, taskCount: 2 });
    expect(agent("a1")).toMatchObject({ parent: "a", depth: 2, model: "gpt-5-mini", state: "running", lastActivity: { text: "read_file: src/auth.ts" } });
    expect(tally(tree())).toEqual({ running: 3, failed: 0, total: 3 });
  });

  it("keeps the subagents out of the chat's transcript", async () => {
    const { server, runtime, chat } = await replying();
    server.event(runtime, "subagent.start", who("a", "Read the auth code"));
    server.event(runtime, "subagent.tool", who("a", "Read the auth code", { tool_name: "terminal", tool_preview: "ls", tool_count: 1 }));
    server.event(runtime, "subagent.complete", who("a", "Read the auth code", { status: "completed", summary: "Two modules." }));
    expect(chat().items.map((i) => i.kind)).toEqual(["user"]);
  });

  it("shows a subagent that fails while the reply carries on", async () => {
    const { server, runtime, chat, agent } = await replying();
    server.event(runtime, "subagent.start", who("a", "Run the slow tests"));
    server.event(runtime, "subagent.start", who("b", "Lint"));
    server.event(runtime, "subagent.complete", who("a", "Run the slow tests", { status: "timeout", summary: "Gave up after 600 s.", duration_seconds: 600 }));
    server.event(runtime, "message.delta", { text: "The tests timed out; linting goes on." });

    expect(agent("a")).toMatchObject({ state: "timeout", summary: "Gave up after 600 s.", durationS: 600 });
    expect(agent("b")!.state).toBe("running");
    expect(chat()).toMatchObject({ running: true });
    expect(chat().items.at(-1)).toMatchObject({ kind: "assistant", text: "The tests timed out; linting goes on." });
    expect(tally(chat().subagents!)).toEqual({ running: 1, failed: 1, total: 2 });
  });

  it("takes events in any order: a late start, an event after the end, a child before its parent, a repeat", () => {
    let t: SubagentTree | undefined;
    const ev = (type: string, p: Record<string, unknown>, at: number) => (t = onSubagentEvent(t, type, p, at));
    ev("subagent.tool", who("c", "Grandchild", { parent_id: "p", depth: 2, tool_name: "grep", tool_count: 2 }), 1);
    // Its parent is in the tree, undescribed, before anything about it arrives.
    expect(t!.subagents.find((s) => s.id === "p")).toMatchObject({ goal: "", state: "unknown", partial: true });
    ev("subagent.tool", who("c", "Grandchild", { parent_id: "p", depth: 2, tool_name: "read_file", tool_count: 1 }), 2);
    ev("subagent.tool", who("c", "Grandchild", { parent_id: "p", depth: 2, tool_name: "grep", tool_count: 2 }), 3);
    ev("subagent.start", who("p", "Parent"), 4);
    ev("subagent.complete", who("c", "Grandchild", { parent_id: "p", depth: 2, status: "completed", summary: "Found it." }), 5);
    ev("subagent.tool", who("c", "Grandchild", { parent_id: "p", depth: 2, tool_name: "terminal", tool_count: 3 }), 6);
    ev("subagent.spawn_requested", who("p", "Parent"), 7);
    ev("subagent.complete", who("c", "Grandchild", { parent_id: "p", depth: 2, status: "failed" }), 8);

    const [p, c] = ["p", "c"].map((id) => t!.subagents.find((s) => s.id === id)!);
    expect(p).toMatchObject({ goal: "Parent", state: "running", partial: false });
    expect(ids(t!, "p")).toEqual(["c"]);
    // Hermes's first word on how it ended stands.
    expect(c).toMatchObject({ state: "completed", summary: "Found it.", partial: true });
    // The tool calls in Hermes's order, each once, then the end, once.
    expect(c.activity.map((a) => (a.kind === "tool" ? a.tool : a.kind))).toEqual(["read_file", "grep", "terminal", "ended"]);
  });

  it("keeps at most so much activity per subagent, and so many subagents, letting the oldest ended ones go", () => {
    let t: SubagentTree | undefined;
    for (let n = 1; n <= ACTIVITY_MAX + 5; n++) t = onSubagentEvent(t, "subagent.tool", who("a", "Busy", { tool_name: `t${n}`, tool_count: n }), n);
    expect(t!.subagents[0].activity).toHaveLength(ACTIVITY_MAX);
    expect(t!.subagents[0].activity[0]).toMatchObject({ tool: "t6" });

    t = undefined;
    for (let n = 0; n < SUBAGENTS_MAX + 3; n++) {
      t = onSubagentEvent(t, "subagent.start", who(`s${n}`, `Task ${n}`), n);
      if (n !== 1) t = onSubagentEvent(t, "subagent.complete", who(`s${n}`, `Task ${n}`, { status: "completed" }), n);
    }
    expect(t!.subagents).toHaveLength(SUBAGENTS_MAX);
    // The running one stays, however old.
    expect(t!.subagents.slice(0, 2).map((s) => s.id)).toEqual(["s1", "s4"]);
  });

  it("names every subagent under one, at any depth", () => {
    let t: SubagentTree | undefined;
    t = onSubagentEvent(t, "subagent.start", who("a", "A"), 1);
    t = onSubagentEvent(t, "subagent.start", who("b", "B"), 1);
    t = onSubagentEvent(t, "subagent.start", who("a1", "A1", { parent_id: "a", depth: 2 }), 1);
    t = onSubagentEvent(t, "subagent.start", who("a1x", "A1x", { parent_id: "a1", depth: 3 }), 1);
    expect(descendantsOf(t!, sid("a")).map((s) => s.id)).toEqual(["a1", "a1x"]);
    expect(descendantsOf(t!, sid("b"))).toEqual([]);
  });

  it("tells subagents apart by their delegate_task call on a Hermes that sends no subagent id", () => {
    let t: SubagentTree | undefined;
    t = onSubagentEvent(t, "subagent.start", { goal: "One", task_count: 2, task_index: 0, delegation_id: "d" }, 1);
    t = onSubagentEvent(t, "subagent.start", { goal: "Two", task_count: 2, task_index: 1, delegation_id: "d" }, 1);
    expect(t!.subagents.map((s) => s.goal)).toEqual(["One", "Two"]);
  });
});

describe("Recovering the tree after a reconnect", () => {
  afterEach(() => void vi.useRealTimers());

  it("marks the tree as last heard while disconnected, then reads Hermes's roster: running, ended unheard, failed in the background", async () => {
    vi.useFakeTimers();
    const { server, hermes, id, runtime, chat, tree, agent } = await replying();
    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    server.event(runtime, "subagent.start", who("a", "Read the auth code", { delegation_id: "d1" }));
    server.event(runtime, "subagent.start", who("b", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.start", who("c", "Summarize", { delegation_id: "d2" }));
    server.event(runtime, "subagent.complete", who("c", "Summarize", { delegation_id: "d2", status: "completed", summary: "Short summary." }));
    server.drop();
    expect(tree().sync).toMatchObject({ kind: "lost" });
    expect(agent("a")!.state).toBe("running");

    // Meanwhile on the server: a is still running, b failed as a background task, and a new one started.
    server.subagents[id] = [
      { subagent_id: "a", owner: runtime, goal: "Read the auth code", status: "running", depth: 0, delegation_id: "d1", tool_count: 7, last_tool: "grep", accepting_steer: true, started_at: 1_700_000_000 },
      { subagent_id: "n", owner: runtime, goal: "New work", status: "running", depth: 0, model: "gpt-5", accepting_steer: true, started_at: 1_700_000_100 },
    ];
    server.failedDelegations[id] = [{ delegation_id: "d1", task_index: 1, status: "error", goal: "Read the tests", error: "Rate limited.", dispatched_at: 1_700_000_000, completed_at: 1_700_000_050 }];
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();

    // Hermes gave the chat a new session on the new connection, and lists the old one's subagents through it.
    expect(chat().runtimeId).not.toBe(runtime);
    expect(server.last("subagent.list")!.params).toEqual({ session_id: chat().runtimeId });
    expect(tree().sync).toEqual({ kind: "live" });
    expect(agent("a")).toMatchObject({ state: "running", toolCount: 7, acceptingSteer: true, lastActivity: { text: "grep" } });
    expect(agent("b")).toMatchObject({ state: "error", summary: "Rate limited." });
    // Ended before the drop: its summary is kept.
    expect(agent("c")).toMatchObject({ state: "completed", summary: "Short summary." });
    // Running before the app heard of it: what it did before isn't shown, and says so.
    expect(agent("n")).toMatchObject({ state: "running", model: "gpt-5", partial: true, startedAt: 1_700_000_100_000 });
  });

  it("marks a subagent the roster no longer lists, with no word of how it ended, as unknown", async () => {
    vi.useFakeTimers();
    const { server, hermes, id, runtime, agent } = await replying();
    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    server.event(runtime, "subagent.start", who("a", "Read the auth code"));
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(agent("a")!.state).toBe("unknown");
  });

  it("lists a chat's subagents when the app opens it, so a run from before the app started shows", async () => {
    const server = new FakeHermes();
    server.sessions = [row("s1", 2)];
    server.transcripts = { s1: [{ role: "user", text: "Audit the repo" }] };
    server.subagents.s1 = [{ subagent_id: "a", owner: "old-runtime", goal: "Read the auth code", status: "running", depth: 0, accepting_steer: true }];
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("s1");
    await hermes.idle();
    const tree = hermes.getSnapshot().chats.find((c) => c.id === "s1")!.subagents!;
    expect(tree.subagents).toEqual([expect.objectContaining({ id: "a", goal: "Read the auth code", state: "running", partial: true })]);
  });

  it("says why the tree can't be checked on a Hermes without subagent.list, and refuses Steer and Stop there", async () => {
    vi.useFakeTimers();
    const server = new FakeHermes();
    server.asOlderHermes();
    const { hermes, id, runtime, tree } = await replying(server);
    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    server.event(runtime, "subagent.start", who("a", "Read the auth code"));
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(tree().sync).toEqual({ kind: "unchecked", why: expect.stringMatching(/no subagent\.list/) });
    expect(hermes.capabilities.get("subagents").state).toBe("unsupported");
    await expect(hermes.stopSubagent(id, sid("a"))).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    expect(server.requests.filter((r) => r.method === "subagent.interrupt")).toEqual([]);
  });

  it("drops a roster that arrives after the chat's session changed", () => {
    // The tree is the roster's only input; the transport checks the session before applying it. A roster with nothing
    // in it and no tree makes no tree.
    expect(onRoster(undefined, { subagents: [], delegations: [] }, 1)).toBeUndefined();
    expect(onRoster(undefined, { nonsense: true }, 1)).toBeUndefined();
  });
});

describe("Steering and stopping one subagent", () => {
  /** A chat whose reply started a and b (siblings) and a1 under a; another chat whose reply started x. */
  async function twoChats() {
    const r = await replying();
    const { server, hermes, id, runtime } = r;
    const other = await hermes.newChat();
    await hermes.send(other, "Another job");
    const otherRuntime = server.runtimeIdOf(other)!;
    server.subagents[id] = ["a", "b", "a1"].map((s) => ({ subagent_id: s, owner: runtime, accepting_steer: true, status: "running", tail: `${s} says hi` }));
    server.subagents[other] = [{ subagent_id: "x", owner: otherRuntime, accepting_steer: true, status: "running" }];
    for (const s of ["a", "b"]) server.event(runtime, "subagent.start", who(s, s.toUpperCase()));
    server.event(runtime, "subagent.start", who("a1", "A1", { parent_id: "a", depth: 2 }));
    server.event(otherRuntime, "subagent.start", who("x", "X"));
    return { ...r, other, otherRuntime };
  }

  it("steers only the subagent named, in its own chat's session", async () => {
    const { server, hermes, id, runtime } = await twoChats();
    expect(await hermes.steerSubagent(id, sid("a"), "Skip the vendored code")).toBe("queued");
    expect(server.requests.filter((r) => r.method === "subagent.steer").map((r) => r.params)).toEqual([
      { session_id: runtime, subagent_id: "a", text: "Skip the vendored code" },
    ]);
    expect(server.steered).toEqual({ a: ["Skip the vendored code"] });
  });

  it("stops only the subagent named; its siblings and the other chat's subagents aren't asked", async () => {
    const { server, hermes, id, runtime, agent } = await twoChats();
    expect(await hermes.stopSubagent(id, sid("b"))).toBe(true);
    expect(server.requests.filter((r) => r.method === "subagent.interrupt").map((r) => r.params)).toEqual([{ session_id: runtime, subagent_id: "b" }]);
    expect(server.interrupted).toEqual(["b"]);
    server.event(runtime, "subagent.complete", who("b", "B", { status: "interrupted" }));
    expect([agent("a")!.state, agent("b")!.state, agent("a1")!.state]).toEqual(["running", "interrupted", "running"]);
  });

  it("reads one subagent's output apart from the chat", async () => {
    const { hermes, id, chat } = await twoChats();
    expect(await hermes.subagentOutput(id, sid("a1"))).toEqual({ available: true, text: "a1 says hi", truncated: false });
    expect(chat().items.map((i) => i.kind)).toEqual(["user"]);
  });

  it("reports what Hermes refuses: a subagent this session didn't start, or one not taking steers", async () => {
    const { server, hermes, id } = await twoChats();
    // x belongs to the other chat: this chat's session can't reach it.
    expect(await hermes.stopSubagent(id, sid("x"))).toBe(false);
    expect(await hermes.subagentOutput(id, sid("x"))).toEqual({ available: false });
    server.subagents[id][1].accepting_steer = false;
    expect(await hermes.steerSubagent(id, sid("b"), "Hurry")).toBe("rejected");
    expect(server.interrupted).toEqual([]);
    expect(server.steered).toEqual({});
  });
});
