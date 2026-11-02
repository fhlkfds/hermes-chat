// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, the
// Saved copies of the chats opened lately, so they can be read while Hermes can't be reached, the profile shown last,
// so the next sign-in opens it, and the profiles whose older history the owner pulled. All of it is kept apart per
// connection (how the app reaches the dashboard, and as whom), never with the password.
// Clearing the cache deletes every connection's chat lists and Saved copies, and nothing else.
import type { SavedSignIn } from "./account";
import type { Chat, Item, Source } from "./model";
import type { ChatCache, SavedTranscript } from "./transport";

const LIST_PREFIX = "hermes-chat.chats.";
const TRANSCRIPT_PREFIX = "hermes-chat.transcript.";
const PROFILE_PREFIX = "hermes-chat.profile.";
const PULLED_PREFIX = "hermes-chat.older-pulled.";

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
/** Every connection's lists and Saved copies, and lists kept before they were kept per connection. */
const cacheKeys = () => [...keysOf(LIST_PREFIX), ...keysOf(TRANSCRIPT_PREFIX)];

/** When a Saved copy was saved, read off the front of its JSON so the rest isn't parsed. */
const savedAtOf = (k: string) => Number(/^\{"savedAt":(\d+)/.exec(localStorage.getItem(k) ?? "")?.[1] ?? 0);

const SOURCES: Source[] = ["app", "telegram", "discord", "desktop", "cli", "other"];
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A saved list row as a Chat, or undefined if it isn't one. The transcript is never in the list. */
function toChat(v: unknown): Chat | undefined {
  const c = v as Record<string, unknown> | null;
  if (typeof c?.id !== "string" || typeof c.title !== "string") return undefined;
  return {
    id: c.id,
    title: c.title,
    source: SOURCES.includes(c.source as Source) ? (c.source as Source) : "other",
    settled: typeof c.settled === "boolean" ? c.settled : true,
    updatedAt: num(c.updatedAt) ?? 0,
    ...(typeof c.unread === "boolean" && { unread: c.unread }),
    items: [],
  };
}

/**
 * A saved transcript item, rebuilt from the fields its kind has, or undefined if it isn't one a Saved copy holds.
 * Only what Hermes stores comes back: never an Approval, which could otherwise be answered, or an error.
 */
function toItem(v: unknown): Item | undefined {
  const i = v as Record<string, unknown> | null;
  const id = str(i?.id);
  if (!i || id === undefined) return undefined;
  const text = str(i.text);
  switch (i.kind) {
    case "user": {
      const attachments = Array.isArray(i.attachments) ? i.attachments.filter((a): a is string => typeof a === "string") : undefined;
      return text === undefined ? undefined : { kind: "user", id, text, ...(attachments?.length && { attachments }) };
    }
    case "assistant":
      return text === undefined ? undefined : { kind: "assistant", id, text, ...(i.interrupted === true && { interrupted: true }) };
    case "thinking":
      return text === undefined ? undefined : { kind: "thinking", id, text };
    case "tool": {
      const name = str(i.name);
      if (name === undefined || (i.status !== "done" && i.status !== "stopped")) return undefined;
      const args = i.args && typeof i.args === "object" && !Array.isArray(i.args) ? (i.args as Record<string, unknown>) : undefined;
      const [preview, result, summary, durationS] = [str(i.preview), str(i.result), str(i.summary), num(i.durationS)];
      return {
        kind: "tool",
        id,
        name,
        status: i.status,
        ...(args && { args }),
        ...(preview !== undefined && { preview }),
        ...(result !== undefined && { result }),
        ...(summary !== undefined && { summary }),
        ...(durationS !== undefined && { durationS }),
      };
    }
    default:
      return undefined;
  }
}

/** The cache for one connection. `connection` may carry a password; it never goes into a key or value. */
export function localChatCache(connection: SavedSignIn): ChatCache {
  const target = connection.mode === "ssh" ? connection.sshTarget : connection.url;
  const scope = (...rest: string[]) => JSON.stringify([connection.mode, target, connection.username, ...rest]);
  const listKey = (profile: string) => LIST_PREFIX + scope(profile);
  const transcriptKey = (profile: string, chatId: string) => TRANSCRIPT_PREFIX + scope(profile, chatId);
  const profileKey = PROFILE_PREFIX + scope();
  const pulledKey = PULLED_PREFIX + scope();

  const pulledProfiles = (): string[] => {
    try {
      const profiles: unknown = JSON.parse(localStorage.getItem(pulledKey) ?? "[]");
      return Array.isArray(profiles) ? profiles.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  };

  return {
    load(profile) {
      try {
        const chats: unknown = JSON.parse(localStorage.getItem(listKey(profile)) ?? "[]");
        return Array.isArray(chats) ? chats.flatMap((c) => toChat(c) ?? []) : [];
      } catch {
        return [];
      }
    },
    save(profile, chats) {
      try {
        localStorage.setItem(listKey(profile), JSON.stringify(chats));
      } catch {
        // A full or unavailable store only costs the instant list at next sign-in.
      }
    },
    loadTranscript(profile, chatId) {
      try {
        const saved: Partial<SavedTranscript> | null = JSON.parse(localStorage.getItem(transcriptKey(profile, chatId)) ?? "null");
        const savedAt = num(saved?.savedAt);
        if (savedAt === undefined || !Array.isArray(saved?.items)) return undefined;
        return { savedAt, items: saved.items.flatMap((i) => toItem(i) ?? []) };
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
        // The limit covers every connection's copies together.
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
    deleteTranscript(profile, chatId) {
      try {
        localStorage.removeItem(transcriptKey(profile, chatId));
      } catch {
        // Nothing can be deleted from a store that can't be used; nothing can be read from it either.
      }
    },
    lastProfile() {
      try {
        return localStorage.getItem(profileKey) || undefined;
      } catch {
        return undefined;
      }
    },
    rememberProfile(profile) {
      try {
        localStorage.setItem(profileKey, profile);
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
        if (!pulled.includes(profile)) localStorage.setItem(pulledKey, JSON.stringify([...pulled, profile]));
      } catch {
        // The next launch shows the past month only, until the owner pulls again.
      }
    },
  };
}
