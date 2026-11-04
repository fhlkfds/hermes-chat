// Chat links (ADR 0036): `hermes-chat://chat?v=1&connection=<ref>&profile=<name>&id=<chat id>`. A link names a chat
// only by ids: the connection by an opaque reference this computer made up for it, never its address, username,
// password or headers. Opening a link only shows the chat; it never sends, runs, approves or signs in to anything.
//
// The references are kept in localStorage: one made for each connection this computer signs in to (`own`), and the
// ones the owner said belong to a connection when a link from elsewhere named one this computer didn't know
// (`aliases`). Nothing else is kept, and nothing is sent to Hermes.
import type { SavedSignIn } from "./account";

export const LINK_SCHEME = "hermes-chat";
/** The longest link read at all, in characters. A real one is well under 300. */
export const LINK_MAX = 1024;
export const REFS_KEY = "hermes-chat.connection-refs";
/** The most aliases kept; the oldest go first. */
const ALIAS_MAX = 50;

/** What a chat link names. */
export type ChatLink = { connection: string; profile: string; chatId: string };

/** Hermes's profile ids (`hermes_constants.PROFILE_ID_RE`), plus `default` (persona.ts has the same). */
const PROFILE_ID = /^(?:default|[a-z0-9][a-z0-9_-]{0,63})$/;
/**
 * A Hermes session id: `YYYYMMDD_HHMMSS_<hex>` for chats Hermes starts, and an id from the file for an Imported
 * transcript (importTranscripts.ts). Other platforms' ids are letters, digits and `_ - . :`. No `/`, `%`, spaces or
 * a leading dot, so an id can't step out of `api/sessions/{id}` however it is decoded.
 */
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A connection reference: one made here (`newRef`), or another computer's, which may be longer. */
const CONNECTION_REF = /^[A-Za-z0-9_-]{8,64}$/;
const PARAMS = ["v", "connection", "profile", "id"] as const;

export type Parsed = { ok: true; link: ChatLink } | { ok: false; reason: string };

const bad = (reason: string): Parsed => ({ ok: false, reason });

/**
 * Reads a chat link, refusing anything that isn't exactly one: another scheme or shape, anything too long, credentials,
 * a port, a fragment, an unknown or repeated part, or an id that isn't one. `reason` says what was wrong, plainly.
 */
export function parseChatLink(raw: unknown): Parsed {
  if (typeof raw !== "string" || !raw) return bad("The link is empty.");
  if (raw.length > LINK_MAX) return bad(`The link is too long (over ${LINK_MAX} characters), so it isn't a Hermes Chat link.`);
  // Printable ASCII only: a real link has nothing else, so whitespace, control characters and look-alike letters
  // never reach the URL parser.
  if (!/^[\x21-\x7e]+$/.test(raw)) return bad("The link has spaces or characters a Hermes Chat link never has.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("That isn't a link Hermes Chat can read.");
  }
  if (url.protocol !== `${LINK_SCHEME}:`) return bad(`That isn't a Hermes Chat link: it doesn't start with ${LINK_SCHEME}://.`);
  if (url.username || url.password) return bad("The link has a sign-in in it. Hermes Chat links never do, so it wasn't opened.");
  if (url.hostname !== "chat" || url.port || (url.pathname !== "" && url.pathname !== "/") || url.hash)
    return bad("Hermes Chat can't open that kind of link. Only links to a chat, made with Copy chat link, open.");
  const params = url.searchParams;
  const keys = [...params.keys()];
  const extra = keys.find((k) => !(PARAMS as readonly string[]).includes(k));
  if (extra !== undefined) return bad("The link has parts a chat link doesn't have, so it wasn't opened.");
  if (new Set(keys).size !== keys.length) return bad("The link names something twice, so it wasn't opened.");
  if (!params.has("v")) return bad("The link is missing its version.");
  if (params.get("v") !== "1") return bad("The link was made by a newer Hermes Chat. Update Hermes Chat to open it.");
  const connection = params.get("connection") ?? "";
  const profile = params.get("profile") ?? "";
  const chatId = params.get("id") ?? "";
  if (!CONNECTION_REF.test(connection)) return bad("The link's connection isn't one Hermes Chat could have made.");
  if (!PROFILE_ID.test(profile)) return bad("The link's profile isn't a Hermes profile name.");
  if (!CHAT_ID.test(chatId)) return bad("The link's chat isn't a Hermes chat id.");
  return { ok: true, link: { connection, profile, chatId } };
}

/** A chat's link. Every part is already safe in a URL; they are encoded anyway. */
export function formatChatLink({ connection, profile, chatId }: ChatLink): string {
  const q = new URLSearchParams({ v: "1", connection, profile, id: chatId });
  return `${LINK_SCHEME}://chat?${q}`;
}

/** Which connection a reference stands for: the same server and username as an inbox dismissal's (inbox.ts). */
export function connectionKey(c: Pick<SavedSignIn, "mode" | "sshTarget" | "url" | "username">): string {
  return JSON.stringify([c.mode, c.mode === "ssh" ? c.sshTarget : c.url, c.username]);
}

/** How a connection is named to the owner: its SSH target, or the dashboard's address, and the username. */
export function connectionLabel(key: string): string {
  try {
    const [mode, target, username] = JSON.parse(key) as [string, string, string];
    let where = target;
    if (mode === "url") {
      try {
        where = new URL(target).host || target;
      } catch {
        /* the URL as saved */
      }
    }
    // An SSH target usually names the user already.
    return username && !(mode === "ssh" && where.startsWith(`${username}@`)) ? `${where} (${username})` : where;
  } catch {
    return "another connection";
  }
}

type RefsDoc = { own: Record<string, string>; aliases: Record<string, string> };
export type RefStorage = Pick<Storage, "getItem" | "setItem">;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** 20 random characters, 100 bits: nothing about the connection can be read back from it. */
function newRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

export type ConnectionRefs = {
  /** The reference for `c`, made and kept the first time it is asked for. */
  refFor(c: SavedSignIn): string;
  /** The connection (its `connectionKey`) a reference stands for on this computer, if any. */
  resolve(ref: string): string | undefined;
  /** The owner said `ref`, from a link made elsewhere, is `c`. */
  alias(ref: string, c: SavedSignIn): void;
};

/** The connection references kept in `storage`. A store that can't be read or written starts empty. */
export function connectionRefs(storage: RefStorage): ConnectionRefs {
  const read = (): RefsDoc => {
    try {
      const doc = JSON.parse(storage.getItem(REFS_KEY) ?? "null") as Partial<RefsDoc> | null;
      const strings = (o: unknown) =>
        Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([, v]) => typeof v === "string" && CONNECTION_REF.test(v as string))) as Record<string, string>;
      // Aliases are kept ref → key; check the ref, which is the key there.
      const aliases = Object.fromEntries(
        Object.entries(doc?.aliases && typeof doc.aliases === "object" ? doc.aliases : {}).filter(([k, v]) => typeof v === "string" && CONNECTION_REF.test(k)),
      ) as Record<string, string>;
      return { own: strings(doc?.own), aliases };
    } catch {
      return { own: {}, aliases: {} };
    }
  };
  const write = (doc: RefsDoc) => {
    try {
      storage.setItem(REFS_KEY, JSON.stringify(doc));
    } catch {
      /* A full store keeps the reference for this session only. */
    }
  };
  // What `refFor` made when the store couldn't keep it, so links copied in one session agree.
  const unsaved = new Map<string, string>();
  return {
    refFor(c) {
      const key = connectionKey(c);
      const doc = read();
      const kept = doc.own[key] ?? unsaved.get(key);
      if (kept) return kept;
      const ref = newRef();
      unsaved.set(key, ref);
      write({ ...doc, own: { ...doc.own, [key]: ref } });
      return ref;
    },
    resolve(ref) {
      const doc = read();
      for (const [key, r] of Object.entries(doc.own)) if (r === ref) return key;
      for (const [key, r] of unsaved) if (r === ref) return key;
      return doc.aliases[ref];
    },
    alias(ref, c) {
      if (!CONNECTION_REF.test(ref)) return;
      const doc = read();
      const aliases = { ...doc.aliases };
      delete aliases[ref];
      aliases[ref] = connectionKey(c);
      const keys = Object.keys(aliases);
      for (const k of keys.slice(0, Math.max(0, keys.length - ALIAS_MAX))) delete aliases[k];
      write({ ...doc, aliases });
    },
  };
}

/**
 * Whether a link's connection is the one signed in: `ok`; one this computer knows but isn't signed in to (`other`,
 * with how to name it); or one it doesn't know at all (`unknown`), which only the owner can say is this one.
 */
export type ConnectionCheck = { kind: "ok" } | { kind: "other"; label: string } | { kind: "unknown" };

export function checkConnection(link: ChatLink, current: SavedSignIn, refs: ConnectionRefs): ConnectionCheck {
  const key = refs.resolve(link.connection);
  if (key === undefined) return { kind: "unknown" };
  return key === connectionKey(current) ? { kind: "ok" } : { kind: "other", label: connectionLabel(key) };
}

/** What looking a linked chat up on the signed-in connection found. */
export type Located<F> = { kind: "found"; found: F } | { kind: "no-profile" } | { kind: "no-chat" };

/**
 * Looks the linked chat up without moving anything: first that the server has the profile, then that the profile has
 * the chat. Rejects when Hermes can't be asked, so the owner can try again.
 */
export async function locateChat<F>(
  link: ChatLink,
  api: { profiles(): Promise<string[]>; findChat(chatId: string, profile: string): Promise<F | null> },
): Promise<Located<F>> {
  const profiles = await api.profiles();
  if (!profiles.includes(link.profile)) return { kind: "no-profile" };
  const found = await api.findChat(link.chatId, link.profile);
  return found ? { kind: "found", found } : { kind: "no-chat" };
}
