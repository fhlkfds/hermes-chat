import { describe, expect, it } from "vitest";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache, type MemoryCache } from "./memoryCache";
import { connect } from "./transport";

async function listed(rows: ReturnType<typeof row>[], cache: MemoryCache = memoryCache(), server = new FakeHermes()) {
  server.sessions = rows;
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  await hermes.idle();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const stored = (id: string) => server.sessions.find((s) => s.id === id)!;
  return { server, hermes, cache, chat, stored };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => wait(0);

const patches = (server: FakeHermes, id: string) =>
  server.restRequests.filter((r) => r.method === "PATCH" && r.path === `/api/sessions/${id}`).map((r) => r.body);

/** Answers the next list read with the list as it stands now, but only once the returned function is called. */
function staleList(server: FakeHermes) {
  const list = server.rest["GET /api/sessions"];
  let answer!: () => void;
  server.rest["GET /api/sessions"] = (req: RestRequest) => {
    const stale = structuredClone(list(req));
    server.rest["GET /api/sessions"] = list;
    return new Promise((resolve) => (answer = () => resolve(stale)));
  };
  return () => answer();
}

describe("Pinning a chat", () => {
  it("keeps it on this computer, and moves a Settled chat to Active", async () => {
    const { server, hermes, cache, chat, stored } = await listed([row("a", 1), row("b", 2, { pinned: true })]);
    await hermes.pin("a");
    expect(chat("a")).toMatchObject({ pinned: true, settled: false });
    expect(stored("a").pinned).toBe(true);
    expect(cache.kept).toEqual({ default: { pinned: ["a"], snoozed: {} } });
    // Only the Active flag goes to Hermes.
    expect(patches(server, "a")).toEqual([{ pinned: true, profile: "default" }]);
    expect(chat("b").pinned).toBeUndefined();
  });

  it("is still pinned at the next launch", async () => {
    const { server, cache } = await listed([row("a", 1, { pinned: true })], memoryCache({ kept: { default: { pinned: ["a"], snoozed: {} } } }));
    const again = await connect(server.openPipe, undefined, cache);
    expect(again.getSnapshot().chats.find((c) => c.id === "a")?.pinned).toBe(true);
  });

  it("ends when the chat is settled, here or in another Hermes client", async () => {
    const { hermes, chat, stored, cache } = await listed([row("a", 1, { pinned: true }), row("b", 1, { pinned: true })]);
    await hermes.pin("a");
    await hermes.pin("b");
    await hermes.settle("a");
    expect(chat("a")).toMatchObject({ settled: true, pinned: undefined });
    stored("b").pinned = false;
    await hermes.sync();
    expect(chat("b")).toMatchObject({ settled: true, pinned: undefined });
    expect(cache.kept).toEqual({});
  });

  it("keeps a chat in the list however long it has been quiet", async () => {
    const { chat } = await listed([row("old", 90, { pinned: true })], memoryCache({ kept: { default: { pinned: ["old"], snoozed: {} } } }));
    expect(chat("old")).toMatchObject({ pinned: true, settled: false });
  });

  it("unpins without settling", async () => {
    const { hermes, chat } = await listed([row("a", 1, { pinned: true })]);
    await hermes.pin("a");
    hermes.unpin("a");
    expect(chat("a")).toMatchObject({ pinned: undefined, settled: false });
  });
});

describe("Snoozing a chat", () => {
  it("settles it now, and brings it back to Active, unread and at the top, when the time comes", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 3, { pinned: true }), row("b", 1, { pinned: true })]);
    const until = Date.now() + 40;
    await hermes.snooze("a", until);
    expect(chat("a")).toMatchObject({ settled: true, snoozedUntil: until });
    expect(stored("a").pinned).toBe(false);
    await wait(80);
    await hermes.idle();
    expect(chat("a")).toMatchObject({ settled: false, unread: true, snoozedUntil: undefined });
    expect(chat("a").updatedAt).toBeGreaterThanOrEqual(until);
    expect(chat("a").updatedAt).toBeGreaterThan(chat("b").updatedAt);
    // The Active flag and the read watermark go out side by side.
    expect(patches(server, "a")).toEqual([{ pinned: false, profile: "default" }, expect.anything(), expect.anything()]);
    expect(patches(server, "a")).toContainEqual({ pinned: true, profile: "default" });
    expect(patches(server, "a")).toContainEqual({ unread: true, profile: "default" });
    await hermes.sync();
    expect(chat("a")).toMatchObject({ settled: false, unread: true });
  });

  it("wakes a chat whose time passed while the app was closed, at the first sync", async () => {
    const kept = { default: { pinned: [], snoozed: { a: Date.now() - 60_000 } } };
    const { chat, stored } = await listed([row("a", 1)], memoryCache({ kept }));
    expect(chat("a")).toMatchObject({ settled: false, unread: true, snoozedUntil: undefined });
    expect(stored("a").pinned).toBe(true);
  });

  it("doesn't mark the chat on screen unread when it wakes", async () => {
    const { hermes, chat } = await listed([row("a", 1, { pinned: true })]);
    await hermes.open("a");
    await hermes.snooze("a", Date.now() + 20);
    await wait(50);
    await hermes.idle();
    expect(chat("a")).toMatchObject({ settled: false, unread: false });
  });

  it("unpins a pinned chat", async () => {
    const { hermes, chat } = await listed([row("a", 1, { pinned: true })]);
    await hermes.pin("a");
    await hermes.snooze("a", Date.now() + 60_000);
    expect(chat("a")).toMatchObject({ pinned: undefined, settled: true });
  });

  it("wakes now, without the dot, when the owner asks", async () => {
    const { hermes, chat, cache } = await listed([row("a", 1, { pinned: true })]);
    await hermes.snooze("a", Date.now() + 60_000);
    await hermes.unsnooze("a");
    expect(chat("a")).toMatchObject({ settled: false, snoozedUntil: undefined });
    expect(chat("a").unread).toBeFalsy();
    expect(cache.kept).toEqual({});
  });

  it("ends when the owner sends a message in the chat", async () => {
    const { hermes, chat } = await listed([row("a", 1, { pinned: true })]);
    await hermes.snooze("a", Date.now() + 60_000);
    await hermes.send("a", "Actually, one more thing");
    expect(chat("a")).toMatchObject({ settled: false, snoozedUntil: undefined });
  });

  it("ends when another Hermes client moves the chat to Active", async () => {
    const { hermes, chat, stored } = await listed([row("a", 1, { pinned: true })]);
    await hermes.snooze("a", Date.now() + 60_000);
    stored("a").pinned = true;
    await hermes.sync();
    expect(chat("a")).toMatchObject({ settled: false, snoozedUntil: undefined });
  });

  it("wakes a chat in another profile on that profile's server store", async () => {
    const server = new FakeHermes();
    server.otherProfiles.work = [row("w", 1)];
    const kept = { work: { pinned: [], snoozed: { w: Date.now() - 1 } } };
    const { cache } = await listed([row("a", 1)], memoryCache({ kept }), server);
    expect(patches(server, "w")).toEqual([{ pinned: true, unread: true, profile: "work" }]);
    expect(server.otherProfiles.work[0].pinned).toBe(true);
    expect(cache.kept).toEqual({});
  });

  it("keeps a snoozed chat in the list however long it has been quiet", async () => {
    const kept = { default: { pinned: [], snoozed: { old: Date.now() + 60_000 } } };
    const { chat } = await listed([row("old", 90)], memoryCache({ kept }));
    expect(chat("old")).toMatchObject({ settled: true, snoozedUntil: kept.default.snoozed.old });
  });

  it("forgets the snooze of a deleted chat", async () => {
    const { hermes, cache } = await listed([row("a", 1, { pinned: true })]);
    await hermes.snooze("a", Date.now() + 60_000);
    await hermes.delete("a");
    expect(cache.kept).toEqual({});
  });
});

describe("Renaming a chat", () => {
  it("shows the new title at once and stores it in Hermes", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 1)]);
    const renaming = hermes.rename("a", "  Nightly backup  ");
    expect(chat("a").title).toBe("Nightly backup");
    await renaming;
    expect(patches(server, "a")).toEqual([{ title: "Nightly backup", profile: "default" }]);
    expect(stored("a").title).toBe("Nightly backup");
  });

  it("isn't undone by a list read before the rename", async () => {
    const { server, hermes, chat } = await listed([row("a", 1)]);
    const answer = staleList(server);
    const syncing = hermes.sync();
    await tick();
    await hermes.rename("a", "Nightly backup");
    answer();
    await syncing;
    expect(chat("a").title).toBe("Nightly backup");
  });

  it("puts the old title back and says why when Hermes refuses", async () => {
    const { hermes, chat } = await listed([row("a", 1), row("b", 1, { title: "Taken" })]);
    await expect(hermes.rename("a", "Taken")).rejects.toThrow("already in use");
    expect(chat("a").title).toBe("Chat a");
  });

  it("ignores an empty title", async () => {
    const { server, hermes, chat } = await listed([row("a", 1)]);
    await hermes.rename("a", "   ");
    expect(chat("a").title).toBe("Chat a");
    expect(patches(server, "a")).toEqual([]);
  });
});

describe("Regenerating a title", () => {
  it("asks Hermes's model for a title from the whole chat, then renames the chat to it", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 1)]);
    server.transcripts.a = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi! What can I do?" },
      { role: "tool", name: "terminal", context: "crontab -l" },
      { role: "user", text: "The nightly backup cron stopped running" },
    ];
    expect(await hermes.regenerateTitle("a")).toBe("Fix nightly backup cron");
    const asked = server.last("llm.oneshot")!.params;
    expect(asked).toMatchObject({ task: "title_generation", profile: "default", session_id: server.runtimeIdOf("a") });
    expect(asked.input).toBe("User: hello\n\nAssistant: Hi! What can I do?\n\nUser: The nightly backup cron stopped running");
    expect(chat("a").title).toBe("Fix nightly backup cron");
    expect(stored("a").title).toBe("Fix nightly backup cron");
  });

  it("reads a title out of a fenced or chatty answer", async () => {
    const { server, hermes } = await listed([row("a", 1)]);
    server.transcripts.a = [{ role: "user", text: "hi" }];
    server.oneshotReply = '```json\n{"title": "Say hello."}\n```';
    expect(await hermes.regenerateTitle("a")).toBe("Say hello");
    server.oneshotReply = '"Greeting check-in"';
    expect(await hermes.regenerateTitle("a")).toBe("Greeting check-in");
  });

  it("refuses a chat with nothing in it yet", async () => {
    const { server, hermes } = await listed([row("a", 1)]);
    await expect(hermes.regenerateTitle("a")).rejects.toThrow("nothing in this chat");
    expect(server.last("llm.oneshot")).toBeUndefined();
  });
});

describe("Marking a chat unread", () => {
  it("shows the dot here and in every Hermes client", async () => {
    const { server, hermes, chat, stored } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 })]);
    await hermes.setUnread("a", true);
    expect(chat("a").unread).toBe(true);
    expect(patches(server, "a")).toEqual([{ unread: true, profile: "default" }]);
    expect(stored("a").last_read_at).toBe(0);
    await hermes.sync();
    expect(chat("a").unread).toBe(true);
  });

  it("isn't undone by a list read before the write", async () => {
    const { server, hermes, chat } = await listed([row("a", 1, { last_read_at: Date.now() / 1000 })]);
    const answer = staleList(server);
    const syncing = hermes.sync();
    await tick();
    await hermes.setUnread("a", true);
    answer();
    await syncing;
    expect(chat("a").unread).toBe(true);
  });

  it("shows the dot on the chat on screen, which the owner is leaving", async () => {
    const { hermes, chat } = await listed([row("a", 1)]);
    await hermes.open("a");
    await hermes.idle();
    await hermes.setUnread("a", true);
    await hermes.sync();
    expect(chat("a").unread).toBe(true);
  });

  it("marks it read again", async () => {
    const { hermes, chat } = await listed([row("a", 1, { last_read_at: 0 })]);
    await hermes.setUnread("a", false);
    await hermes.sync();
    expect(chat("a").unread).toBe(false);
  });
});

describe("Copying a chat", () => {
  it("gives its title and messages as Markdown, loading the chat first", async () => {
    const { server, hermes } = await listed([row("a", 1, { title: "Nightly backup" })]);
    server.transcripts.a = [
      { role: "user", text: "Why did the backup fail?" },
      { role: "tool", name: "terminal", context: "journalctl -u backup" },
      { role: "assistant", text: "The disk was full.\n\n- Cleared `/var/log/old`" },
    ];
    expect(await hermes.transcript("a")).toBe(
      "# Nightly backup\n\n**You:** Why did the backup fail?\n\n**Hermes:** The disk was full.\n\n- Cleared `/var/log/old`\n",
    );
  });

  it("names the files sent with a message", async () => {
    const { server, hermes } = await listed([row("a", 1, { title: "Logo" })]);
    server.files["/home/liam/logo.png"] = "png";
    await hermes.send("a", "Thoughts?", await hermes.checkAttachments(["/home/liam/logo.png"]).then((c) => c.attachments));
    expect(await hermes.transcript("a")).toBe("# Logo\n\n**You:** Thoughts?\n\n_Attached: logo.png_\n");
  });
});

describe("A chat's working folder", () => {
  it("is the folder Hermes stored for the chat", async () => {
    const { hermes } = await listed([row("a", 1, { cwd: "/home/liam/projects/site" })]);
    expect(await hermes.workingFolder("a")).toBe("/home/liam/projects/site");
  });

  it("falls back to the git repository's root", async () => {
    const { hermes } = await listed([row("a", 1, { git_repo_root: "/home/liam/projects/site" })]);
    expect(await hermes.workingFolder("a")).toBe("/home/liam/projects/site");
  });

  it("says so when Hermes has none", async () => {
    const { hermes } = await listed([row("a", 1)]);
    await expect(hermes.workingFolder("a")).rejects.toThrow("hasn't stored a working folder");
  });
});
