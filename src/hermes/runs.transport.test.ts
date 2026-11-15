import { describe, expect, it, vi } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";

/** A chat whose reply ran two tools, as FakeHermes runs a "run steps" prompt, with its cost read before it. */
async function ranTools(server = new FakeHermes()) {
  server.stepDelayMs = 5;
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "First, say hi.");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  Object.assign(server.sessions.find((r) => r.id === id)!, { input_tokens: 40, output_tokens: 5, api_call_count: 1, estimated_cost_usd: 0.001, cost_status: "estimated" });
  server.event(runtime, "message.complete", { text: "Hi.", status: "complete" });
  await vi.waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.usage).toBeDefined());
  await hermes.send(id, "Please run steps on the folder.");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  await vi.waitFor(() => expect(chat().running).toBeFalsy());
  await vi.waitFor(() => expect(chat().usage?.cost).toMatchObject({ usd: expect.closeTo(0.0133) }));
  const reply = chat().items.filter((i) => i.kind === "assistant").at(-1)!;
  return { server, hermes, id, chat, reply };
}

describe("The Run view of a reply", () => {
  it("draws a reply this app watched from its events: Hermes's tool lengths, a failure judged from the result, and the turn's cost", async () => {
    const { server, hermes, id, reply } = await ranTools();
    const { run, toolProgress } = await hermes.runOf(id, reply.id);
    expect(run.source).toBe("watched");
    // Both tools start together; the one that ended first is drawn first.
    expect(run.steps.map((s) => [s.kind, s.name])).toEqual([
      ["model", "Model call"],
      ["tool", "read_file"],
      ["tool", "terminal"],
      ["model", "Model call"],
    ]);
    const [, readFile, terminal, last] = run.steps;
    expect(terminal).toMatchObject({ length: { measured: true }, args: { command: "ls" } });
    expect(terminal.failed).toBeUndefined();
    expect(readFile).toMatchObject({ failed: "File not found: notes.md", judged: true });
    expect(last).toMatchObject({ text: expect.stringContaining("no notes.md"), tokens: { calls: 1, prompt: 1200, output: 60 } });
    expect(run.cost).toBeCloseTo(0.0123);
    // FakeHermes speaks as `bf0203a` does: `message.start` carries no turn id.
    expect(run.turnIds).toBe(false);
    expect(hermes.capabilities.getSnapshot().facts.turnIds).toBe(false);
    expect(toolProgress).toEqual({ mode: "all" });
    expect(server.requests.some((r) => r.method === "spawn_tree.list" || r.method === "spawn_tree.save")).toBe(false);
  });

  it("reads a reply this app didn't watch from the turn's stored rows, every length inferred", async () => {
    const { server, id } = await ranTools();
    const later = await connect(server.openPipe);
    await later.sync();
    const chat = () => later.getSnapshot().chats.find((c) => c.id === id)!;
    await later.open(id);
    await vi.waitFor(() => expect(chat().items.some((i) => i.kind === "assistant" && i.rowId !== undefined)).toBe(true));
    const reply = chat().items.filter((i) => i.kind === "assistant").at(-1)!;
    const { run } = await later.runOf(id, reply.id);
    expect(run.source).toBe("stored");
    expect(run.steps.map((s) => [s.kind, s.name])).toEqual([
      ["model", "Model call"],
      ["tool", "read_file"],
      ["tool", "terminal"],
      ["model", "Model call"],
    ]);
    expect(run.steps.every((s) => s.length?.measured === false)).toBe(true);
    expect(run.steps[1]).toMatchObject({ args: { path: "notes.md" }, failed: "File not found: notes.md", judged: true });
    expect(run.cost).toBeUndefined();
    expect(later.capabilities.get("runView").state).toBe("supported");
  });

  it("says when Hermes doesn't send ordinary tool steps for the profile", async () => {
    const server = new FakeHermes();
    server.toolProgress = false;
    const { hermes, id, reply } = await ranTools(server);
    expect((await hermes.runOf(id, reply.id)).toolProgress).toEqual({ mode: "off" });
    expect(hermes.capabilities.getSnapshot().facts.toolProgress).toEqual({ mode: "off" });
  });

  it("keeps a failed turn's run with the reply it shows, not the error after it", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const id = await hermes.newChat();
    await hermes.send(id, "Check the logs");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Looking at the logs." });
    server.event(runtime, "error", { message: "Provider timed out" });
    const items = hermes.getSnapshot().chats.find((c) => c.id === id)!.items;
    const reply = items.find((i) => i.kind === "assistant")!;
    const { run } = await hermes.runOf(id, reply.id);
    // Every event here arrives in the same millisecond, so the two steps tie on time.
    expect(run.steps.map((s) => s.kind).sort()).toEqual(["error", "model"]);
    expect(run.steps.find((s) => s.kind === "error")!.failed).toBe("Provider timed out");
  });

  it("refuses a reply it neither watched nor has a stored row for", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    const id = await hermes.newChat();
    await hermes.send(id, "Hello");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.delta", { text: "Hello from another client." });
    const reply = hermes.getSnapshot().chats.find((c) => c.id === id)!.items.find((i) => i.kind === "assistant")!;
    await expect(hermes.runOf(id, reply.id)).rejects.toThrow(/didn't watch this reply/);
  });
});
