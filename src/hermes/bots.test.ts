// Contract tests for Bot Mode (ADR 0066), mirroring Hermes's own in apps/desktop/src/plugins/hermes-bots/:
// bot-row-opens-canonical-chat, canonical-chat-creation, canonical-chat-adopt-on-conflict, canonical-chat-registry
// (no stored pointer) and new-compact-guard. The transport's side (hidden from the list and search, the open) is in
// botsTransport.test.ts.
import { describe, expect, it } from "vitest";
import { BOT_CHAT_TITLE, BotChats, BotModeUnsupportedError, botActivity, botName, isBotChat, isBotChatOnScreen, isBotChatTitle, newInBotChatNote, rosterOf, type BotRpc } from "./bots";

type Call = { method: string; params: Record<string, unknown> };

/** A fake connection: each method answers from `answers`, in order when it is a list. */
function rpcOf(answers: Record<string, unknown | unknown[] | ((p: Record<string, unknown>) => unknown)>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const rpc: BotRpc = async (method, params) => {
    calls.push({ method, params });
    const a = queues.get(method);
    const next = Array.isArray(a) ? a.shift() : typeof a === "function" ? (a as (p: Record<string, unknown>) => unknown)(params) : a;
    if (next instanceof Error) throw next;
    if (next === undefined) throw Object.assign(new Error(`no answer for ${method}`), { code: -32601 });
    return next;
  };
  return { rpc, calls, methods: () => calls.map((c) => c.method) };
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const listed = (...rows: Record<string, unknown>[]) => ({ sessions: rows });

describe("the bot row opens its Bot Chat", () => {
  it("opens the row the title lookup finds, at its lineage tip, and creates nothing", async () => {
    const { rpc, calls, methods } = rpcOf({ "session.list": listed({ id: "root-1", resolved_id: "tip-9", title: BOT_CHAT_TITLE }) });
    const opened = await new BotChats(rpc, "gui").open("scribe", "Scribe", true);
    expect(opened).toEqual({ registryId: "root-1", openId: "tip-9", created: false });
    expect(methods()).toEqual(["session.list"]);
    expect(calls[0].params).toEqual({ profile: "scribe", title: BOT_CHAT_TITLE, include_hidden: true, limit: 200 });
  });

  it("looks it up by title on every open and keeps no session id between opens", async () => {
    // The first lookup finds one row, the second a different one (say, restored from a backup): each open follows the
    // registry, never what an earlier open found.
    const { rpc, methods } = rpcOf({ "session.list": [listed({ id: "a", title: BOT_CHAT_TITLE }), listed({ id: "b", title: BOT_CHAT_TITLE })] });
    const chats = new BotChats(rpc, "gui");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("a");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("b");
    expect(methods()).toEqual(["session.list", "session.list"]);
  });

  it("never picks a row of another title, such as the newest chat, and creates nothing on such an answer", async () => {
    // A Hermes that ignored `title` lists its newest chats: that says nothing about whether a Bot Chat exists.
    const { rpc, methods } = rpcOf({ "session.list": listed({ id: "newest", title: "Release notes" }), "session.create": { session_id: "rt-1", stored_session_id: "s-1" } });
    await expect(new BotChats(rpc, "gui").open("ops", "Ops", false)).rejects.toThrow("Hermes answered the lookup of Ops's Bot Chat in a way this app doesn't read");
    expect(methods()).toEqual(["session.list"]);
  });

  it("creates nothing on a lookup answer it can't read", async () => {
    for (const answer of [{}, { sessions: "none" }, { sessions: [{ title: BOT_CHAT_TITLE }] }, { sessions: [null] }, null]) {
      const { rpc, methods } = rpcOf({ "session.list": () => answer, "session.create": { session_id: "rt-1", stored_session_id: "s-1" } });
      await expect(new BotChats(rpc, "gui").open("ops", "Ops", false), JSON.stringify(answer)).rejects.toThrow(/in a way this app doesn't read/);
      expect(methods()).toEqual(["session.list"]);
    }
  });
});

describe("creating a Bot Chat", () => {
  it("creates one only when the lookup finds none: hidden, following the profile's config, titled at once", async () => {
    const { rpc, calls } = rpcOf({
      "session.list": listed(),
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": { title: BOT_CHAT_TITLE, pending: false },
    });
    expect(await new BotChats(rpc, "gui").open("scribe", "Scribe", false)).toEqual({ registryId: "s-1", openId: "s-1", created: true });
    expect(calls[1]).toEqual({ method: "session.create", params: { profile: "scribe", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: "gui" } });
    // Titled by its runtime id, which stores the row under the title.
    expect(calls[2]).toEqual({ method: "session.title", params: { session_id: "rt-1", title: BOT_CHAT_TITLE } });
    // No intro is sent: the owner speaks first.
    expect(calls.some((c) => c.method === "prompt.submit")).toBe(false);
  });

  it("creates once for a double click", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { rpc, methods } = rpcOf({
      "session.list": async () => {
        await held;
        return listed();
      },
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": { title: BOT_CHAT_TITLE },
    });
    const chats = new BotChats(rpc, "gui");
    const first = chats.open("ops", "Ops", false);
    const second = chats.open("ops", "Ops", false);
    release();
    expect(await first).toEqual(await second);
    expect(methods().filter((m) => m === "session.create")).toHaveLength(1);
  });

  it("adopts the chat another client made meanwhile, when the title turns out to be taken", async () => {
    const { rpc, methods } = rpcOf({
      "session.list": [listed(), listed({ id: "theirs", resolved_id: "theirs", title: BOT_CHAT_TITLE })],
      "session.create": { session_id: "rt-1", stored_session_id: "mine" },
      "session.title": rpcError(4022, "Title 'Bot Chat' is already in use by session theirs"),
    });
    expect(await new BotChats(rpc, "gui").open("ops", "Ops", false)).toEqual({ registryId: "theirs", openId: "theirs", created: false });
    expect(methods()).toEqual(["session.list", "session.create", "session.title", "session.list"]);
  });

  it("says so when Hermes didn't name the new chat for another reason, and doesn't claim it", async () => {
    const { rpc } = rpcOf({
      "session.list": listed(),
      "session.create": { session_id: "rt-1", stored_session_id: "s-1" },
      "session.title": rpcError(5000, "database is locked"),
    });
    await expect(new BotChats(rpc, "gui").open("ops", "Ops", false)).rejects.toThrow("Hermes started Ops's Bot Chat but didn't name it: database is locked");
  });
});

describe("failing closed", () => {
  it("creates nothing when the lookup fails", async () => {
    const { rpc, methods } = rpcOf({ "session.list": new Error("timed out") });
    await expect(new BotChats(rpc, "gui").open("ops", "Ops", false)).rejects.toThrow("Couldn't look up Ops's Bot Chat, so no new one was started: timed out");
    expect(methods()).toEqual(["session.list"]);
  });

  it("creates nothing when the lookup comes back empty but the roster last named a Bot Chat", async () => {
    const { rpc, methods } = rpcOf({ "session.list": listed() });
    await expect(new BotChats(rpc, "gui").open("ops", "Ops", true)).rejects.toThrow("Hermes didn't confirm Ops's Bot Chat this time");
    expect(methods()).toEqual(["session.list"]);
  });

  it("calls a Hermes without the title lookup unsupported", async () => {
    const { rpc } = rpcOf({ "session.list": rpcError(-32601, "method not found") });
    await expect(new BotChats(rpc, "gui").open("ops", "Ops", false)).rejects.toBeInstanceOf(BotModeUnsupportedError);
  });

  it("lets a failed open be tried again", async () => {
    const { rpc } = rpcOf({ "session.list": [new Error("dropped"), listed({ id: "s-1", title: BOT_CHAT_TITLE })] });
    const chats = new BotChats(rpc, "gui");
    await expect(chats.open("ops", "Ops", true)).rejects.toThrow("dropped");
    expect((await chats.open("ops", "Ops", true)).openId).toBe("s-1");
  });
});

describe("the roster", () => {
  const row = (over: Record<string, unknown>) => ({ name: "scribe", path: "/x", is_default: false, description: "", display_name: "", canonical_session: null, ui_meta_revisions: {}, has_avatar: false, ...over });

  it("reads each profile as a bot, with its Bot Chat as profiles.list reports it", () => {
    const bots = rosterOf({
      profiles: [
        row({ name: "default", is_default: true }),
        row({
          description: "Writes  release notes",
          has_avatar: true,
          ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", pinned: true, chat: "a-stale-pointer" } },
          last_session: { id: "side", last_active: 100 },
          canonical_session: { id: "root", resolved_id: "tip", root_title: BOT_CHAT_TITLE, title: BOT_CHAT_TITLE, preview: "Draft the\nnotes", last_active: 200, message_count: 9, live_message_count: 3 },
        }),
      ],
      bot_mode_protocol: true,
    });
    expect(bots).toEqual([
      { profile: "default", name: "Hermes", description: "", isDefault: true, hasAvatar: false, hidden: false, pinned: false, botChat: null, lastActive: 0 },
      {
        profile: "scribe",
        name: "Scribe",
        description: "Writes release notes",
        isDefault: false,
        hasAvatar: true,
        color: "#44aa77",
        hidden: false,
        pinned: true,
        botChat: { id: "root", resolvedId: "tip", preview: "Draft the notes", lastActive: 200_000, messageCount: 3 },
        lastActive: 200_000,
      },
    ]);
  });

  it("names a bot by its title, then its display name, then the profile", () => {
    expect(botName({ name: "ops", display_name: "Operator", ui_meta: { "hermes-bots": { title: "Ops Desk" } } })).toBe("Ops Desk");
    expect(botName({ name: "ops", display_name: "Operator" })).toBe("Operator");
    expect(botName({ name: "release_notes-bot" })).toBe("Release Notes Bot");
    expect(botName({ name: "default" })).toBe("Hermes");
  });

  it("is unsupported when the rows don't report a Bot Chat at all", () => {
    expect(() => rosterOf({ profiles: [{ name: "default", is_default: true }] })).toThrow(BotModeUnsupportedError);
    expect(() => rosterOf({ nope: true })).toThrow(BotModeUnsupportedError);
  });
});

describe("telling a Bot Chat apart", () => {
  it("matches the title exactly", () => {
    expect(isBotChatTitle("Bot Chat")).toBe(true);
    expect(isBotChatTitle(" Bot Chat ")).toBe(true);
    expect(isBotChatTitle("Bot Chat #2")).toBe(false);
    expect(isBotChatTitle(undefined)).toBe(false);
  });

  it("counts a chat as a Bot Chat when it was opened as one, or has the title, however it got it", () => {
    expect(isBotChat({ bot: true, title: "anything" })).toBe(true);
    // Renamed to the title in another client: in Hermes it is now the profile's Bot Chat.
    expect(isBotChat({ title: "Bot Chat" })).toBe(true);
    expect(isBotChat({ title: "Disk usage" })).toBe(false);
  });

  it("knows the Bot Chat on screen by its registry row or its lineage tip, for the /new guard", () => {
    const bot = { botChat: { id: "root-1", resolvedId: "tip-9", preview: "", lastActive: 0, messageCount: 0 } };
    expect(isBotChatOnScreen(bot, "root-1")).toBe(true);
    expect(isBotChatOnScreen(bot, "tip-9")).toBe(true);
    expect(isBotChatOnScreen(bot, "side-chat")).toBe(false);
    expect(isBotChatOnScreen({ botChat: null }, "root-1")).toBe(false);
    expect(isBotChatOnScreen(bot, undefined)).toBe(false);
  });
});


describe("a bot's activity", () => {
  const bot = { botChat: { id: "root", resolvedId: "tip", preview: "", lastActive: 0, messageCount: 0 } };
  it("follows its Bot Chat only, by registry row or lineage tip", () => {
    expect(botActivity(bot, [{ chatId: "tip", status: "working" }])).toBe("replying");
    expect(botActivity(bot, [{ chatId: "root", status: "waiting" }])).toBe("needs-you");
    // A side-chat working in the same profile isn't the bot's row.
    expect(botActivity(bot, [{ chatId: "side", status: "working" }])).toBeUndefined();
    expect(botActivity({ botChat: null }, [{ chatId: "root", status: "working" }])).toBeUndefined();
  });

  it("prefers what this connection holds for the open Bot Chat, which is fresher than the last check", () => {
    expect(botActivity(bot, [{ chatId: "root", status: "working" }], { running: false })).toBeUndefined();
    expect(botActivity(bot, [], { running: true })).toBe("replying");
    expect(botActivity(bot, [], { running: true, waiting: true })).toBe("needs-you");
  });

  it("says why /new compacted instead", () => {
    expect(newInBotChatNote({ kind: "compacted" })).toMatch(/one continuous conversation, so \/new compacts it .* Hermes compacted it\.$/);
    expect(newInBotChatNote({ kind: "nothing" })).toMatch(/nothing to compact yet/);
    expect(newInBotChatNote({ kind: "busy", message: "Hermes is already compacting this chat." })).toMatch(/already compacting/);
  });
});
