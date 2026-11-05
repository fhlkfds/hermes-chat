// Snoozing, Clearing from the Inbox, and the chat list's sections (GLOSSARY.md, ADR 0036, ADR 0062). Hermes has
// nowhere to keep a snooze or a clear, so each is kept on this computer only, in its own versioned localStorage
// document, separately for each connection and profile (the scope projectLinks.ts `projectScope` gives), and never
// sent to Hermes. A snooze is the time the chat wakes, in Unix ms; a clear is when the chat was last active as the owner
// cleared it, so anything newer brings it back.
//
// The list shows each chat in one section only, worked out from what the app already reads:
//   1. Archived: Hermes has it archived, whatever else holds.
//   2. Settled: the owner settled it (ADR 0002). It stays there whatever happens in it.
//   3. Snoozed: the owner snoozed it and it hasn't woken yet.
//   4. Working: Hermes is writing a reply in it and isn't waiting on the owner.
//   5. Unsettled: the owner cleared it from the Inbox and nothing has happened in it since.
//   6. Otherwise it is in the Inbox: Hermes waits for the owner's answer, or is done, or it is new.
import type { Chat } from "./model";
import { isWaiting } from "./model";
import type { SectionKey } from "./sectionKeys";
import { migrateUIPrefs as migrateDoc, type UIPrefsDoc, type UIPrefsMigrations } from "./uiPrefs";

export const SNOOZE_KEY = "hermes-chat.snoozes";
export const SNOOZE_VERSION = 1;
const SNOOZE_MIGRATIONS: UIPrefsMigrations = { 0: (doc) => doc };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A woken snooze is kept this long, so the chat it woke stays near the top of the list, then forgotten. */
export const WOKEN_KEPT_MS = 7 * DAY;
/** The furthest ahead a chat can be snoozed. */
export const SNOOZE_MAX_MS = 366 * DAY;
/** The hour Tomorrow and Next week wake at, local time. */
const MORNING = 9;
const SCOPE_LIMIT = 200;
const CHATS_PER_SCOPE = 5_000;

/** One connection and profile's times, one per chat, Unix ms: when each snoozed chat wakes, or each cleared chat's mark. */
export type ChatTimes = Readonly<Record<string, number>>;
/** One connection and profile's snoozes: when each chat wakes, Unix ms. */
export type Snoozes = ChatTimes;
/** One connection and profile's cleared chats: when each was last active as the owner cleared it, Unix ms. */
export type Cleared = ChatTimes;
export type SnoozeStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY: ChatTimes = Object.freeze({});
const isDoc = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, max = 400) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** One scope's times as stored, the newest `CHATS_PER_SCOPE` written; anything that isn't valid is left out. */
function toTimes(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isDoc(v)) return out;
  for (const [chat, at] of Object.entries(v).slice(-CHATS_PER_SCOPE)) if (id(chat) && typeof at === "number" && Number.isFinite(at) && at > 0) out[chat] = at;
  return out;
}

/** Snoozes woken longer ago than WOKEN_KEPT_MS go. */
const pruned = (s: Record<string, number>, now: number) => Object.fromEntries(Object.entries(s).filter(([, until]) => until > now - WOKEN_KEPT_MS));

/**
 * A time for each of one connection and profile's chats, kept in `storage` under `key`. A change that can't be stored
 * (storage full) is held in memory while the app runs. `reread` picks up another window's change. A chat set again
 * moves to the end, so the oldest are the ones dropped past `CHATS_PER_SCOPE`.
 */
class ChatTimesStore {
  private snap: ChatTimes = EMPTY;
  private cachedRaw: string | null | undefined;
  private doc: UIPrefsDoc = { v: 1 };
  private listeners = new Set<() => void>();

  constructor(
    private storage: SnoozeStorage,
    private scope: string,
    protected now: () => number,
    private key: string,
    private version: number,
    private migrations: UIPrefsMigrations,
    private prune: (s: Record<string, number>, now: number) => Record<string, number> = (s) => s,
  ) {
    this.read();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  /** Reads the stored document again, for a change another window made. */
  reread = () => {
    if (this.read()) this.emit();
  };

  protected set(chatId: string, at: number) {
    this.change(({ [chatId]: _, ...s }) => ({ ...s, [chatId]: at }));
  }

  protected forget(chatId: string) {
    this.change(({ [chatId]: _, ...s }) => s);
  }

  private read(): boolean {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return false;
    }
    if (raw === this.cachedRaw) return false;
    this.cachedRaw = raw;
    let parsed: unknown;
    try {
      parsed = raw === null ? undefined : JSON.parse(raw);
    } catch {
      // Unreadable: start empty.
    }
    this.doc = migrateDoc(parsed, this.migrations, this.version);
    const scopes = isDoc(this.doc.scopes) ? this.doc.scopes : {};
    const next = toTimes(scopes[this.scope]);
    if (JSON.stringify(next) === JSON.stringify(this.snap)) return false;
    this.snap = Object.freeze(next);
    return true;
  }

  private change(fn: (s: Record<string, number>) => Record<string, number>) {
    this.read();
    const next = toTimes(this.prune(fn({ ...this.snap }), this.now()));
    if (JSON.stringify(next) === JSON.stringify(this.snap)) return;
    this.snap = Object.freeze(next);
    // Only this scope is rewritten; other scopes, and fields a newer app wrote, are kept.
    const scopes = isDoc(this.doc.scopes) ? { ...this.doc.scopes } : {};
    delete scopes[this.scope];
    if (Object.keys(next).length) scopes[this.scope] = next;
    const kept = Object.fromEntries(Object.entries(scopes).slice(-SCOPE_LIMIT));
    this.doc = { ...this.doc, v: Math.max(this.version, Number(this.doc.v) || 0), scopes: kept };
    const raw = JSON.stringify(this.doc);
    try {
      this.storage.setItem(this.key, raw);
      this.cachedRaw = raw;
    } catch {
      // Not kept: memory holds the change while the stored document is still the one last read.
    }
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** The snoozes for one connection and profile, kept in `storage`. */
export class SnoozeStore extends ChatTimesStore {
  constructor(storage: SnoozeStorage, scope: string, now: () => number = Date.now) {
    super(storage, scope, now, SNOOZE_KEY, SNOOZE_VERSION, SNOOZE_MIGRATIONS, pruned);
  }

  /** Snoozes the chat until `until` (Unix ms), replacing any snooze it had. */
  snooze(chatId: string, until: number) {
    this.set(chatId, until);
  }

  /** Wakes the chat now, or forgets the snooze it had. */
  wake(chatId: string) {
    this.forget(chatId);
  }

  /** Whether the chat is snoozed and hasn't woken yet. */
  isSnoozed = (chatId: string) => (this.getSnapshot()[chatId] ?? 0) > this.now();
}

export const CLEARED_KEY = "hermes-chat.cleared";
export const CLEARED_VERSION = 1;
const CLEARED_MIGRATIONS: UIPrefsMigrations = { 0: (doc) => doc };

/**
 * The chats the owner cleared from the Inbox, for one connection and profile, kept in `storage`. Each is kept with
 * `lastActive` (snooze.ts `lastActive`) as it was then; the chat is back in the Inbox once something newer happens in it.
 */
export class ClearedStore extends ChatTimesStore {
  constructor(storage: SnoozeStorage, scope: string, now: () => number = Date.now) {
    super(storage, scope, now, CLEARED_KEY, CLEARED_VERSION, CLEARED_MIGRATIONS);
  }

  /**
   * Clears the chat from the Inbox as it is now: `mark`, when it was last active, kept exactly (Hermes's activity times
   * have fractions of a millisecond, and a mark rounded down would leave the chat in the Inbox).
   */
  clear(chatId: string, mark: number) {
    this.set(chatId, mark > 0 ? mark : 1);
  }

  /** Puts the chat back in the Inbox, or forgets a clear that no longer holds. */
  restore(chatId: string) {
    if (chatId in this.getSnapshot()) this.forget(chatId);
  }
}

/** `at` local time on the day `days` after `from`'s. */
function dayAt(from: Date, days: number, hour = MORNING): number {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, hour, 0, 0, 0);
  return d.getTime();
}

export type SnoozePreset = { key: string; label: string; until: number };

/** The right-click menu's ready-made snoozes: 1 hour, 3 hours, tomorrow morning, and next Monday morning. */
export function snoozePresets(now: number): SnoozePreset[] {
  const today = new Date(now);
  // The coming Monday; on a Monday, the one a week on.
  const toMonday = (8 - today.getDay()) % 7 || 7;
  return [
    { key: "1h", label: "1 hour", until: now + HOUR },
    { key: "3h", label: "3 hours", until: now + 3 * HOUR },
    { key: "tomorrow", label: "Tomorrow", until: dayAt(today, 1) },
    { key: "week", label: "Next week", until: dayAt(today, toMonday) },
  ];
}

export const DURATION_UNITS = { minutes: 60_000, hours: HOUR, days: DAY, weeks: 7 * DAY } as const;
export type DurationUnit = keyof typeof DURATION_UNITS;

/** A custom snooze's wake time, or why it can't be one. `at`: a `datetime-local` value, read as local time. */
export function customUntil(input: { at: string } | { amount: string; unit: DurationUnit }, now: number): number | string {
  let until: number;
  if ("at" in input) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input.at);
    if (!m) return "Pick a date and time.";
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d, h, mi);
    // Rolled over (Feb 30): not a date. Moved by a clock change (02:30 on the night clocks go forward): not a time.
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) return "That date doesn't exist.";
    if (date.getHours() !== h || date.getMinutes() !== mi) return "That time is skipped when the clocks change.";
    until = date.getTime();
  } else {
    const n = Number(input.amount);
    if (!input.amount.trim() || !Number.isFinite(n) || n <= 0) return "Enter how long, more than zero.";
    until = now + n * DURATION_UNITS[input.unit];
  }
  if (until <= now) return "Pick a time in the future.";
  if (until - now > SNOOZE_MAX_MS) return "Snooze for a year at most.";
  return Math.round(until);
}

/** When a snoozed chat wakes, short enough for a row: "3:00 PM", "Tue 9:00 AM", "Dec 4". */
export function wakeLabel(until: number, now: number): string {
  const u = new Date(until);
  const time = u.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (u.toDateString() === new Date(now).toDateString()) return time;
  if (until - now < 6 * DAY) return `${u.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return u.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** When a snoozed chat wakes, in full, for a tooltip or a toast. */
export const wakeFull = (until: number) =>
  new Date(until).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Hermes is writing a reply in the chat and isn't waiting on the owner. */
export const isWorking = (c: Chat) => !!c.running && !c.items.some(isWaiting);

/**
 * When each chat last stopped working, as this app saw it while running: a reply ended, or Hermes stopped to ask the
 * owner something. The top of the list sorts by it, so a chat that starts needing the owner goes first even when
 * Hermes doesn't count that as activity (an Approval doesn't change when the chat was last active).
 */
export class AttentionClock {
  private working = new Set<string>();
  readonly since: Record<string, number> = {};
  /**
   * Notes the chats as they are now; call it each time they change. While not `connected`, every reply shows as
   * stopped, though Hermes may still be writing it, so nothing counts as having stopped then.
   */
  observe(chats: Chat[], now: number, connected = true) {
    for (const c of chats) {
      if (isWorking(c)) this.working.add(c.id);
      else if (this.working.delete(c.id) && connected) this.since[c.id] = now;
    }
  }
}

export { SECTION_KEYS, SECTION_LABEL, type SectionKey } from "./sectionKeys";

export type ChatSections = Record<SectionKey, Chat[]>;

/**
 * When the chat was last active as the list counts it: Hermes's last activity, the time it woke from a snooze in the
 * past WOKEN_KEPT_MS, or when this app saw it stop working (`since`, from an AttentionClock).
 */
export function lastActive(c: Chat, snoozes: Snoozes, now: number, since: Readonly<Record<string, number>> = {}): number {
  // A snooze that woke more than WOKEN_KEPT_MS ago no longer counts, though it is only forgotten at the next change.
  const until = snoozes[c.id] ?? 0;
  const woke = until <= now && until > now - WOKEN_KEPT_MS ? until : 0;
  return Math.max(c.updatedAt, woke, since[c.id] ?? 0);
}

/** The chat can be cleared from the Inbox: the owner has read it, and Hermes isn't replying in it or waiting on them. */
export const canClear = (c: Chat) => !c.unread && !c.running && !c.items.some(isWaiting) && !c.settled && !c.archived;

/**
 * The clears among `chats` that no longer hold, because something happened in the chat after it was cleared, or it is
 * Unread or Hermes waits on the owner in it. Forgetting them keeps the chat in the Inbox once that activity stops
 * counting (a woken snooze does after WOKEN_KEPT_MS). A reply still running doesn't end a clear: its end does.
 */
export function staleClears(chats: Chat[], snoozes: Snoozes, now: number, since: Readonly<Record<string, number>>, cleared: Cleared): string[] {
  return chats
    .filter((c) => cleared[c.id] !== undefined && (lastActive(c, snoozes, now, since) > cleared[c.id] || !!c.unread || c.items.some(isWaiting)))
    .map((c) => c.id);
}

/**
 * Where each chat shows in the list, in the order shown. The Inbox is newest first, a chat counting as new when it woke
 * from a snooze or stopped working (`lastActive`). Working, Unsettled and Settled are newest first; Snoozed wakes
 * soonest first. A cleared chat (`cleared`) is in Unsettled until something happens in it after it was cleared, or it is
 * unread or waiting on the owner; it is then back in the Inbox.
 */
export function chatSections(
  chats: Chat[],
  snoozes: Snoozes,
  now: number,
  since: Readonly<Record<string, number>> = {},
  cleared: Cleared = {},
): ChatSections {
  const recent = (c: Chat) => lastActive(c, snoozes, now, since);
  const byRecent = (a: Chat, b: Chat) => recent(b) - recent(a);
  const s: ChatSections = { inbox: [], working: [], snoozed: [], unsettled: [], settled: [], archived: [] };
  for (const c of chats) {
    if (c.archived) s.archived.push(c);
    else if (c.settled) s.settled.push(c);
    else if ((snoozes[c.id] ?? 0) > now) s.snoozed.push(c);
    else if (isWorking(c)) s.working.push(c);
    else if (cleared[c.id] !== undefined && recent(c) <= cleared[c.id] && canClear(c)) s.unsettled.push(c);
    else s.inbox.push(c);
  }
  s.inbox.sort(byRecent);
  s.working.sort(byRecent);
  s.unsettled.sort(byRecent);
  s.settled.sort((a, b) => b.updatedAt - a.updatedAt);
  s.archived.sort((a, b) => b.updatedAt - a.updatedAt);
  s.snoozed.sort((a, b) => snoozes[a.id] - snoozes[b.id]);
  return s;
}

/** The next time a snooze wakes after `now`, if any. */
export function nextWake(snoozes: Snoozes, now: number): number | undefined {
  let next: number | undefined;
  for (const until of Object.values(snoozes)) if (until > now && (next === undefined || until < next)) next = until;
  return next;
}
