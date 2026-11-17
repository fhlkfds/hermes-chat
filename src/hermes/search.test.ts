import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { BOT_CHAT_TITLE } from "./bots";
import { BackgroundRefused, connect } from "./transport";
import { RestError } from "./pipe";

/** Signed in with one Active chat, one Settled chat and one chat settled two months ago, below the list. */
async function signedIn(server = new FakeHermes()) {
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 3, { source: "telegram", title: "NAS disks" }),
    row("old", 60, { title: "Old pulls" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked; I removed the stale lock." },
    ],
    nas: [{ role: "user", text: "How full is the NAS? The backup lands there." }],
    old: [{ role: "assistant", text: "Docker pulls the new image every night." }],
  };
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  return { server, hermes };
}

const searches = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/sessions/search");

describe("Searching all chats", () => {
  it("finds Active and Settled chats, with the matched words marked in the snippet", async () => {
    const { server, hermes } = await signedIn();
    const found = await hermes.search("backup");

    expect(searches(server).map((r) => Object.fromEntries(r.query))).toEqual([
      { q: "backup", profile: "default", limit: "50", exclude_sources: "cron" },
    ]);
    expect(found.map((f) => ({ id: f.chatId, title: f.title, source: f.source, settled: f.settled }))).toEqual([
      { id: "backup", title: "Nightly backup", source: "app", settled: false },
      { id: "nas", title: "NAS disks", source: "telegram", settled: true },
    ]);
    expect(found[0].snippet).toEqual([{ text: "Why did the " }, { text: "backup", hit: true }, { text: " fail?" }]);
  });

  it("finds chats too old for the list as Settled, and leaves out chats archived in another Hermes client", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(row("gone", 2, { archived: true }));
    server.transcripts.gone = [{ role: "user", text: "pulls from the archive" }];

    const found = await hermes.search("pulls");
    expect(found.map((f) => ({ id: f.chatId, title: f.title, settled: f.settled }))).toEqual([
      { id: "old", title: "Old pulls", settled: true },
    ]);
    expect(found[0].updatedAt).toBeLessThan(Date.now() - 59 * 86_400_000);
  });

  it("searches the profile on screen", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { work: [row("w1", 1, { title: "Deploy" })] };
    server.transcripts.w1 = [{ role: "user", text: "Ship the backup script" }];
    await hermes.switchProfile("work");

    const found = await hermes.search("backup");
    expect(searches(server).map((r) => r.query.get("profile"))).toEqual(["work"]);
    expect(found.map((f) => f.chatId)).toEqual(["w1"]);
  });

  it("fails with the server's reason", async () => {
    const { server, hermes } = await signedIn();
    server.rest["GET /api/sessions/search"] = () => {
      throw new RestError(500, '{"detail":"Search failed"}');
    };
    await expect(hermes.search("backup")).rejects.toThrow("Search failed");
  });

  it("searches nothing for a blank query", async () => {
    const { server, hermes } = await signedIn();
    expect(await hermes.search("  ")).toEqual([]);
    expect(searches(server)).toEqual([]);
  });
});

describe("Searching one profile for Everywhere", () => {
  it("answers on a background connection for a profile not on screen, with one request and nothing put in its list", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { work: [row("w1", 1, { title: "Deploy", model: "sonnet-5" })] };
    server.transcripts.w1 = [{ role: "user", text: "Ship the backup script" }];
    hermes.setRole("background");
    const listed = hermes.getSnapshot().chats;
    const sent = server.restRequests.length;

    const { hits, capped } = await hermes.searchIn("work", " backup ");

    expect(server.restRequests.slice(sent).map((r) => [r.path, Object.fromEntries(r.query)])).toEqual([
      ["/api/sessions/search", { q: "backup", profile: "work", limit: "100", exclude_sources: "cron" }],
    ]);
    expect(hits).toEqual([
      { chatId: "w1", title: "Deploy", source: "app", updatedAt: expect.any(Number), model: "sonnet-5", role: "user", find: "backup", snippet: [{ text: "Ship the " }, { text: "backup", hit: true }, { text: " script" }] },
    ]);
    expect(capped).toBe(false);
    expect(hermes.getSnapshot().chats).toBe(listed);
    expect(hermes.getSnapshot().profile).toBe("default");
    await expect(hermes.search("backup")).rejects.toBeInstanceOf(BackgroundRefused);
  });

  it("leaves out archived chats and Bot Chats, and says when Hermes gave as many chats as it gives", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(row("gone", 2, { archived: true, title: "Archived backup" }), row("bot", 2, { title: BOT_CHAT_TITLE }));
    server.transcripts.gone = [{ role: "user", text: "backup the archive" }];
    server.transcripts.bot = [{ role: "user", text: "backup, bot" }];
    expect((await hermes.searchIn("default", "backup")).hits.map((h) => h.chatId)).toEqual(["backup", "nas"]);

    server.otherProfiles = { work: Array.from({ length: 101 }, (_, i) => row(`w${i}`, 1, { title: `Backup run ${i}` })) };
    const full = await hermes.searchIn("work", "backup");
    expect([full.hits.length, full.capped]).toEqual([100, true]);
  });

  it("fails with Hermes's reason for a profile it doesn't have, and searches nothing for a blank query", async () => {
    const { server, hermes } = await signedIn();
    await expect(hermes.searchIn("nope", "backup")).rejects.toThrow(/nope/);
    const sent = searches(server).length;
    expect(await hermes.searchIn("default", "  ")).toEqual({ hits: [], capped: false });
    expect(searches(server)).toHaveLength(sent);
  });
});

describe("Opening a found chat at the match", () => {
  it("lists a chat too old for the list once it's picked, and finds the message that matched", async () => {
    const { server, hermes } = await signedIn();
    const [found] = await hermes.search("pull");
    expect(found).toMatchObject({ chatId: "old", role: "assistant", find: "pull" });

    hermes.reveal(found);
    await hermes.open("old");
    const chat = hermes.getSnapshot().chats.find((c) => c.id === "old")!;
    expect(chat).toMatchObject({ title: "Old pulls", settled: true, runtimeId: server.runtimeIdOf("old") });
    expect(hermes.locate(found)).toBe("h-0");
  });

  it("keeps a picked chat in the list after a reconnect and a refresh", async () => {
    const { server, hermes } = await signedIn();
    const [found] = await hermes.search("pull");
    hermes.reveal(found);
    await hermes.open("old");

    server.drop();
    await hermes.reconnect();
    await hermes.sync();
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toContain("old");
  });

  it("finds the message the snippet came from, not just the first one with the word", async () => {
    const { server, hermes } = await signedIn();
    server.transcripts.backup.push({ role: "user", text: "Run the backup again tonight and tell me how long it takes." });
    // Hermes ranks message hits by relevance, so the snippet can come from a later message.
    server.rest["GET /api/sessions/search"] = () => ({
      results: [{ id: "backup", session_id: "backup", title: "Nightly backup", source: "hermes-chat", role: "user", archived: false, last_active: 1, snippet: "...Run the >>>backup<<< again tonight and tell..." }],
    });
    const [found] = await hermes.search("backup");
    await hermes.open("backup");
    expect(hermes.locate(found)).toBe("h-2");
  });

  it("looks for the first matched word when the query's words aren't side by side", async () => {
    const { hermes } = await signedIn();
    const [found] = await hermes.search("restic lock");
    expect(found).toMatchObject({ chatId: "backup", find: "restic" });
    await hermes.open("backup");
    expect(hermes.locate(found)).toBe("h-1");
  });

  it("opens a chat whose title matched with nothing to find", async () => {
    const { hermes } = await signedIn();
    const [found] = await hermes.search("NAS disks");
    expect(found.chatId).toBe("nas");
    expect(found.find).toBeUndefined();
    await hermes.open("nas");
    expect(hermes.locate(found)).toBeUndefined();
  });
});
