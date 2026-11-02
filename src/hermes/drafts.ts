// What the owner has typed in each chat's composer and not sent yet, kept in localStorage per connection, profile
// and chat, so switching chats or restarting the app doesn't lose it. Text only: attachments stay in the composer
// until it closes. A sent message Hermes didn't take, or may not have, is kept beside the draft until the owner sends
// it again or dismisses it; nothing sends it again on its own.
import type { SavedSignIn } from "./account";
import type { Delivery } from "./transport";

const PREFIX = "hermes-chat.draft.";
const HELD = "hermes-chat.undelivered.";
/** Where the messages held beside a draft are kept. */
const heldKey = (key: string) => HELD + key.slice(PREFIX.length);

/** The storage drafts are kept in: localStorage in the app. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where a chat's draft is kept. `chatId` null is the new chat the owner hasn't sent anything in yet. */
export function draftKey(connection: SavedSignIn, profile: string, chatId: string | null): string {
  const target = connection.mode === "ssh" ? connection.sshTarget : connection.url;
  return PREFIX + JSON.stringify([connection.mode, target, connection.username, profile, chatId]);
}

/**
 * A sent message kept beside its draft because Hermes didn't take it (`unsent`), or because the connection dropped
 * before Hermes answered (`unknown`: Hermes may be running it). `retrying`: the owner's retry is under way.
 */
export type Undelivered = { id: string; text: string; delivery: "unsent" | "unknown"; reason: string; at: number; retrying?: boolean };

export type Drafts = {
  get(key: string): string;
  /** Keeps the text; empty text deletes the draft. */
  set(key: string, text: string): void;
  /** Empties the draft as its message goes, and returns what it held. */
  take(key: string): string;
  /** Puts back the text of a message Hermes didn't take, unless the owner has typed something new there meanwhile. */
  putBack(key: string, text: string): void;
  /**
   * Keeps a sent message's text as `delivery` says. Taken: let go. Unsent: back into the composer, or held beside it if
   * something new was typed there meanwhile. Unknown: held, never put in the composer, so Enter can't send it again.
   */
  afterSend(key: string, text: string, delivery: Delivery): void;
  /** The messages held beside the draft, oldest first. */
  undelivered(key: string): Undelivered[];
  /**
   * Sends a held message again, as the owner asked. It is let go once Hermes takes it. A message that may have
   * reached Hermes stays `unknown` even if the retry can't go out.
   */
  retry(key: string, id: string, send: (text: string) => Promise<Delivery>): Promise<Delivery | undefined>;
  /** The owner lets a held message go. */
  dismiss(key: string, id: string): void;
  subscribe(fn: () => void): () => void;
};

/**
 * Drafts kept in `storage`. They're read from memory once loaded, so a store that is full or can't be written still
 * keeps them until the app closes.
 */
export function drafts(storage: DraftStorage): Drafts {
  const texts = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  const held = new Map<string, Undelivered[]>();

  const heldOf = (key: string): Undelivered[] => {
    let list = held.get(key);
    if (list === undefined) {
      try {
        const saved: unknown = JSON.parse(storage.getItem(heldKey(key)) ?? "[]");
        list = Array.isArray(saved) ? saved.filter(isUndelivered) : [];
      } catch {
        list = [];
      }
      held.set(key, list);
    }
    return list;
  };

  const hold = (key: string, list: Undelivered[]) => {
    held.set(key, list);
    try {
      if (list.length) storage.setItem(heldKey(key), JSON.stringify(list.map(({ retrying: _, ...u }) => u)));
      else storage.removeItem(heldKey(key));
    } catch {
      // Only a restart loses them.
    }
    notify();
  };
  const patch = (key: string, id: string, change: Partial<Undelivered>) => hold(key, heldOf(key).map((u) => (u.id === id ? { ...u, ...change } : u)));

  const get = (key: string) => {
    let text = texts.get(key);
    if (text === undefined) {
      try {
        text = storage.getItem(key) ?? "";
      } catch {
        text = "";
      }
      texts.set(key, text);
    }
    return text;
  };

  const set = (key: string, text: string) => {
    if (get(key) === text) return;
    texts.set(key, text);
    try {
      if (text) storage.setItem(key, text);
      else storage.removeItem(key);
    } catch {
      // Only a restart loses it.
    }
    notify();
  };

  return {
    get,
    set,
    take(key) {
      const text = get(key);
      set(key, "");
      return text;
    },
    putBack(key, text) {
      if (!get(key)) set(key, text);
    },
    afterSend(key, text, d) {
      if (d.delivery === "accepted" || !text) return;
      if (d.delivery === "unsent" && !get(key)) return set(key, text);
      hold(key, [...heldOf(key), { id: crypto.randomUUID(), text, delivery: d.delivery, reason: d.reason, at: Date.now() }]);
    },
    undelivered: heldOf,
    async retry(key, id, send) {
      const u = heldOf(key).find((h) => h.id === id);
      if (!u || u.retrying) return undefined;
      patch(key, id, { retrying: true });
      const d = await send(u.text).catch((e): Delivery => ({ delivery: "unsent", reason: e instanceof Error ? e.message : String(e) }));
      if (d.delivery === "accepted") hold(key, heldOf(key).filter((h) => h.id !== id));
      else patch(key, id, { retrying: false, reason: d.reason, delivery: u.delivery === "unknown" ? "unknown" : d.delivery });
      return d;
    },
    dismiss(key, id) {
      hold(key, heldOf(key).filter((h) => h.id !== id));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

const isUndelivered = (u: unknown): u is Undelivered => {
  const h = u as Undelivered;
  return typeof h?.id === "string" && typeof h.text === "string" && (h.delivery === "unsent" || h.delivery === "unknown") && typeof h.reason === "string" && typeof h.at === "number";
};
