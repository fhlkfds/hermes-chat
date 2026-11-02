// What the owner has typed in each chat's composer and not sent yet, kept in localStorage per connection, profile
// and chat, so switching chats or restarting the app doesn't lose it. Text only: attachments stay in the composer
// until it closes.
import type { SavedSignIn } from "./account";

const PREFIX = "hermes-chat.draft.";

/** The storage drafts are kept in: localStorage in the app. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where a chat's draft is kept. `chatId` null is the new chat the owner hasn't sent anything in yet. */
export function draftKey(connection: SavedSignIn, profile: string, chatId: string | null): string {
  const target = connection.mode === "ssh" ? connection.sshTarget : connection.url;
  return PREFIX + JSON.stringify([connection.mode, target, connection.username, profile, chatId]);
}

export type Drafts = {
  get(key: string): string;
  /** Keeps the text; empty text deletes the draft. */
  set(key: string, text: string): void;
  /** Empties the draft as its message goes, and returns what it held. */
  take(key: string): string;
  /** Puts back the text of a message Hermes didn't take, unless the owner has typed something new there meanwhile. */
  putBack(key: string, text: string): void;
  subscribe(fn: () => void): () => void;
};

/**
 * Drafts kept in `storage`. They're read from memory once loaded, so a store that is full or can't be written still
 * keeps them until the app closes.
 */
export function drafts(storage: DraftStorage): Drafts {
  const texts = new Map<string, string>();
  const listeners = new Set<() => void>();

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
    listeners.forEach((fn) => fn());
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
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
