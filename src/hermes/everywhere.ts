// Everywhere search (GLOSSARY.md "Everywhere", issue #608): the words searched in every profile of every live
// connection, for a conversation the owner can't place on a bot or a server. Each profile is asked once, with Hermes's
// own search, and every request goes through the live connections' shared slots (liveConnections.ts `readInTurn`), so
// no more than four are in flight across the app. It only reads: nothing is put in any list, and no shown profile or
// composer target changes. Opening a row is App's (`openAt`).
import { checkedHere, tidyFilter, type ChatFilter } from "./chatFilter";
import type { Capability } from "./capabilities";
import type { ChatRef } from "./liveConnections";
import type { ConnectionStatus, Hit } from "./model";
import { errorText } from "./values";

/**
 * What Everywhere looks for. `text`: the words, which it needs, as it never lists chats. `bot`: only profiles whose
 * name holds it are asked. `model`, `from`, `to`: as in a chat filter, checked here on the chats each profile's search
 * gave (chatFilter.ts `checkedHere`).
 */
export type EverywhereFilter = { text: string; bot?: string } & Pick<ChatFilter, "model" | "from" | "to">;

/** One row: the chat and where it is. `ref` is what opening it reaches; `server` is its connection's name. */
export type EverywhereRow = { ref: ChatRef; server: string; hit: Hit };

/** What became of one profile. `capped`: Hermes gave as many chats as it gives, so more may match there. */
export type ProfileOutcome = { kind: "waiting" } | { kind: "searched"; capped: boolean } | { kind: "failed"; why: string };

/**
 * What became of one live connection. `offline`: it isn't connected, so nothing was sent. `refused`: its Hermes has no
 * chat search (capabilities.ts `chatSearch`), so none of its profiles is asked. `failed`: its profiles couldn't be
 * listed. `listed`: the profiles asked, in Hermes's order, and how many the bot filter left out.
 */
export type ConnectionOutcome =
  | { kind: "waiting" }
  | { kind: "offline"; status: ConnectionStatus }
  | { kind: "refused"; why: string }
  | { kind: "failed"; why: string }
  | { kind: "listed"; profiles: { profile: string; outcome: ProfileOutcome }[]; leftOut: number };

/**
 * A search's state, partial or whole. `connections`: the target first. `rows`: by connection, then profile, then in
 * Hermes's order, after the model and date checks. `noModel`: chats that passed every other check and have no model
 * recorded. `done`: nothing is waiting any more.
 */
export type EverywhereOutcome = {
  connections: { connection: string; server: string; outcome: ConnectionOutcome }[];
  rows: EverywhereRow[];
  noModel: number;
  done: boolean;
};

/** One live connection's Hermes, as far as the search reads it. `Hermes` is one. */
type Searched = {
  getSnapshot(): { status: ConnectionStatus };
  capabilities: { get(id: "chatSearch"): Pick<Capability, "state" | "why"> };
  profiles(): Promise<string[]>;
  knownBotChats(): Promise<void>;
  searchIn(profile: string, text: string): Promise<{ hits: Hit[]; capped: boolean }>;
};

/** The live connections, as far as the search needs them: who they are, and the slots their reads share. */
export type EverywhereLive = {
  list(): { connection: { id: string; name: string }; hermes: Searched }[];
  readInTurn<T>(read: () => Promise<T>): Promise<T>;
};

type ProfileSlot = { kind: "waiting" } | { kind: "searched"; hits: Hit[]; capped: boolean } | { kind: "failed"; why: string };
type ConnectionSlot = Exclude<ConnectionOutcome, { kind: "listed" }> | { kind: "listed"; profiles: Map<string, ProfileSlot>; leftOut: number };
/** One run's state, by connection id in the order the connections are listed. Only its run writes it. */
type Slots = Map<string, { server: string; slot: ConnectionSlot }>;

/**
 * Searches every profile of every live connection for `filter.text`. Each connection costs one request to list its
 * profiles and one to read its Bot Chats' ids, then one per profile asked, and each of those waits for a slot of
 * `live`. `onUpdate` hears the outcome so far each time a read lands. Resolves with the whole outcome. Rejects only
 * when `signal` aborts, and a request still waiting for its slot then is never sent.
 */
export async function searchEverywhere(filter: EverywhereFilter, { live, signal, onUpdate }: { live: EverywhereLive; signal: AbortSignal; onUpdate?: (o: EverywhereOutcome) => void }): Promise<EverywhereOutcome> {
  const text = filter.text.trim();
  const bot = filter.bot?.trim().toLocaleLowerCase();
  const checks = tidyFilter({ model: filter.model, from: filter.from, to: filter.to });
  const members = text ? live.list() : [];
  const slots: Slots = new Map(members.map((m) => [m.connection.id, { server: m.connection.name, slot: { kind: "waiting" } }]));
  const changed = () => void (signal.aborted || onUpdate?.(derive(slots, checks)));
  const inTurn = <T>(read: () => Promise<T>) => live.readInTurn(() => (signal.throwIfAborted(), read()));

  await Promise.all(
    members.map(async ({ connection, hermes }) => {
      const entry = slots.get(connection.id)!;
      const settle = (slot: ConnectionSlot) => ((entry.slot = slot), changed());
      const refusal = () => {
        const cap = hermes.capabilities.get("chatSearch");
        return cap.state === "unsupported" ? (cap.why ?? "Its Hermes has no chat search.") : undefined;
      };
      const { status } = hermes.getSnapshot();
      if (status !== "connected") return settle({ kind: "offline", status });
      const refused = refusal();
      if (refused) return settle({ kind: "refused", why: refused });

      const names = await inTurn(() => hermes.profiles().then((ok) => ({ ok }), (e: unknown) => ({ why: errorText(e) })));
      if ("why" in names) return settle({ kind: "failed", why: names.why });
      const asked = names.ok.filter((p) => !bot || p.toLocaleLowerCase().includes(bot));
      const profiles = new Map(asked.map((p): [string, ProfileSlot] => [p, { kind: "waiting" }]));
      settle({ kind: "listed", profiles, leftOut: names.ok.length - asked.length });
      if (!asked.length) return;

      await inTurn(() => hermes.knownBotChats());
      await Promise.all(
        asked.map(async (profile) => {
          const answer = await inTurn(async (): Promise<ProfileSlot | { kind: "refused"; why: string }> => {
            // Asked when its turn comes: a profile that waited behind the answer that showed the route missing is never sent.
            const before = refusal();
            if (before) return { kind: "refused", why: before };
            const slot = await hermes.searchIn(profile, text).then((page): ProfileSlot => ({ kind: "searched", ...page }), (e: unknown): ProfileSlot => ({ kind: "failed", why: errorText(e) }));
            const after = refusal();
            return after ? { kind: "refused", why: after } : slot;
          });
          if (answer.kind === "refused") return settle(answer);
          profiles.set(profile, answer);
          changed();
        }),
      );
    }),
  );
  signal.throwIfAborted();
  return derive(slots, checks);
}

/** The outcome the slots hold, so a partial outcome and the whole one are worked out the same way. */
function derive(slots: Slots, checks: Pick<ChatFilter, "model" | "from" | "to">): EverywhereOutcome {
  const here = checkedHere(checks);
  const rows: EverywhereRow[] = [];
  let noModel = 0;
  let done = true;
  const connections = [...slots].map(([connection, { server, slot }]): EverywhereOutcome["connections"][number] => {
    if (slot.kind === "waiting") done = false;
    if (slot.kind !== "listed") return { connection, server, outcome: slot };
    const profiles = [...slot.profiles].map(([profile, p]): { profile: string; outcome: ProfileOutcome } => {
      if (p.kind === "waiting") done = false;
      if (p.kind !== "searched") return { profile, outcome: p };
      for (const hit of p.hits) {
        const checked = here(hit);
        if (checked === "match") rows.push({ ref: { connection, profile, chatId: hit.chatId }, server, hit });
        else if (checked === "noModel") noModel++;
      }
      return { profile, outcome: { kind: "searched", capped: p.capped } };
    });
    return { connection, server, outcome: { kind: "listed", profiles, leftOut: slot.leftOut } };
  });
  return { connections, rows, noModel, done };
}
