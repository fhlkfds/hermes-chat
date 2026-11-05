// @vitest-environment jsdom
// A message steered into a running reply (ADR 0055): how it shows in the chat, live and from history, and how the turn
// it went into ends.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { turnStart, type Item } from "./model";
import { localChatCache } from "./chatCache";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const HISTORY: TranscriptMessage[] = [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }];

async function opened(server = new FakeHermes(), history = HISTORY) {
  server.sessions = [row("backup", 1, { title: "Nightly backup" })];
  server.transcripts = { backup: history };
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  await hermes.open("backup");
  return { server, hermes, chat: () => hermes.getSnapshot().chats.find((c) => c.id === "backup")! };
}

describe("A steered message", () => {
  it("shows marked as a steer when the history has one, as Hermes stores it", async () => {
    const { chat } = await opened(new FakeHermes(), [
      { role: "user", text: "Prune the snapshots" },
      { role: "tool", name: "terminal", context: "restic forget", tool_call_id: "c1" },
      { role: "user", text: "Keep the monthly ones", display_kind: "steer" },
      { role: "assistant", text: "Pruned, keeping monthlies." },
    ]);
    expect(chat().items.filter((i) => i.kind === "user")).toEqual([
      { kind: "user", id: "h-0", text: "Prune the snapshots" },
      { kind: "user", id: "h-2", text: "Keep the monthly ones", steer: true },
    ]);
  });

  it("goes into the running reply through /steer, shows at the end of the chat, and doesn't start a turn", async () => {
    const { server, hermes, chat } = await opened();
    await hermes.send("backup", "Unlock it");
    const runtime = server.runtimeIdOf("backup")!;
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Unlocking" });
    await hermes.idle();

    expect(await hermes.steer("backup", "Skip the cache")).toBe("steered");
    expect(server.last("command.dispatch")?.params).toEqual({ name: "steer", arg: "Skip the cache", session_id: runtime });
    expect(chat().items.at(-1)).toEqual({ kind: "user", id: expect.any(String), text: "Skip the cache", steer: true });
    expect(chat().running).toBe(true);

    // A provider that doesn't stream repeats the whole reply at the end: the steer doesn't make it look unanswered.
    server.event(runtime, "message.complete", { status: "complete", text: "Unlocking" });
    await hermes.idle();
    expect(chat().items.filter((i) => i.kind === "assistant").map((i) => i.text)).toEqual(["The restic repo was locked.", "Unlocking"]);

    // The Saved copy keeps the mark.
    expect(localChatCache(nas).loadTranscript("default", "backup")?.items.filter((i) => i.kind === "user" && i.steer)).toEqual([
      { kind: "user", id: expect.any(String), text: "Skip the cache", steer: true },
    ]);
  });

  it("says Hermes had no reply to steer, and shows nothing, when Hermes asks for the words as a message", async () => {
    const server = new FakeHermes();
    server.steerable = false;
    const { hermes, chat } = await opened(server);
    const before = chat().items.length;
    expect(await hermes.steer("backup", "Then tidy up")).toBe("not running");
    expect(chat().items).toHaveLength(before);
  });
});

describe("Where the last turn starts", () => {
  it("skips steered messages, which belong to the turn they went into", () => {
    const items: Item[] = [
      { kind: "user", id: "u", text: "Prune" },
      { kind: "assistant", id: "a", text: "Pruning" },
      { kind: "user", id: "s", text: "Keep monthlies", steer: true },
      { kind: "assistant", id: "b", text: "Done" },
    ];
    expect(turnStart(items)).toBe(1);
    expect(turnStart([])).toBe(0);
  });
});
