// Bot Mode through the real transport (transport.ts) against FakeHermes as the deployed f0d94882 (ADR 0066): the
// roster, opening a bot's Bot Chat by title, creating it once, keeping it out of the chat list and search, and what a
// Hermes without Bot Mode shows. The resolution rules themselves are in bots.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { BOT_CHAT_TITLE, BotModeUnsupportedError } from "./bots";
import { connect, type Hermes } from "./transport";

const running: Hermes[] = [];
const servers: FakeHermes[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((h) => h.close()));
  // No test here may send a Bot Mode write that Hermes wouldn't check against another client's (ADR 0188).
  for (const server of servers.splice(0)) expect(server.uncheckedConfigures()).toEqual([]);
});

/** Signed in to a server with the default profile and Scribe, whose Bot Chat holds one exchange. */
async function signedIn(server = new FakeHermes(), setup: (server: FakeHermes) => void = () => {}) {
  server.sessions = [row("side", 1, { title: "Disk usage" })];
  server.otherProfiles = { scribe: [row("scribe-bot", 2, { title: BOT_CHAT_TITLE, hidden: true }), row("scribe-side", 3, { title: "Changelog wording" })] };
  server.transcripts = {
    side: [{ role: "user", text: "How full is the release disk?" }],
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
    "scribe-side": [{ role: "user", text: "Which release wording reads better?" }],
  };
  server.profileMeta = { scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  server.botAvatars = { scribe: "data:image/png;base64,iVBORw0KGgo=" };
  setup(server);
  servers.push(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  return { server, hermes };
}

const rpc = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const shownIds = (hermes: Hermes) => hermes.getSnapshot().chats.filter((c) => !c.bot).map((c) => c.id);

describe("the roster", () => {
  it("lists every profile as a bot, with its Bot Chat's preview found by title on the server", async () => {
    const { hermes } = await signedIn();
    const bots = await hermes.bots();
    expect(bots.map((b) => ({ profile: b.profile, name: b.name, description: b.description, chat: b.botChat?.id ?? null, preview: b.botChat?.preview ?? "" }))).toEqual([
      { profile: "default", name: "Hermes", description: "", chat: null, preview: "" },
      { profile: "scribe", name: "Scribe", description: "Writes release notes", chat: "scribe-bot", preview: "Release notes drafted: three fixes." },
    ]);
    expect(await hermes.botAvatar("scribe")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(await hermes.botAvatar("default")).toBeUndefined();
  });

  it("calls Bot Mode unsupported when profiles.list doesn't report Bot Chats, and diagnostics says so", async () => {
    const server = new FakeHermes();
    server.botMode = "no-canonical";
    const { hermes } = await signedIn(server);
    await expect(hermes.bots()).rejects.toBeInstanceOf(BotModeUnsupportedError);
    expect(hermes.capabilities.get("botMode")).toMatchObject({ state: "unsupported", why: expect.stringContaining("doesn't report their Bot Chats") });
  });

  it("calls Bot Mode unsupported on a Hermes without profiles.list", async () => {
    const server = new FakeHermes();
    server.botMode = "none";
    const { hermes } = await signedIn(server);
    await expect(hermes.bots()).rejects.toBeInstanceOf(BotModeUnsupportedError);
    expect(hermes.capabilities.get("botMode").state).toBe("unsupported");
  });
});

describe("the roster kept for the Bots view", () => {
  it("is read with the pictures after connecting, kept across a reconnect, and asks each picture once per connection", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Scribe"]);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
    await hermes.bots();
    await hermes.idle();
    expect(rpc(server, "profiles.get_asset")).toHaveLength(1);

    server.drop();
    expect(hermes.getSnapshot().bots?.roster).toHaveLength(2);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
    await hermes.reconnect();
    await vi.waitFor(() => expect(rpc(server, "profiles.get_asset")).toHaveLength(2));
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("drops a picture removed on the server, and shows one put back on the same connection", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    delete server.botAvatars.scribe;
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({});
    server.botAvatars.scribe = "data:image/png;base64,iVBORw0KGgoAAAA=";
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgoAAAA=" });
  });

  it("keeps the newer picture when an older ask for it answers late", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const asset = server.handlers["profiles.get_asset"];
    // Each held ask answers with the picture the server had when it was asked.
    const held: (() => void)[] = [];
    server.handlers["profiles.get_asset"] = (r) => {
      const then = { ...server.botAvatars };
      held.push(() => {
        const now = server.botAvatars;
        server.botAvatars = then;
        asset(r);
        server.botAvatars = now;
      });
    };
    delete server.botAvatars.scribe;
    await hermes.bots();
    server.botAvatars.scribe = "data:image/png;base64,QUFBQQ==";
    await hermes.bots();
    delete server.botAvatars.scribe;
    await hermes.bots();
    server.botAvatars.scribe = "data:image/png;base64,QkJCQg==";
    await hermes.bots();
    expect(held).toHaveLength(2);
    held[1]();
    held[0]();
    server.handlers["profiles.get_asset"] = asset;
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,QkJCQg==" });
  });

  it("asks again for the picture of a bot that left the roster and came back", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const scribe = server.otherProfiles.scribe;
    delete server.otherProfiles.scribe;
    await hermes.bots();
    expect(hermes.getSnapshot().botPictures).toEqual({});
    server.otherProfiles.scribe = scribe;
    server.botAvatars.scribe = "data:image/png;base64,QkJCQg==";
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,QkJCQg==" });
  });

  it("keeps the newer roster when an older read answers late", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    const older = hermes.bots();
    const newer = hermes.bots();
    server.profileMeta.scribe = { ...server.profileMeta.scribe, ui_meta: { "hermes-bots": { title: "Quill" } } };
    held[1]();
    await newer;
    server.profileMeta.scribe = { ...server.profileMeta.scribe, ui_meta: { "hermes-bots": { title: "Scribe" } } };
    held[0]();
    await older;
    server.handlers["profiles.list"] = list;
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Quill"]);
  });

  it("keeps the roster and pictures shown across a profile switch", async () => {
    const { hermes } = await signedIn();
    await hermes.idle();
    await hermes.switchProfile("scribe");
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Scribe"]);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("finds a Hermes without Bot Mode on connecting, from one profiles.list, and doesn't ask again on a reconnect", async () => {
    const { server, hermes } = await signedIn(undefined, (s) => (s.botMode = "none"));
    await hermes.idle();
    expect(hermes.capabilities.get("botMode").state).toBe("unsupported");
    expect(hermes.getSnapshot().bots).toBeUndefined();
    server.drop();
    await hermes.reconnect();
    await hermes.sync();
    await hermes.idle();
    expect(rpc(server, "profiles.list")).toHaveLength(1);
  });
});

describe("opening a bot's Bot Chat", () => {
  it("opens the one the title lookup finds, out of the chat list, and creates nothing", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("scribe");
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["scribe-side"]);
    const scribe = (await hermes.bots()).find((b) => b.profile === "scribe")!;

    const id = await hermes.openBotChat(scribe);
    expect(id).toBe("scribe-bot");
    expect(rpc(server, "session.list").map((r) => r.params)).toEqual([{ profile: "scribe", title: BOT_CHAT_TITLE, include_hidden: true, limit: 200 }]);
    expect(rpc(server, "session.create")).toEqual([]);
    await hermes.open(id);
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat).toMatchObject({ title: BOT_CHAT_TITLE, bot: true });
    expect(chat.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    // It stays out of the list through a refresh.
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["scribe-side"]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true);
  });

  it("creates a hidden Bot Chat once for a bot without one, and the next open finds it by title", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    const [a, b] = await Promise.all([hermes.openBotChat(me), hermes.openBotChat(me)]);
    expect(a).toBe(b);
    expect(rpc(server, "session.create").map((r) => r.params)).toEqual([{ profile: "default", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: "gui" }]);
    expect(rpc(server, "session.title").map((r) => r.params)).toEqual([{ session_id: "rt-1", title: BOT_CHAT_TITLE }]);
    expect(server.sessions.find((s) => s.id === a)).toMatchObject({ title: BOT_CHAT_TITLE, hidden: true });
    expect(rpc(server, "prompt.submit")).toEqual([]);
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["side"]);

    // The roster now names it, and opening again looks it up rather than remembering it.
    const again = (await hermes.bots()).find((x) => x.profile === "default")!;
    expect(again.botChat?.id).toBe(a);
    expect(await hermes.openBotChat(again)).toBe(a);
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "session.list")).toHaveLength(2);

    // Its first message doesn't rename it here, as a new chat's does: its title is what Hermes finds it by.
    await hermes.open(a);
    await hermes.send(a, "Watch the release disk tonight");
    expect(hermes.getSnapshot().chats.find((c) => c.id === a)?.title).toBe(BOT_CHAT_TITLE);
  });

  it("opens the chat another client made between the lookup and the title, instead of a second one", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    // The first lookup finds none, and another client's Bot Chat lands just after it answers, as in a race.
    const lookup = server.handlers["session.list"];
    let first = true;
    server.handlers["session.list"] = (r) => {
      if (!first) return lookup(r);
      first = false;
      server.respond(r.id, { sessions: [] });
      server.sessions.push(row("theirs", 0, { title: BOT_CHAT_TITLE, hidden: true }));
    };
    expect(await hermes.openBotChat(me)).toBe("theirs");
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE).map((s) => s.id)).toEqual(["theirs"]);
  });

  it("starts nothing when the lookup fails", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    server.titleLookupError = { code: 5000, message: "database is locked" };
    await expect(hermes.openBotChat(me)).rejects.toThrow("Couldn't look up Hermes's Bot Chat, so no new one was started: database is locked");
    expect(rpc(server, "session.create")).toEqual([]);
  });
});

describe("keeping Bot Chats out of the list and search", () => {
  it("leaves them out of search, which Hermes doesn't filter", async () => {
    const { hermes } = await signedIn();
    await hermes.switchProfile("scribe");
    await hermes.sync();
    await hermes.bots();
    const found = await hermes.search("release");
    expect(found.map((f) => f.chatId)).toEqual(["scribe-side"]);
  });

  it("leaves out a compressed Bot Chat, by its lineage, before the Bots view has ever opened", async () => {
    const { hermes } = await signedIn(new FakeHermes(), (server) => {
      // A compressed Bot Chat whose newest segment is titled otherwise (Hermes carries the title over; this one didn't).
      server.sessions.push(
        row("bot-root", 2, { title: BOT_CHAT_TITLE, hidden: true, listedAs: { id: "bot-tip", title: "Draft notes" } }),
        row("bot-tip", 1, { unlisted: true, hidden: true }),
      );
      server.transcripts["bot-root"] = [{ role: "user", text: "release checklist for the bot" }];
      server.transcripts["bot-tip"] = [{ role: "assistant", text: "Tip: the release is ready." }];
    });
    // Search reports the hit at the tip, under the tip's title; only the roster's ids say it's the Bot Chat.
    const found = await hermes.search("release");
    expect(found.map((f) => f.chatId)).toEqual(["side"]);
    // The roster reports the tip, and previews its newest message.
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    expect(me.botChat).toMatchObject({ id: "bot-root", resolvedId: "bot-tip", preview: "Tip: the release is ready." });
    expect(await hermes.openBotChat(me)).toBe("bot-tip");
  });

  it("refuses to rename a chat to the Bot Chat's title, which would make it a bot's one chat", async () => {
    const { server, hermes } = await signedIn();
    await expect(hermes.rename("side", " Bot Chat ", "Disk usage")).rejects.toThrow("“Bot Chat” is the name Hermes gives each bot's one chat. Pick another name.");
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    // Nor is a Bot Chat renamed, or its title made again.
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    const id = await hermes.openBotChat(me);
    await expect(hermes.rename(id, "Ops notes", BOT_CHAT_TITLE)).rejects.toThrow("A Bot Chat's name is how Hermes finds it, so it can't be renamed.");
    await expect(hermes.regenerateTitle(id)).rejects.toThrow("can't be renamed");
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("marks an open chat renamed to the title in another client as a Bot Chat, and keeps it out of the list", async () => {
    const { server, hermes } = await signedIn();
    await hermes.open("side");
    expect(hermes.getSnapshot().chats.find((c) => c.id === "side")?.runtimeId).toBeTruthy();
    server.sessions.find((s) => s.id === "side")!.title = BOT_CHAT_TITLE;
    await hermes.sync();
    expect(hermes.getSnapshot().chats.find((c) => c.id === "side")).toMatchObject({ bot: true, title: BOT_CHAT_TITLE });
    expect(shownIds(hermes)).toEqual([]);
  });

  it("leaves out one born visible elsewhere, by its title", async () => {
    const server = new FakeHermes();
    const { hermes } = await signedIn(server);
    server.sessions.push(row("visible-bot", 0, { title: BOT_CHAT_TITLE }));
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["side"]);
  });

  it("leaves them out of the archived view, which lists hidden rows", async () => {
    const server = new FakeHermes();
    const { hermes } = await signedIn(server);
    server.sessions.push(row("old-bot", 5, { title: BOT_CHAT_TITLE, hidden: true, archived: true }), row("old-side", 5, { title: "Old", archived: true }));
    const { found } = await hermes.browse({ archived: "only" });
    expect(found.map((f) => f.chatId)).toEqual(["old-side"]);
  });
});

describe("Editing a bot (ADR 0188)", () => {
  const png = (tail: string) => `data:image/png;base64,${btoa(`\x89PNG\r\n\x1a\n${tail}`)}`;
  const SHOWN = png("shown");
  const MINE = png("mine");
  const THEIRS = png("theirs");

  /** Signed in, with Scribe's Bot Mode block as Hermes's desktop left it at revision 3, and its picture. */
  const editing = (block: Record<string, unknown> = { title: "Scribe", color: "#112233", shape: "blob", sectionId: "s1" }, setup: (server: FakeHermes) => void = () => {}) =>
    signedIn(new FakeHermes(), (server) => {
      server.profileMeta.scribe = { description: "Writes release notes", ui_meta: { "hermes-bots": block } };
      server.uiMetaRevisions.scribe = { "hermes-bots": 3 };
      server.botAvatars.scribe = SHOWN;
      setup(server);
    });
  const stored = (server: FakeHermes, profile = "scribe") => server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as Record<string, unknown>;
  /** Another client's save arriving while ours is on its way: it lands as the server takes our first write. */
  const meanwhile = (server: FakeHermes, patch: Record<string, unknown>) => {
    server.beforeConfigure = () => {
      server.beforeConfigure = undefined;
      server.writeBotAsOtherClient("scribe", patch);
    };
  };

  it("never overwrites a title another client saved between its read and its write", async () => {
    const { server, hermes } = await editing();
    meanwhile(server, { title: "Quill" });
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    expect(stored(server).title).toBe("Quill");
    expect(saved.fields).toEqual({ title: { kind: "changedElsewhere", theirs: "Quill" } });
    expect(saved.now).toMatchObject({ title: "Quill" });
    expect(stored(server)).toMatchObject({ color: "#112233", shape: "blob", sectionId: "s1" });
    expect(hermes.getSnapshot().bots?.roster.find((b) => b.profile === "scribe")?.name).toBe("Quill");
  });

  it("never overwrites a title another client saved after Edit opened", async () => {
    const { server, hermes } = await editing();
    const opened = await hermes.botLook("scribe");
    expect(opened).toEqual({ title: "Scribe", color: "#112233", pinned: false, hidden: false, picture: SHOWN });
    server.writeBotAsOtherClient("scribe", { title: "Quill" });
    const saved = await hermes.editBot("scribe", { title: { from: opened!.title, to: "Writer" } });
    expect(stored(server).title).toBe("Quill");
    expect(saved.fields).toEqual({ title: { kind: "changedElsewhere", theirs: "Quill" } });
    expect(rpc(server, "profiles.configure")).toEqual([]);
  });

  it("a second Save after a shown conflict is still refused when Hermes moved again, and writes once the owner has seen it", async () => {
    const { server, hermes } = await editing();
    server.writeBotAsOtherClient("scribe", { title: "Quill" });
    await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    // The dialog showed "Quill", so that is what the owner saw. Another client writes again before the second Save.
    server.writeBotAsOtherClient("scribe", { title: "Ink" });
    const second = await hermes.editBot("scribe", { title: { from: "Quill", to: "Writer" } });
    expect(stored(server).title).toBe("Ink");
    expect(second.fields).toEqual({ title: { kind: "changedElsewhere", theirs: "Ink" } });
    const third = await hermes.editBot("scribe", { title: { from: "Ink", to: "Writer" } });
    expect(stored(server).title).toBe("Writer");
    expect(third.fields).toEqual({ title: { kind: "saved" } });
  });

  it("keeps a colour changed elsewhere while it saves a new title", async () => {
    const { server, hermes } = await editing();
    meanwhile(server, { color: "#abcdef", sectionId: "s2" });
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    expect(saved.fields).toEqual({ title: { kind: "saved" } });
    expect(stored(server)).toEqual({ title: "Writer", color: "#abcdef", shape: "blob", sectionId: "s2" });
    expect(saved.now).toMatchObject({ title: "Writer", color: "#abcdef" });
  });

  it("keeps every Bot Mode key it doesn't edit, and sends Hermes only the block and the revision it read", async () => {
    const others = {
      sectionId: "s1",
      sectionName: "Writers",
      groups: ["drafts", "notes"],
      group: "drafts",
      shape: "blob",
      created: 1794000000,
      screenAutoOpen: true,
      chat: "legacy-chat",
      custom: true,
      imageKind: "photo",
      futureKey: { from: "a newer desktop", n: [1, 2] },
    };
    const { server, hermes } = await editing({ title: "Scribe", color: "#112233", hidden: false, ...others });
    const saved = await hermes.editBot("scribe", { pinned: { from: false, to: true } });
    expect(saved.fields).toEqual({ pinned: { kind: "saved" } });
    expect(stored(server)).toEqual({ title: "Scribe", color: "#112233", hidden: false, pinned: true, ...others });
    expect(rpc(server, "profiles.configure").map((r) => r.params)).toEqual([
      { name: "scribe", ui_meta: { "hermes-bots": { title: "Scribe", color: "#112233", hidden: false, pinned: true, ...others } }, ui_meta_expected_revisions: { "hermes-bots": 3 } },
    ]);
    expect(server.uiMetaRevisions.scribe).toEqual({ "hermes-bots": 4 });
    expect(hermes.getSnapshot().bots?.roster.find((b) => b.profile === "scribe")?.pinned).toBe(true);
  });

  it("writes a bot's first block against revision 0", async () => {
    const { server, hermes } = await signedIn();
    const saved = await hermes.editBot("default", { hidden: { from: false, to: true } });
    expect(saved.fields).toEqual({ hidden: { kind: "saved" } });
    expect(stored(server, "default")).toEqual({ hidden: true });
    expect(rpc(server, "profiles.configure")[0].params.ui_meta_expected_revisions).toEqual({ "hermes-bots": 0 });
  });

  it("pins without writing when another client already pinned it", async () => {
    const { server, hermes } = await editing();
    server.writeBotAsOtherClient("scribe", { pinned: true });
    const saved = await hermes.editBot("scribe", { pinned: { from: false, to: true } });
    expect(saved.fields).toEqual({ pinned: { kind: "saved" } });
    expect(rpc(server, "profiles.configure")).toEqual([]);
    expect(stored(server).pinned).toBe(true);
  });

  it("writes a cleared colour and an emptied name as Hermes's desktop does", async () => {
    const { server, hermes } = await editing();
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "  " }, color: { from: "#112233", to: null } });
    expect(saved.fields).toEqual({ title: { kind: "saved" }, color: { kind: "saved" } });
    expect(stored(server)).toEqual({ title: "", shape: "blob", sectionId: "s1", custom: true });
    expect(saved.now).toMatchObject({ title: "", color: null });
  });

  it("writes nothing to a Hermes that can't check for changes", async () => {
    const { server, hermes } = await editing(undefined, (s) => (s.uiMetaCas = false));
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" }, picture: { from: SHOWN, to: MINE } });
    expect(saved.fields).toEqual({ title: { kind: "failed", failure: { kind: "noCheck" } }, picture: { kind: "failed", failure: { kind: "noCheck" } } });
    expect(rpc(server, "profiles.configure")).toEqual([]);
    expect(rpc(server, "profiles.set_asset")).toEqual([]);
    expect(stored(server).title).toBe("Scribe");
    expect(server.botAvatars.scribe).toBe(SHOWN);
  });

  it("gives up after three conflicts in a row, with nothing written", async () => {
    const { server, hermes } = await editing();
    let n = 0;
    server.beforeConfigure = () => server.writeBotAsOtherClient("scribe", { sectionId: `moved-${++n}` });
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    expect(saved.fields).toEqual({ title: { kind: "failed", failure: { kind: "contended" } } });
    expect(rpc(server, "profiles.configure")).toHaveLength(3);
    expect(stored(server)).toMatchObject({ title: "Scribe", sectionId: "moved-3" });
  });

  it("a lost answer counts as saved once the read-back has it", async () => {
    const { server, hermes } = await editing();
    const configure = server.handlers["profiles.configure"];
    // Hermes writes the block, and its answer never arrives.
    server.handlers["profiles.configure"] = (r) => {
      const respond = server.respond;
      server.respond = () => {};
      configure(r);
      server.respond = respond;
    };
    vi.useFakeTimers();
    const saving = hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    await vi.advanceTimersByTimeAsync(121_000);
    const saved = await saving;
    expect(stored(server).title).toBe("Writer");
    expect(saved.fields).toEqual({ title: { kind: "saved" } });
  });

  it("says a write Hermes refused wasn't saved, in Hermes's words", async () => {
    const { server, hermes } = await editing();
    server.handlers["profiles.configure"] = (r) => server.fail(r.id, 4000, "invalid params for profiles.configure: ui_meta: too deep");
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" } });
    expect(saved.fields).toEqual({ title: { kind: "failed", failure: { kind: "refused", status: 4000, detail: "invalid params for profiles.configure: ui_meta: too deep" } } });
    expect(stored(server).title).toBe("Scribe");
  });

  it("is gone for a profile Hermes no longer has, such as one renamed elsewhere, and its block and picture follow the rename", async () => {
    const { server, hermes } = await editing();
    await hermes.manageProfiles.rename("scribe", "quill");
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" }, picture: { from: SHOWN, to: MINE } });
    expect(saved.fields).toEqual({ title: { kind: "failed", failure: expect.objectContaining({ kind: "gone" }) }, picture: { kind: "failed", failure: expect.objectContaining({ kind: "gone" }) } });
    expect(rpc(server, "profiles.configure")).toEqual([]);
    expect(rpc(server, "profiles.set_asset")).toEqual([]);
    expect(await hermes.botLook("scribe")).toBeUndefined();
    expect(await hermes.botLook("quill")).toEqual({ title: "Scribe", color: "#112233", pinned: false, hidden: false, picture: SHOWN });
    expect(await hermes.editBot("quill", { pinned: { from: false, to: true } })).toMatchObject({ fields: { pinned: { kind: "saved" } } });
    expect(server.uiMetaRevisions).toEqual({ quill: { "hermes-bots": 4 } });
  });

  it("a picture changed elsewhere is left alone, and a new one shows without reconnecting", async () => {
    const { server, hermes } = await editing();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: SHOWN });
    server.botAvatars.scribe = THEIRS;
    const first = await hermes.editBot("scribe", { picture: { from: SHOWN, to: MINE } });
    expect(first.fields).toEqual({ picture: { kind: "changedElsewhere", theirs: THEIRS } });
    expect(server.botAvatars.scribe).toBe(THEIRS);
    expect(rpc(server, "profiles.set_asset")).toEqual([]);
    expect(rpc(server, "profiles.configure")).toEqual([]);

    const second = await hermes.editBot("scribe", { picture: { from: THEIRS, to: MINE } });
    expect(second.fields).toEqual({ picture: { kind: "saved" } });
    expect(server.botAvatars.scribe).toBe(MINE);
    expect(rpc(server, "profiles.set_asset").map((r) => r.params)).toEqual([{ name: "scribe", asset: "avatar", data: MINE }]);
    // Hermes's desktop draws a picture only for a block that says it has one.
    expect(stored(server)).toEqual({ title: "Scribe", color: "#112233", shape: "blob", sectionId: "s1", custom: true, imageKind: "photo" });
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: MINE });
  });

  it("takes a picture Hermes relabelled as saved, and clears one", async () => {
    const { server, hermes } = await editing();
    // Hermes sniffs the bytes: a PNG sent as a JPEG is stored, and read back, as a PNG.
    const mislabelled = MINE.replace("image/png", "image/jpeg");
    const saved = await hermes.editBot("scribe", { picture: { from: SHOWN, to: mislabelled } });
    expect(server.botAvatars.scribe).toBe(MINE);
    expect(saved).toMatchObject({ fields: { picture: { kind: "saved" } }, now: { picture: MINE } });

    const cleared = await hermes.editBot("scribe", { picture: { from: MINE, to: null } });
    expect(cleared).toMatchObject({ fields: { picture: { kind: "saved" } }, now: { picture: null } });
    expect(rpc(server, "profiles.set_asset").at(-1)!.params).toEqual({ name: "scribe", asset: "avatar", clear: true });
    expect(server.botAvatars).toEqual({});
    expect(stored(server)).toMatchObject({ custom: true, imageKind: "shape" });
    expect(hermes.getSnapshot().botPictures).toEqual({});
  });

  it("says a picture Hermes refused wasn't saved, and leaves the block alone", async () => {
    const { server, hermes } = await editing();
    const saved = await hermes.editBot("scribe", { picture: { from: SHOWN, to: `data:image/png;base64,${btoa("GIF89a not a png")}` } });
    expect(saved.fields).toEqual({ picture: { kind: "failed", failure: { kind: "refused", status: 4070, detail: "unsupported image format (PNG/JPEG/WebP only)" } } });
    expect(server.botAvatars.scribe).toBe(SHOWN);
    expect(rpc(server, "profiles.configure")).toEqual([]);
  });

  it("a picture that saved before a refused block write gets its imageKind on the next Save", async () => {
    const { server, hermes } = await editing();
    const configure = server.handlers["profiles.configure"];
    server.handlers["profiles.configure"] = (r) => server.respond(r.id, { ok: false, applied: { ui_meta: false } });
    const first = await hermes.editBot("scribe", { picture: { from: SHOWN, to: MINE } });
    expect(server.botAvatars.scribe).toBe(MINE);
    expect(stored(server).imageKind).toBeUndefined();
    // Not done yet: the picture stays an edit, so the dialog stays open on it.
    expect(first.fields).toEqual({ picture: { kind: "failed", failure: { kind: "refused", status: 0, detail: "" } } });

    server.handlers["profiles.configure"] = configure;
    const second = await hermes.editBot("scribe", { picture: { from: SHOWN, to: MINE } });
    expect(second.fields).toEqual({ picture: { kind: "saved" } });
    expect(rpc(server, "profiles.set_asset")).toHaveLength(1);
    expect(stored(server)).toMatchObject({ custom: true, imageKind: "photo", title: "Scribe", sectionId: "s1" });
  });

  it("a Hermes without profiles.configure loses only Pin, Hide and the look fields", async () => {
    const { server, hermes } = await editing();
    server.handlers["profiles.configure"] = (r) => server.fail(r.id, -32601, "unknown method: profiles.configure");
    const first = await hermes.editBot("scribe", { pinned: { from: false, to: true } });
    expect(first.fields).toEqual({ pinned: { kind: "failed", failure: { kind: "noRoute", action: "botLook" } } });
    expect(hermes.capabilities.lacksAction("profiles", "botLook")).toBe(true);
    expect(hermes.capabilities.lacksAction("profiles", "botPicture")).toBe(false);
    expect(hermes.capabilities.get("profiles").lacking).toEqual(["profiles.configure"]);
    expect(hermes.capabilities.get("botMode").state).toBe("supported");
    // The next one is refused here, and nothing more is sent.
    const second = await hermes.editBot("scribe", { pinned: { from: false, to: true } });
    expect(second.fields).toEqual({ pinned: { kind: "failed", failure: { kind: "noRoute", action: "botLook" } } });
    expect(rpc(server, "profiles.configure")).toHaveLength(1);
    expect((await hermes.bots()).map((b) => b.profile)).toEqual(["default", "scribe"]);
  });

  it("a Hermes without profiles.set_asset loses only the picture", async () => {
    const { server, hermes } = await editing();
    server.handlers["profiles.set_asset"] = (r) => server.fail(r.id, -32601, "unknown method: profiles.set_asset");
    const saved = await hermes.editBot("scribe", { title: { from: "Scribe", to: "Writer" }, picture: { from: SHOWN, to: MINE } });
    expect(saved.fields).toEqual({ title: { kind: "saved" }, picture: { kind: "failed", failure: { kind: "noRoute", action: "botPicture" } } });
    expect(hermes.capabilities.lacksAction("profiles", "botPicture")).toBe(true);
    expect(hermes.capabilities.lacksAction("profiles", "botLook")).toBe(false);
    expect(stored(server)).toEqual({ title: "Writer", color: "#112233", shape: "blob", sectionId: "s1" });
  });
});

describe("the stand-in Hermes's Bot Mode writes, as f0d94882 answers them", () => {
  const send = async (method: "profiles.configure" | "profiles.set_asset", params: Record<string, unknown>) => {
    const { server, hermes } = await signedIn();
    servers.pop();
    const answer = await hermes["request"](method, params).then(
      (result) => ({ result }),
      (e: { code: number; message: string }) => ({ code: e.code }),
    );
    return { server, answer };
  };

  it("refuses a param the method doesn't have, and writes nothing", async () => {
    const { server, answer } = await send("profiles.configure", { name: "scribe", ui_meta: { "hermes-bots": { title: "X" } }, ui_meta_expected_revisions: { "hermes-bots": 0 }, asset: "avatar" });
    expect(answer).toEqual({ code: 4000 });
    expect(server.profileMeta.scribe.ui_meta).toEqual({ "hermes-bots": { title: "Scribe", color: "#44aa77" } });
    expect((await send("profiles.set_asset", { name: "scribe", asset: "avatar", clear: true, mime: "image/png" })).answer).toEqual({ code: 4000 });
  });

  it("answers a stale, mistyped or missing expected revision as a conflict, and replaces the block whole without one", async () => {
    for (const expected of [{ "hermes-bots": 1 }, { "hermes-bots": "0" }, {}]) {
      const { server, answer } = await send("profiles.configure", { name: "scribe", ui_meta: { "hermes-bots": { title: "X" } }, ui_meta_expected_revisions: expected });
      expect(answer).toMatchObject({ result: { ok: false, applied: { ui_meta: false, ui_meta_conflicts: { "hermes-bots": { actual: 0 } }, ui_meta_revisions: { "hermes-bots": 0 } } } });
      expect(server.profileMeta.scribe.ui_meta).toEqual({ "hermes-bots": { title: "Scribe", color: "#44aa77" } });
    }
    const blind = await send("profiles.configure", { name: "scribe", ui_meta: { "hermes-bots": { title: "X" } } });
    expect(blind.answer).toEqual({ result: { ok: true, applied: { ui_meta: true, ui_meta_revisions: { "hermes-bots": 1 } } } });
    expect(blind.server.profileMeta.scribe.ui_meta).toEqual({ "hermes-bots": { title: "X" } });
  });

  it("answers 4064 for a profile it doesn't have", async () => {
    expect((await send("profiles.configure", { name: "nope", ui_meta: {} })).answer).toEqual({ code: 4064 });
    expect((await send("profiles.set_asset", { name: "nope", asset: "avatar", clear: true })).answer).toEqual({ code: 4064 });
  });
});
