// Chat links (ADR 0037): reading them strictly, the opaque connection references they carry, and looking a linked
// chat up before anything moves.
import { describe, expect, it } from "vitest";
import type { SavedSignIn } from "./account";
import { LINK_MAX, REFS_KEY, checkConnection, connectionKey, connectionLabel, connectionRefs, formatChatLink, locateChat, parseChatLink } from "./chatLinks";

const REF = "abcdefghijklmnopqrst";
const good = (over: Record<string, string> = {}) => `hermes-chat://chat?${new URLSearchParams({ v: "1", connection: REF, profile: "work", id: "20261103_101500_ab12cd", ...over })}`;
const reason = (raw: unknown) => {
  const p = parseChatLink(raw);
  return p.ok ? undefined : p.reason;
};

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const home: SavedSignIn = { mode: "url", sshTarget: "", url: "https://hermes.example.com", username: "liam" };
const lab: SavedSignIn = { mode: "ssh", sshTarget: "liam@lab", url: "", username: "liam" };

describe("Reading a chat link", () => {
  it("reads the connection, profile and chat from a link it made", () => {
    const link = { connection: REF, profile: "default", chatId: "20261103_101500_ab12cd" };
    expect(parseChatLink(formatChatLink(link))).toEqual({ ok: true, link });
    expect(parseChatLink(good())).toEqual({ ok: true, link: { connection: REF, profile: "work", chatId: "20261103_101500_ab12cd" } });
    // The scheme is case-insensitive, as URLs are; a trailing slash is the same link.
    expect(parseChatLink(good().replace("hermes-chat:", "HERMES-CHAT:")).ok).toBe(true);
    expect(parseChatLink(good().replace("chat?", "chat/?")).ok).toBe(true);
    // An Imported transcript's id, made from its file.
    expect(parseChatLink(good({ id: "20240101_000000_0a1b2c3d4e5f" })).ok).toBe(true);
  });

  it("refuses what isn't a string or is empty", () => {
    expect(reason(undefined)).toMatch(/empty/);
    expect(reason("")).toMatch(/empty/);
    expect(reason(42)).toMatch(/empty/);
  });

  it("refuses a link over the length limit before reading it", () => {
    const long = good({ id: "a".repeat(LINK_MAX) });
    expect(reason(long)).toMatch(/too long/);
    expect(reason(`hermes-chat://chat?${"x".repeat(LINK_MAX)}`)).toMatch(/too long/);
  });

  it("refuses other schemes and other kinds of link", () => {
    expect(reason(good().replace("hermes-chat:", "https:"))).toMatch(/doesn't start with hermes-chat/);
    expect(reason(good().replace("hermes-chat:", "file:"))).toMatch(/doesn't start with hermes-chat/);
    expect(reason("not a link")).toMatch(/spaces/);
    expect(reason("hermes-chat")).toMatch(/can read/);
    expect(reason(good().replace("//chat", "//settings"))).toMatch(/Only links to a chat/);
    expect(reason(good().replace("//chat", "//Chat"))).toMatch(/Only links to a chat/);
    expect(reason(good().replace("//chat", "//ch%61t"))).toMatch(/Only links to a chat/);
    expect(reason(good().replace("chat?", "chat/run?"))).toMatch(/Only links to a chat/);
    expect(reason(good().replace("chat?", "chat:8080?"))).toMatch(/Only links to a chat/);
    expect(reason(`${good()}#send`)).toMatch(/Only links to a chat/);
  });

  it("refuses a link carrying a sign-in", () => {
    expect(reason(good().replace("//chat", "//liam:hunter2@chat"))).toMatch(/sign-in/);
    expect(reason(good().replace("//chat", "//liam@chat"))).toMatch(/sign-in/);
  });

  it("refuses unknown, missing and repeated parts, so nothing rides along", () => {
    expect(reason(`${good()}&send=hello`)).toMatch(/parts a chat link doesn't have/);
    expect(reason(`${good()}&password=hunter2`)).toMatch(/parts a chat link doesn't have/);
    expect(reason(`${good()}&url=https%3A%2F%2Fevil.example`)).toMatch(/parts a chat link doesn't have/);
    expect(reason(`${good()}&id=other`)).toMatch(/twice/);
    expect(reason(good().replace("v=1&", ""))).toMatch(/version/);
    expect(reason(good({ v: "2" }))).toMatch(/newer Hermes Chat/);
    expect(reason(good().replace(/&id=[^&]*/, ""))).toMatch(/chat id/);
  });

  it("checks every id after decoding, whatever the encoding", () => {
    expect(reason(good({ profile: "../etc" }))).toMatch(/profile/);
    expect(reason(good().replace("profile=work", "profile=%2E%2E%2Fetc"))).toMatch(/profile/);
    expect(reason(good().replace("profile=work", "profile=Work"))).toMatch(/profile/);
    expect(reason(good().replace("profile=work", "profile=w%00rk"))).toMatch(/profile/);
    expect(reason(good({ id: "../../api/env" }))).toMatch(/chat id/);
    expect(reason(good({ id: ".." }))).toMatch(/chat id/);
    expect(reason(good({ id: "a/b" }))).toMatch(/chat id/);
    // Double-encoded: decoded once, the id still has a %.
    expect(reason(good().replace(/id=[^&]*/, "id=a%252Fb"))).toMatch(/chat id/);
    expect(reason(good().replace(/id=[^&]*/, "id=a+b"))).toMatch(/chat id/);
    expect(reason(good({ id: "x".repeat(129) }))).toMatch(/chat id/);
    expect(reason(good({ connection: "short" }))).toMatch(/connection/);
    expect(reason(good({ connection: "a b c d e f g h" }))).toMatch(/connection/);
    // Characters outside printable ASCII never reach the parser.
    expect(reason(good().replace("work", "wörk"))).toMatch(/characters/);
    expect(reason(`${good()}\n`)).toMatch(/characters/);
  });
});

describe("Connection references", () => {
  it("gives a connection one stable reference that says nothing about it", () => {
    const store = memoryStorage();
    const refs = connectionRefs(store);
    const ref = refs.refFor(home);
    expect(ref).toMatch(/^[a-z2-7]{20}$/);
    expect(refs.refFor(home)).toBe(ref);
    // Read again from storage, as after a restart.
    expect(connectionRefs(store).refFor(home)).toBe(ref);
    expect(refs.refFor(lab)).not.toBe(ref);
    expect(refs.resolve(ref)).toBe(connectionKey(home));
    expect(refs.resolve("nothinglikeit123")).toBeUndefined();
    const link = formatChatLink({ connection: ref, profile: "default", chatId: "c1" });
    for (const secret of ["hermes.example.com", "liam", "https", "hunter2"]) expect(link).not.toContain(secret);
  });

  it("keeps a reference for the session when storage can't, so links agree", () => {
    const refs = connectionRefs({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const ref = refs.refFor(home);
    expect(refs.refFor(home)).toBe(ref);
    expect(refs.resolve(ref)).toBe(connectionKey(home));
  });

  it("maps another computer's reference to a connection only when told to", () => {
    const store = memoryStorage();
    const refs = connectionRefs(store);
    const mine = refs.refFor(home);
    const link = { connection: "fromanothercomputer1", profile: "default", chatId: "c1" };
    expect(checkConnection(link, home, refs)).toEqual({ kind: "unknown" });
    refs.alias(link.connection, home);
    expect(checkConnection(link, home, refs)).toEqual({ kind: "ok" });
    expect(checkConnection({ ...link, connection: mine }, home, refs)).toEqual({ kind: "ok" });
    expect(checkConnection({ ...link, connection: mine }, lab, refs)).toEqual({ kind: "other", label: "hermes.example.com (liam)" });
    // A malformed store reads as empty instead of failing.
    store.setItem(REFS_KEY, "{not json");
    expect(connectionRefs(store).resolve(mine)).toBeUndefined();
  });

  it("names a connection by its server and username", () => {
    expect(connectionLabel(connectionKey(lab))).toBe("liam@lab");
    expect(connectionLabel(connectionKey({ ...lab, sshTarget: "lab" }))).toBe("lab (liam)");
    expect(connectionLabel(connectionKey(home))).toBe("hermes.example.com (liam)");
    expect(connectionLabel("nonsense")).toBe("another connection");
  });
});

describe("Looking a linked chat up", () => {
  const link = { connection: REF, profile: "work", chatId: "c1" };
  it("asks for the profile first, then the chat in it", async () => {
    const asked: string[] = [];
    const api = {
      profiles: async () => (asked.push("profiles"), ["default", "work"]),
      findChat: async (id: string, profile: string) => (asked.push(`${profile}/${id}`), id === "c1" ? { id } : null),
    };
    expect(await locateChat(link, api)).toEqual({ kind: "found", found: { id: "c1" } });
    expect(await locateChat({ ...link, chatId: "gone" }, api)).toEqual({ kind: "no-chat" });
    expect(await locateChat({ ...link, profile: "old" }, api)).toEqual({ kind: "no-profile" });
    expect(asked).toEqual(["profiles", "work/c1", "profiles", "work/gone", "profiles"]);
  });

  it("rejects when Hermes can't be asked", async () => {
    const api = { profiles: async () => Promise.reject(new Error("Not connected to Hermes.")), findChat: async () => null };
    await expect(locateChat(link, api)).rejects.toThrow("Not connected");
  });
});
