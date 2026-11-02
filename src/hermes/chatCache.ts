// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, the
// profile shown last, so the next sign-in opens it, the profiles whose older history the owner pulled, and the
// owner's Pinned and Snoozed chats. Clearing the cache deletes the chat lists only.
import type { Chat } from "./model";
import type { ChatCache, ChatMarks } from "./transport";

const LIST_PREFIX = "hermes-chat.chats.";
const key = (profile: string) => `${LIST_PREFIX}${profile}`;
const PROFILE_KEY = "hermes-chat.profile";
const PULLED_KEY = "hermes-chat.older-pulled";
const MARKS_KEY = "hermes-chat.marks";

/** The keys of the saved chat lists. */
function listKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LIST_PREFIX)) keys.push(k);
  }
  return keys;
}

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
      // localStorage keeps text as UTF-16: two bytes a character, key and value.
      return listKeys().reduce((n, k) => n + 2 * (k.length + (localStorage.getItem(k)?.length ?? 0)), 0);
    } catch {
      return 0;
    }
  },
  clear() {
    try {
      for (const k of listKeys()) localStorage.removeItem(k);
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
  marks() {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}");
      if (!saved || typeof saved !== "object") return {};
      const marks: ChatMarks = {};
      for (const [profile, m] of Object.entries(saved as Record<string, { pinned?: unknown; snoozed?: unknown }>)) {
        const pinned = Array.isArray(m?.pinned) ? m.pinned.filter((id): id is string => typeof id === "string") : [];
        const snoozed = Object.fromEntries(
          Object.entries(m?.snoozed && typeof m.snoozed === "object" ? m.snoozed : {}).filter(([, t]) => typeof t === "number"),
        ) as Record<string, number>;
        marks[profile] = { pinned, snoozed };
      }
      return marks;
    } catch {
      return {};
    }
  },
  saveMarks(marks) {
    try {
      localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
    } catch {
      // Pins and snoozes made now last until the app closes.
    }
  },
};
