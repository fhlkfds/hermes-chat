import { describe, expect, it } from "vitest";
import type { Chat, Item } from "./model";
import { AttentionClock, SNOOZE_KEY, SnoozeStore, WOKEN_KEPT_MS, chatSections, customUntil, nextWake, snoozePresets, wakeLabel } from "./snooze";

/** A Storage stand-in, its document readable as `raw`. */
function memory(start?: string) {
  const m = new Map<string, string>(start === undefined ? [] : [[SNOOZE_KEY, start]]);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    get raw() {
      return JSON.parse(m.get(SNOOZE_KEY) ?? "null");
    },
  };
}

const HOUR = 3_600_000;
// Wednesday 2026-11-04, 10:30 local time.
const WED = new Date(2026, 10, 4, 10, 30).getTime();

const chat = (id: string, updatedAt: number, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt, items: [], ...extra });
const waiting: Item = { kind: "approval", id: "ap", requestId: "r", command: "rm", description: "", choices: [], allowSession: true, allowPermanent: true };

describe("SnoozeStore", () => {
  it("keeps each connection and profile's snoozes apart, and leaves the others alone", () => {
    const storage = memory();
    const a = new SnoozeStore(storage, "A", () => WED);
    const b = new SnoozeStore(storage, "B", () => WED);
    a.snooze("x", WED + HOUR);
    b.snooze("y", WED + 2 * HOUR);
    expect(storage.raw).toEqual({ v: 1, scopes: { A: { x: WED + HOUR }, B: { y: WED + 2 * HOUR } } });
    expect(new SnoozeStore(storage, "A", () => WED).getSnapshot()).toEqual({ x: WED + HOUR });
    expect(a.isSnoozed("x")).toBe(true);
    expect(a.isSnoozed("y")).toBe(false);
    a.wake("x");
    expect(storage.raw).toEqual({ v: 1, scopes: { B: { y: WED + 2 * HOUR } } });
  });

  it("tells subscribers about its own changes and, on reread, another window's", () => {
    const storage = memory();
    const here = new SnoozeStore(storage, "A", () => WED);
    const there = new SnoozeStore(storage, "A", () => WED);
    let heard = 0;
    here.subscribe(() => heard++);
    here.snooze("x", WED + HOUR);
    expect(heard).toBe(1);
    there.snooze("y", WED + HOUR);
    here.reread();
    expect(heard).toBe(2);
    expect(here.getSnapshot()).toEqual({ x: WED + HOUR, y: WED + HOUR });
    here.reread();
    expect(heard).toBe(2);
  });

  it("forgets snoozes that woke more than a week ago, and keeps fields it doesn't know", () => {
    const old = WED - WOKEN_KEPT_MS - 1;
    const storage = memory(JSON.stringify({ v: 1, later: true, scopes: { A: { old, recent: WED - HOUR, bad: "soon" }, Z: { q: 5 } } }));
    const store = new SnoozeStore(storage, "A", () => WED);
    expect(store.getSnapshot()).toEqual({ old, recent: WED - HOUR });
    store.snooze("x", WED + HOUR);
    expect(storage.raw).toEqual({ v: 1, later: true, scopes: { A: { recent: WED - HOUR, x: WED + HOUR }, Z: { q: 5 } } });
  });

  it("starts empty from an unreadable document", () => {
    expect(new SnoozeStore(memory("{nope"), "A", () => WED).getSnapshot()).toEqual({});
  });

  it("holds a change in memory when storage is full", () => {
    const store = new SnoozeStore(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      },
      "A",
      () => WED,
    );
    store.snooze("x", WED + HOUR);
    expect(store.getSnapshot()).toEqual({ x: WED + HOUR });
  });
});

describe("snoozePresets", () => {
  it("offers 1 hour, 3 hours, tomorrow at 9 and next Monday at 9", () => {
    expect(snoozePresets(WED).map((p) => [p.label, p.until])).toEqual([
      ["1 hour", WED + HOUR],
      ["3 hours", WED + 3 * HOUR],
      ["Tomorrow", new Date(2026, 10, 5, 9).getTime()],
      ["Next week", new Date(2026, 10, 9, 9).getTime()],
    ]);
  });

  it("puts next week a week on when today is Monday, and on the coming Monday from a Sunday", () => {
    const mon = new Date(2026, 10, 9, 8).getTime();
    expect(snoozePresets(mon)[3].until).toBe(new Date(2026, 10, 16, 9).getTime());
    const sun = new Date(2026, 10, 8, 20).getTime();
    expect(snoozePresets(sun)[3].until).toBe(new Date(2026, 10, 9, 9).getTime());
  });
});

describe("customUntil", () => {
  it("reads a date and time as local time", () => {
    expect(customUntil({ at: "2026-11-06T14:15" }, WED)).toBe(new Date(2026, 10, 6, 14, 15).getTime());
  });

  it("adds a duration", () => {
    expect(customUntil({ amount: "90", unit: "minutes" }, WED)).toBe(WED + 1.5 * HOUR);
    expect(customUntil({ amount: "1.5", unit: "days" }, WED)).toBe(WED + 36 * HOUR);
    expect(customUntil({ amount: "2", unit: "weeks" }, WED)).toBe(WED + 14 * 24 * HOUR);
  });

  it("says what's wrong with a time that can't be one", () => {
    expect(customUntil({ at: "" }, WED)).toBe("Pick a date and time.");
    expect(customUntil({ at: "2026-02-30T09:00" }, WED)).toBe("That date doesn't exist.");
    expect(customUntil({ at: "2026-11-04T10:00" }, WED)).toBe("Pick a time in the future.");
    expect(customUntil({ amount: "0", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "-3", unit: "hours" }, WED)).toBe("Enter how long, more than zero.");
    expect(customUntil({ amount: "2", unit: "weeks" }, WED)).toBeTypeOf("number");
    expect(customUntil({ amount: "400", unit: "days" }, WED)).toBe("Snooze for a year at most.");
  });
});

describe("chatSections", () => {
  const snoozes = { snoozed: WED + HOUR, woke: WED - 60_000, later: WED + 5 * HOUR };
  const chats = [
    chat("done", WED - 10 * 60_000),
    chat("working", WED - 5 * 60_000, { running: true }),
    chat("asking", WED - 20 * 60_000, { running: true, items: [waiting] }),
    chat("snoozed", WED - 1),
    chat("later", WED - 2, { running: true }),
    chat("woke", WED - 3 * HOUR),
    chat("settled", WED, { settled: true, running: true }),
    chat("settledSnoozed", WED, { settled: true }),
    chat("archived", WED, { archived: true }),
  ];

  it("puts each chat in one place: Settled, then Snoozed, then Working, else at the top", () => {
    const s = chatSections(chats, { ...snoozes, settledSnoozed: WED + HOUR }, WED);
    expect(s.top.map((c) => c.id)).toEqual(["woke", "done", "asking"]);
    expect(s.working.map((c) => c.id)).toEqual(["working"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["snoozed", "later"]);
    expect(s.settled.map((c) => c.id)).toEqual(["settled", "settledSnoozed"]);
    expect(s.archived.map((c) => c.id)).toEqual(["archived"]);
  });

  it("brings a chat back to the top once its snooze wakes, as new as when it woke", () => {
    const s = chatSections(chats, snoozes, WED + 2 * HOUR);
    expect(s.top.map((c) => c.id)).toEqual(["snoozed", "woke", "done", "asking"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["later"]);
  });

  it("puts a chat that stopped working first, by when it stopped, though Hermes's activity time is older", () => {
    const clock = new AttentionClock();
    const before = [chat("asks", WED - HOUR, { running: true }), chat("done", WED - 60_000)];
    clock.observe(before, WED - 30_000);
    expect(chatSections(before, {}, WED, clock.since).top.map((c) => c.id)).toEqual(["done"]);
    const after = [chat("asks", WED - HOUR, { running: true, items: [waiting] }), chat("done", WED - 60_000)];
    clock.observe(after, WED);
    expect(clock.since).toEqual({ asks: WED });
    expect(chatSections(after, {}, WED, clock.since).top.map((c) => c.id)).toEqual(["asks", "done"]);
    // Noting the same chats again changes nothing.
    clock.observe(after, WED + HOUR);
    expect(clock.since).toEqual({ asks: WED });
  });

  it("doesn't count a reply cut off by a dropped connection as stopped", () => {
    const clock = new AttentionClock();
    clock.observe([chat("a", WED - HOUR, { running: true })], WED - 60_000);
    clock.observe([chat("a", WED - HOUR)], WED, false);
    expect(clock.since).toEqual({});
  });

  it("stops counting a snooze that woke more than a week ago", () => {
    const old = WED - WOKEN_KEPT_MS - 1;
    const s = chatSections([chat("a", WED - 10 * 24 * HOUR), chat("b", WED - 9 * 24 * HOUR)], { a: old }, WED);
    expect(s.top.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("finds the next wake", () => {
    expect(nextWake(snoozes, WED)).toBe(WED + HOUR);
    expect(nextWake(snoozes, WED + 2 * HOUR)).toBe(WED + 5 * HOUR);
    expect(nextWake(snoozes, WED + 6 * HOUR)).toBeUndefined();
  });
});

describe("wakeLabel", () => {
  it("gives the time today, the weekday this week, and the date further off", () => {
    expect(wakeLabel(WED + HOUR, WED)).toBe(new Date(WED + HOUR).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(wakeLabel(WED + 24 * HOUR, WED)).toMatch(/^\S+ /);
    expect(wakeLabel(WED + 30 * 24 * HOUR, WED)).toBe(new Date(WED + 30 * 24 * HOUR).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});
