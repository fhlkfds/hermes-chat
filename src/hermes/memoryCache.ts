// An in-memory ChatCache for tests: `saved` holds each profile's list, `transcripts` the Saved copies by
// `profile/chatId`, `profile` the one shown last, and `pulled` the profiles whose older history the owner pulled.
// It has no storage limit.
import type { Chat } from "./model";
import type { ChatCache, SavedTranscript } from "./transport";

export type MemoryCache = ChatCache & {
  saved: Record<string, Chat[]>;
  transcripts: Record<string, SavedTranscript>;
  profile?: string;
  pulled: Set<string>;
};

export function memoryCache({
  saved = {},
  transcripts = {},
  profile,
}: { saved?: Record<string, Chat[]>; transcripts?: Record<string, SavedTranscript>; profile?: string } = {}): MemoryCache {
  const cache: MemoryCache = {
    saved: { ...saved },
    transcripts: { ...transcripts },
    profile,
    pulled: new Set(),
    load: (p) => cache.saved[p] ?? [],
    save: (p, chats) => void (cache.saved[p] = chats),
    loadTranscript: (p, id) => cache.transcripts[`${p}/${id}`],
    saveTranscript: (p, id, items) => void (cache.transcripts[`${p}/${id}`] = { items, savedAt: Date.now() }),
    deleteTranscript: (p, id) => void delete cache.transcripts[`${p}/${id}`],
    lastProfile: () => cache.profile,
    rememberProfile: (p) => void (cache.profile = p),
    bytes: () => [...Object.values(cache.saved), ...Object.values(cache.transcripts)].reduce((n, v) => n + JSON.stringify(v).length * 2, 0),
    clear: () => void ((cache.saved = {}), (cache.transcripts = {})),
    olderPulled: (p) => cache.pulled.has(p),
    rememberOlderPulled: (p) => void cache.pulled.add(p),
  };
  return cache;
}
