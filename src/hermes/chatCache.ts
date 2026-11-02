// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, the
// Saved copies of the chats opened lately, so they can be read while Hermes can't be reached, the profile shown last,
// so the next sign-in opens it, and the profiles whose older history the owner pulled.
// Clearing the cache deletes the chat lists and Saved copies only.
import type { Chat, Item } from "./model";
import type { ChatCache, SavedTranscript } from "./transport";

const LIST_PREFIX = "hermes-chat.chats.";
const key = (profile: string) => `${LIST_PREFIX}${profile}`;
const TRANSCRIPT_PREFIX = "hermes-chat.transcript.";
const transcriptKey = (profile: string, chatId: string) => `${TRANSCRIPT_PREFIX}${encodeURIComponent(profile)}/${encodeURIComponent(chatId)}`;
const PROFILE_KEY = "hermes-chat.profile";
const PULLED_KEY = "hermes-chat.older-pulled";

/**
 * The most storage the Saved copies take. The least recently saved go first past it. WebKitGTK gives the app about
 * 5 MB of localStorage, which the chat lists and sign-in share.
 */
export const TRANSCRIPT_LIMIT_BYTES = 2 * 1024 * 1024;

/** localStorage keeps text as UTF-16: two bytes a character, key and value. */
const sizeOf = (k: string, value = localStorage.getItem(k) ?? "") => 2 * (k.length + value.length);

/** The keys starting with `prefix`. */
function keysOf(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(prefix)) keys.push(k);
  }
  return keys;
}
const cacheKeys = () => [...keysOf(LIST_PREFIX), ...keysOf(TRANSCRIPT_PREFIX)];

/** When a Saved copy was saved, read off the front of its JSON so the rest isn't parsed. */
const savedAtOf = (k: string) => Number(/^\{"savedAt":(\d+)/.exec(localStorage.getItem(k) ?? "")?.[1] ?? 0);

const isItem = (i: unknown): i is Item => typeof (i as Item)?.kind === "string" && typeof (i as Item).id === "string";

function pulledProfiles(): string[] {
  try {
    const profiles: unknown = JSON.parse(localStorage.getItem(PULLED_KEY) ?? "[]");
    return Array.isArray(profiles) ? profiles.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export const localChatCache: ChatCache = {
  load(profile) {
    try {
      const chats: unknown = JSON.parse(localStorage.getItem(key(profile)) ?? "[]");
      return Array.isArray(chats) ? chats.filter((c): c is Chat => typeof c?.id === "string" && typeof c.title === "string") : [];
    } catch {
      return [];
    }
  },
  save(profile, chats) {
    try {
      localStorage.setItem(key(profile), JSON.stringify(chats));
    } catch {
      // A full or unavailable store only costs the instant list at next sign-in.
    }
  },
  loadTranscript(profile, chatId) {
    try {
      const saved: Partial<SavedTranscript> | null = JSON.parse(localStorage.getItem(transcriptKey(profile, chatId)) ?? "null");
      if (typeof saved?.savedAt !== "number" || !Array.isArray(saved.items)) return undefined;
      return { savedAt: saved.savedAt, items: saved.items.filter(isItem) };
    } catch {
      return undefined;
    }
  },
  saveTranscript(profile, chatId, items) {
    try {
      const k = transcriptKey(profile, chatId);
      const value = JSON.stringify({ savedAt: Date.now(), items });
      localStorage.removeItem(k);
      // A copy bigger than the limit isn't kept; the chat loads from Hermes when it can.
      let used = sizeOf(k, value);
      if (used > TRANSCRIPT_LIMIT_BYTES) return;
      const newestFirst = keysOf(TRANSCRIPT_PREFIX)
        .map((other) => ({ other, savedAt: savedAtOf(other) }))
        .sort((a, b) => b.savedAt - a.savedAt);
      for (const { other } of newestFirst) {
        used += sizeOf(other);
        if (used > TRANSCRIPT_LIMIT_BYTES) localStorage.removeItem(other);
      }
      localStorage.setItem(k, value);
    } catch {
      // A full or unavailable store only costs reading this chat offline.
    }
  },
  lastProfile() {
    try {
      return localStorage.getItem(PROFILE_KEY) || undefined;
    } catch {
      return undefined;
    }
  },
  rememberProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, profile);
    } catch {
      // The next sign-in opens the default profile instead.
    }
  },
  bytes() {
    try {
      return cacheKeys().reduce((n, k) => n + sizeOf(k), 0);
    } catch {
      return 0;
    }
  },
  clear() {
    try {
      for (const k of cacheKeys()) localStorage.removeItem(k);
    } catch {
      // Nothing can be deleted from a store that can't be read.
    }
  },
  olderPulled(profile) {
    return pulledProfiles().includes(profile);
  },
  rememberOlderPulled(profile) {
    try {
      const pulled = pulledProfiles();
      if (!pulled.includes(profile)) localStorage.setItem(PULLED_KEY, JSON.stringify([...pulled, profile]));
    } catch {
      // The next launch shows the past month only, until the owner pulls again.
    }
  },
};
