// An in-memory ChatCache for tests: `saved` holds each profile's list, `transcripts` the Saved copies by
// `profile/chatId`, `profile` the one shown last, `pulled` the profiles whose older history the owner pulled, and
// `outbox` each chat's messages Hermes hasn't confirmed and `queues` each chat's queue, by `profile/chatId`, which
// `clear` keeps. Values are copied through JSON, as localStorage would, so nothing kept shares objects with the app.
// It has no storage limit.
import type { Chat, ChatQueue, OutgoingItem } from "./model";
import type { ChatCache, SavedTranscript } from "./transport";

export type MemoryCache = ChatCache & {
  saved: Record<string, Chat[]>;
  transcripts: Record<string, SavedTranscript>;
  profile?: string;
  pulled: Set<string>;
  outbox: Record<string, OutgoingItem[]>;
  queues: Record<string, ChatQueue>;
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
    outbox: {},
    queues: {},
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
    loadOutbox: (p) =>
      Object.fromEntries(
        Object.entries(cache.outbox)
          .filter(([k]) => k.startsWith(`${p}/`))
          .map(([k, rows]) => [k.slice(p.length + 1), JSON.parse(JSON.stringify(rows)) as OutgoingItem[]]),
      ),
    saveOutbox: (p, id, rows) => {
      if (rows.length) cache.outbox[`${p}/${id}`] = JSON.parse(JSON.stringify(rows)) as OutgoingItem[];
      else delete cache.outbox[`${p}/${id}`];
    },
    loadQueues: (p) =>
      Object.fromEntries(
        Object.entries(cache.queues)
          .filter(([k]) => k.startsWith(`${p}/`))
          .map(([k, q]) => [k.slice(p.length + 1), JSON.parse(JSON.stringify(q)) as ChatQueue]),
      ),
    saveQueue: (p, id, q) => {
      if (q?.items.length) cache.queues[`${p}/${id}`] = JSON.parse(JSON.stringify({ items: q.items, paused: q.paused })) as ChatQueue;
      else delete cache.queues[`${p}/${id}`];
      return true;
    },
  };
  return cache;
}
