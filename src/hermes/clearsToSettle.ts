// The one-time move from the local clear store to Settle (ADR 0090). Until then a chat cleared from the Inbox sat in
// Unsettled, kept on this computer; now Settle is the one way to clear a chat, and Hermes keeps it.
import type { Chat } from "./model";
import { isWaiting } from "./model";
import { chatSections, lastActive, type Pins, type Snoozes } from "./snooze";

/** The old clear store: `{ v: 1, scopes: { [scope]: { [chatId]: mark } } }`, a mark being `lastActive` when it was cleared. */
export const CLEARED_KEY = "hermes-chat.cleared";

type ClearStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Takes `scope`'s clears out of `storage` (removing the key once no scope is left) and answers the ids of the chats whose
 * clear still held, the ones the list showed in Unsettled. A scope with no clears changes nothing, so a second call is a no-op.
 */
export function takeHeldClears(
  storage: ClearStorage,
  scope: string,
  chats: Chat[],
  snoozes: Snoozes,
  pins: Pins,
  now: number,
  since: Readonly<Record<string, number>> = {},
): string[] {
  let doc: Record<string, unknown>;
  let scopes: Record<string, unknown>;
  try {
    const raw = storage.getItem(CLEARED_KEY);
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.scopes) || !(scope in parsed.scopes)) return [];
    doc = parsed;
    scopes = parsed.scopes;
  } catch {
    return [];
  }

  const marks = isRecord(scopes[scope]) ? scopes[scope] : {};
  const held = chatSections(chats, snoozes, now, since, pins)
    .inbox.filter((c) => {
      const mark = marks[c.id];
      return typeof mark === "number" && lastActive(c, snoozes, now, since) <= mark && !c.unread && !c.running && !c.items.some(isWaiting);
    })
    .map((c) => c.id);

  const { [scope]: _, ...others } = scopes;
  try {
    if (Object.keys(others).length) storage.setItem(CLEARED_KEY, JSON.stringify({ ...doc, scopes: others }));
    else storage.removeItem(CLEARED_KEY);
  } catch {
    // Settling a chat twice is harmless, so the ids still go back.
  }
  return held;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
