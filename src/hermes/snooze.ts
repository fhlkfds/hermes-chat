// Snoozing, and the chat list's sections (GLOSSARY.md, ADR 0036). Hermes has nowhere to keep a snooze, so it is kept on
// this computer only, in one versioned localStorage document, separately for each connection and profile (the scope
// projectLinks.ts `projectScope` gives), and never sent to Hermes. A snooze is the time the chat wakes, in Unix ms.
//
// The list shows a chat that isn't Archived in one place only, worked out from what the app already reads:
//   1. Settled: the owner settled it (ADR 0002). It stays there whatever happens in it.
//   2. Snoozed: the owner snoozed it and it hasn't woken yet.
//   3. Working: Hermes is writing a reply in it and isn't waiting on the owner.
//   4. Otherwise it is at the top: Hermes waits for the owner's answer, or is done.
import type { Chat } from "./model";
import { isWaiting } from "./model";
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

/** One connection and profile's snoozes: when each chat wakes, Unix ms. */
export type Snoozes = Readonly<Record<string, number>>;
export type SnoozeStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY: Snoozes = Object.freeze({});
const isDoc = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, max = 400) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** One scope's snoozes as stored; anything that isn't valid is left out. */
function toSnoozes(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isDoc(v)) return out;
  for (const [chat, until] of Object.entries(v).slice(0, CHATS_PER_SCOPE))
    if (id(chat) && typeof until === "number" && Number.isFinite(until) && until > 0) out[chat] = until;
  return out;
}

/** Snoozes woken longer ago than WOKEN_KEPT_MS go. */
const pruned = (s: Record<string, number>, now: number) => Object.fromEntries(Object.entries(s).filter(([, until]) => until > now - WOKEN_KEPT_MS));

/**
 * The snoozes for one connection and profile, kept in `storage`. A change that can't be stored (storage full) is held
 * in memory while the app runs. `reread` picks up another window's change.
 */
export class SnoozeStore {
  private snap: Snoozes = EMPTY;
  private cachedRaw: string | null | undefined;
  private doc: UIPrefsDoc = { v: SNOOZE_VERSION };
  private listeners = new Set<() => void>();

  constructor(
    private storage: SnoozeStorage,
    private scope: string,
    private now: () => number = Date.now,
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

  /** Snoozes the chat until `until` (Unix ms), replacing any snooze it had. */
  snooze(chatId: string, until: number) {
    this.change((s) => ({ ...s, [chatId]: until }));
  }

  /** Wakes the chat now, or forgets the snooze it had. */
  wake(chatId: string) {
    this.change(({ [chatId]: _, ...s }) => s);
  }

  /** Whether the chat is snoozed and hasn't woken yet. */
  isSnoozed = (chatId: string) => (this.snap[chatId] ?? 0) > this.now();

  private read(): boolean {
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(SNOOZE_KEY);
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
    this.doc = migrateDoc(parsed, SNOOZE_MIGRATIONS, SNOOZE_VERSION);
    const scopes = isDoc(this.doc.scopes) ? this.doc.scopes : {};
    const next = toSnoozes(scopes[this.scope]);
    if (JSON.stringify(next) === JSON.stringify(this.snap)) return false;
    this.snap = Object.freeze(next);
    return true;
  }

  private change(fn: (s: Record<string, number>) => Record<string, number>) {
    this.read();
    const next = pruned(fn({ ...this.snap }), this.now());
    if (JSON.stringify(next) === JSON.stringify(this.snap)) return;
    this.snap = Object.freeze(next);
    // Only this scope is rewritten; other scopes, and fields a newer app wrote, are kept.
    const scopes = isDoc(this.doc.scopes) ? { ...this.doc.scopes } : {};
    if (Object.keys(next).length) scopes[this.scope] = next;
    else delete scopes[this.scope];
    const kept = Object.fromEntries(Object.entries(scopes).slice(-SCOPE_LIMIT));
    this.doc = { ...this.doc, v: Math.max(SNOOZE_VERSION, Number(this.doc.v) || 0), scopes: kept };
    const raw = JSON.stringify(this.doc);
    try {
      this.storage.setItem(SNOOZE_KEY, raw);
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

export type ChatSections = { top: Chat[]; working: Chat[]; snoozed: Chat[]; settled: Chat[]; archived: Chat[] };

/**
 * Where each chat shows in the list, in the order shown. The top is newest first, a chat counting as new when it woke
 * from a snooze or stopped working (`since`, from an AttentionClock). Working and Settled are newest first; Snoozed
 * wakes soonest first.
 */
export function chatSections(chats: Chat[], snoozes: Snoozes, now: number, since: Readonly<Record<string, number>> = {}): ChatSections {
  // A snooze that woke more than WOKEN_KEPT_MS ago no longer counts, though it is only forgotten at the next change.
  const woke = (id: string) => ((snoozes[id] ?? 0) > now - WOKEN_KEPT_MS ? snoozes[id] : 0);
  const recent = (c: Chat) => Math.max(c.updatedAt, woke(c.id), since[c.id] ?? 0);
  const byRecent = (a: Chat, b: Chat) => recent(b) - recent(a);
  const s: ChatSections = { top: [], working: [], snoozed: [], settled: [], archived: [] };
  for (const c of chats) {
    if (c.archived) s.archived.push(c);
    else if (c.settled) s.settled.push(c);
    else if ((snoozes[c.id] ?? 0) > now) s.snoozed.push(c);
    else if (isWorking(c)) s.working.push(c);
    else s.top.push(c);
  }
  s.top.sort(byRecent);
  s.working.sort(byRecent);
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
