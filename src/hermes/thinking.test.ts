import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";

/** A new chat with a reply under way. */
async function replying(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  await hermes.send(id, "Is the dashboard up?");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  return { server, runtime, chat: () => hermes.getSnapshot().chats.find((c) => c.id === id)! };
}

describe("Showing a reply's thinking", () => {
  it("streams reasoning into thinking items between tool calls and the reply", async () => {
    const { server, runtime, chat } = await replying();
    server.event(runtime, "reasoning.delta", { text: "Check the port " });
    server.event(runtime, "reasoning.delta", { text: "first." });
    server.event(runtime, "tool.start", { tool_id: "t1", name: "terminal", preview: "curl -sk https://nas:9119/" });
    server.event(runtime, "tool.complete", { tool_id: "t1", name: "terminal", result: "exit 35" });
    server.event(runtime, "reasoning.delta", { text: "HTTPS fails; try plain HTTP." });
    server.event(runtime, "message.delta", { text: "It's up, over plain HTTP." });
    server.event(runtime, "message.complete", { text: "It's up, over plain HTTP.", reasoning: "HTTPS fails; try plain HTTP." });

    expect(chat().items.slice(1)).toEqual([
      { kind: "thinking", id: "r-1", text: "Check the port first." },
      expect.objectContaining({ kind: "tool", id: "t1", status: "done" }),
      { kind: "thinking", id: "r-3", text: "HTTPS fails; try plain HTTP." },
      { kind: "assistant", id: "a-4", text: "It's up, over plain HTTP." },
    ]);
  });

  it("shows reasoning that arrives whole, and leaves out Hermes's spinner notices", async () => {
    const { server, runtime, chat } = await replying();
    server.event(runtime, "thinking.delta", { text: "pondering..." });
    server.event(runtime, "reasoning.available", { text: "The owner wants a yes or no." });
    server.event(runtime, "message.delta", { text: "Yes." });

    expect(chat().items.slice(1)).toEqual([
      { kind: "thinking", id: "r-1", text: "The owner wants a yes or no." },
      { kind: "assistant", id: "a-2", text: "Yes." },
    ]);
  });

  it("puts the turn's reasoning before the reply when only the end of the turn carries it", async () => {
    const { server, runtime, chat } = await replying();
    server.event(runtime, "message.delta", { text: "Yes." });
    server.event(runtime, "message.complete", { text: "Yes.", reasoning: "Short answer." });

    expect(chat().items.slice(1)).toEqual([
      { kind: "thinking", id: "r-2", text: "Short answer." },
      { kind: "assistant", id: "a-1", text: "Yes." },
    ]);
  });
});
