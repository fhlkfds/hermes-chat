import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Account, launchSignIn } from "./account";
import { TRANSCRIPT_LIMIT_BYTES, localChatCache } from "./chatCache";
import { FakeHermes, row, type TranscriptMessage } from "./fakeHermes";
import { type MemoryCache, memoryCache } from "./memoryCache";
import type { Item } from "./model";
import type { SignInDetails } from "./tauriPipe";
import { type ChatCache, type Hermes, connect, readSaved } from "./transport";

const history: TranscriptMessage[] = [
  { role: "user", text: "How full is the NAS?" },
  { role: "tool", name: "terminal", context: "df -h", args: { command: "df -h /mnt/nas" } },
  { role: "assistant", text: "**82%** used." },
];
const historyItems: Item[] = [
  { kind: "user", id: "h-0", text: "How full is the NAS?" },
  { kind: "tool", id: "h-1", name: "terminal", args: { command: "df -h /mnt/nas" }, preview: "df -h", status: "done" },
  { kind: "assistant", id: "h-2", text: "**82%** used." },
];

/** A server holding the chat `nas` and its history, and a first launch that lists it. */
async function firstLaunch(cache: MemoryCache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [row("nas", 1, { pinned: true }), row("other", 2)];
  server.transcripts = { nas: [...history] };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  return { server, hermes, cache };
}

/** Launches again while the server can't be reached. */
function offlineLaunch(server: FakeHermes, cache: ChatCache) {
  server.refuse = "Can't reach the Hermes dashboard: network is unreachable";
  return readSaved(server.openPipe, server.refuse, cache);
}

const chat = (hermes: Hermes, id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;

describe("Saved copies", () => {
  it("are saved when a chat is opened, and again when a reply ends", async () => {
    const { server, hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    expect(cache.transcripts["default/nas"]).toMatchObject({ items: historyItems, savedAt: expect.any(Number) });

    await hermes.send("nas", "And the backups?");
    server.event(server.runtimeIdOf("nas")!, "message.delta", { text: "Fine." });
    server.event(server.runtimeIdOf("nas")!, "message.complete", { text: "Fine.", status: "complete" });
    expect(cache.transcripts["default/nas"].items.slice(3)).toEqual([
      { kind: "user", id: "u-3", text: "And the backups?" },
      { kind: "assistant", id: "a-4", text: "Fine." },
    ]);
    // A chat never opened has no copy.
    expect(cache.transcripts["default/other"]).toBeUndefined();
  });

  it("leave out Approvals and errors, which belong to the connection", async () => {
    const { server, hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    await hermes.send("nas", "Clean the logs");
    const runtime = server.runtimeIdOf("nas")!;
    server.event(runtime, "error", { message: "The model is overloaded." });
    server.event(runtime, "message.complete", { text: "", status: "complete" });
    expect(chat(hermes, "nas").items.map((i) => i.kind)).toContain("error");
    expect(cache.transcripts["default/nas"].items.map((i) => i.kind)).toEqual(["user", "tool", "assistant", "user"]);
  });

  it("are kept per profile", async () => {
    const { hermes, cache } = await firstLaunch();
    await hermes.open("nas");
    expect(cache.loadTranscript("work", "nas")).toBeUndefined();
  });
});

describe("Reading offline after a restart", () => {
  it("opens the saved list and a recently opened chat's Saved copy, marked as saved, without reaching Hermes", async () => {
    const first = await firstLaunch();
    await first.hermes.open("nas");
    await first.hermes.close();
    const savedAt = first.cache.transcripts["default/nas"].savedAt;

    const hermes = offlineLaunch(first.server, first.cache)!;
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: expect.stringContaining("network is unreachable") });
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["nas", "other"]);

    await hermes.open("nas");
    expect(chat(hermes, "nas")).toMatchObject({ items: historyItems, savedAt });
    expect(chat(hermes, "nas").runtimeId).toBeUndefined();
    await hermes.close();
  });

  it("leaves a chat with no Saved copy empty", async () => {
    const first = await firstLaunch();
    const hermes = offlineLaunch(first.server, first.cache)!;
    await hermes.open("other");
    expect(chat(hermes, "other")).toMatchObject({ items: [] });
    expect(chat(hermes, "other").savedAt).toBeUndefined();
    await hermes.close();
  });

  it("has nothing to read when no chat list is saved", async () => {
    const server = new FakeHermes();
    expect(offlineLaunch(server, memoryCache())).toBeUndefined();
  });

  describe("once Hermes can be reached again", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it("connects on its own, and opening the chat swaps the Saved copy for the stored history", async () => {
      const first = await firstLaunch();
      await first.hermes.open("nas");
      await first.hermes.close();
      first.server.transcripts.nas.push({ role: "user", text: "Sent from Telegram" });

      const hermes = offlineLaunch(first.server, first.cache)!;
      await hermes.open("nas");
      first.server.refuse = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hermes.getSnapshot().status).toBe("connected");

      await hermes.open("nas");
      expect(chat(hermes, "nas").items).toEqual([...historyItems, { kind: "user", id: "h-3", text: "Sent from Telegram" }]);
      expect(chat(hermes, "nas").savedAt).toBeUndefined();
      await hermes.close();
    });
  });

  it("shows the Saved copy while the history is on the way, and keeps a message sent meanwhile after it", async () => {
    const first = await firstLaunch();
    await first.hermes.open("nas");
    await first.hermes.close();

    const { server } = first;
    const hermes = await connect(server.openPipe, undefined, first.cache);
    const resume = server.handlers["session.resume"];
    let answer = () => {};
    server.handlers["session.resume"] = (r) => void (answer = () => resume(r));

    const opening = hermes.open("nas");
    expect(chat(hermes, "nas")).toMatchObject({ loading: true, items: historyItems, savedAt: expect.any(Number) });
    const sending = hermes.send("nas", "Still there?");
    answer();
    await Promise.all([opening, sending]);
    expect(chat(hermes, "nas").items.map((i) => i.id)).toEqual(["h-0", "h-1", "h-2", "u-3"]);
    expect(chat(hermes, "nas").savedAt).toBeUndefined();
  });
});

describe("Signing in at launch", () => {
  const details: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "hunter2" };

  function account(server: FakeHermes, cache: ChatCache, refuse: string): Account {
    return {
      keyring: { load: async () => "hunter2", save: async () => {}, delete: async () => {} },
      store: { load: () => details, save: () => {} },
      connect: () => Promise.reject(new Error(refuse)),
      readSaved: (_d, reason) => readSaved(server.openPipe, reason, cache),
    };
  }

  it("opens what this computer saved when Hermes can't be reached", async () => {
    const { server, cache } = await firstLaunch();
    const hermes = await launchSignIn(details, account(server, cache, "SSH failed: Connection timed out"));
    expect(hermes.getSnapshot()).toMatchObject({ status: "reconnecting", closedReason: "SSH failed: Connection timed out" });
    await hermes.close();
  });

  it("asks for the password when the dashboard turns it down", async () => {
    const { server, cache } = await firstLaunch();
    await expect(launchSignIn(details, account(server, cache, "Wrong username or password."))).rejects.toThrow("Wrong username or password.");
  });

  it("shows the sign-in screen when nothing is saved to read", async () => {
    await expect(launchSignIn(details, account(new FakeHermes(), memoryCache(), "SSH failed: Connection timed out"))).rejects.toThrow(
      "SSH failed",
    );
  });
});

describe("Saved copies in localStorage", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map([["hermes-chat.sign-in", '{"username":"liam"}']]);
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A transcript whose copy takes about `bytes` of storage. */
  const sized = (bytes: number): Item[] => [{ kind: "assistant", id: "a-0", text: "x".repeat(bytes / 2 - 100) }];

  it("load back as saved, with when they were saved", () => {
    vi.setSystemTime(1_700_000_000_000);
    localChatCache.saveTranscript("work", "a/b", historyItems);
    expect(localChatCache.loadTranscript("work", "a/b")).toEqual({ items: historyItems, savedAt: 1_700_000_000_000 });
    expect(localChatCache.loadTranscript("default", "a/b")).toBeUndefined();
  });

  it("let go of the least recently saved copies past the storage limit", () => {
    const quarter = TRANSCRIPT_LIMIT_BYTES / 4;
    for (const [i, id] of ["a", "b", "c", "d"].entries()) {
      vi.setSystemTime(1_000 + i);
      localChatCache.saveTranscript("default", id, sized(quarter - 200));
    }
    // Saving `a` again makes it the newest; `b` is now the oldest and goes when `e` needs room.
    vi.setSystemTime(2_000);
    localChatCache.saveTranscript("default", "a", sized(quarter - 200));
    vi.setSystemTime(2_001);
    localChatCache.saveTranscript("default", "e", sized(quarter - 200));

    const kept = ["a", "b", "c", "d", "e"].filter((id) => localChatCache.loadTranscript("default", id));
    expect(kept).toEqual(["a", "c", "d", "e"]);
    expect(localChatCache.bytes()).toBeLessThanOrEqual(TRANSCRIPT_LIMIT_BYTES);
  });

  it("don't keep a copy bigger than the limit", () => {
    localChatCache.saveTranscript("default", "small", sized(1_000));
    localChatCache.saveTranscript("default", "huge", sized(TRANSCRIPT_LIMIT_BYTES * 2));
    expect(localChatCache.loadTranscript("default", "huge")).toBeUndefined();
    expect(localChatCache.loadTranscript("default", "small")).toBeDefined();
  });

  it("are counted and cleared with the chat lists, leaving the sign-in", () => {
    localChatCache.save("default", []);
    localChatCache.saveTranscript("default", "nas", historyItems);
    expect(localChatCache.bytes()).toBe(
      [...store].filter(([k]) => k !== "hermes-chat.sign-in").reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0),
    );
    localChatCache.clear();
    expect(localChatCache.bytes()).toBe(0);
    expect([...store.keys()]).toEqual(["hermes-chat.sign-in"]);
  });
});
