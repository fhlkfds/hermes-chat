import { describe, expect, it } from "vitest";
import type { Chat, Item } from "./model";
import { AttentionClock, CLEARED_KEY, ClearedStore, SNOOZE_KEY, SnoozeStore, WOKEN_KEPT_MS, canClear, chatSections, customUntil, lastActive, nextWake, snoozePresets, wakeLabel } from "./snooze";

/** A Storage stand-in, its document under `key` readable as `raw`. */
function memory(start?: string, key = SNOOZE_KEY) {
  const m = new Map<string, string>(start === undefined ? [] : [[key, start]]);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    get raw() {
      return JSON.parse(m.get(key) ?? "null");
    },
    get keys() {
      return [...m.keys()];
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

  it("puts each chat in one place: Archived, Settled, Snoozed, Working, Unsettled, else the Inbox", () => {
    const s = chatSections(chats, { ...snoozes, settledSnoozed: WED + HOUR }, WED);
    expect(s.inbox.map((c) => c.id)).toEqual(["woke", "done", "asking"]);
    expect(s.working.map((c) => c.id)).toEqual(["working"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["snoozed", "later"]);
    expect(s.settled.map((c) => c.id)).toEqual(["settled", "settledSnoozed"]);
    expect(s.archived.map((c) => c.id)).toEqual(["archived"]);
    expect(s.unsettled).toEqual([]);
  });

  it("brings a chat back to the top once its snooze wakes, as new as when it woke", () => {
    const s = chatSections(chats, snoozes, WED + 2 * HOUR);
    expect(s.inbox.map((c) => c.id)).toEqual(["snoozed", "woke", "done", "asking"]);
    expect(s.snoozed.map((c) => c.id)).toEqual(["later"]);
  });

  it("puts a chat that stopped working first, by when it stopped, though Hermes's activity time is older", () => {
    const clock = new AttentionClock();
    const before = [chat("asks", WED - HOUR, { running: true }), chat("done", WED - 60_000)];
    clock.observe(before, WED - 30_000);
    expect(chatSections(before, {}, WED, clock.since).inbox.map((c) => c.id)).toEqual(["done"]);
    const after = [chat("asks", WED - HOUR, { running: true, items: [waiting] }), chat("done", WED - 60_000)];
    clock.observe(after, WED);
    expect(clock.since).toEqual({ asks: WED });
    expect(chatSections(after, {}, WED, clock.since).inbox.map((c) => c.id)).toEqual(["asks", "done"]);
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
    expect(s.inbox.map((c) => c.id)).toEqual(["b", "a"]);
  });

  describe("clearing from the Inbox", () => {
    const quiet = chat("quiet", WED - HOUR);
    const other = chat("other", WED - 2 * HOUR);

    it("puts a cleared chat in Unsettled, newest first, and leaves the rest in the Inbox", () => {
      const older = chat("older", WED - 3 * HOUR);
      const s = chatSections([older, quiet, other], {}, WED, {}, { quiet: WED - HOUR, older: WED - 3 * HOUR });
      expect(s.inbox.map((c) => c.id)).toEqual(["other"]);
      expect(s.unsettled.map((c) => c.id)).toEqual(["quiet", "older"]);
    });

    it("brings a cleared chat back to the Inbox on anything newer: a message, a woken snooze, a reply that stopped", () => {
      const cleared = { quiet: WED - HOUR };
      expect(chatSections([chat("quiet", WED - HOUR + 1)], {}, WED, {}, cleared).inbox.map((c) => c.id)).toEqual(["quiet"]);
      expect(chatSections([quiet], { quiet: WED - 60_000 }, WED, {}, cleared).inbox.map((c) => c.id)).toEqual(["quiet"]);
      expect(chatSections([quiet], {}, WED, { quiet: WED - 60_000 }, cleared).inbox.map((c) => c.id)).toEqual(["quiet"]);
      expect(chatSections([quiet], {}, WED, {}, cleared).unsettled.map((c) => c.id)).toEqual(["quiet"]);
    });

    it("never keeps an unread chat, or one waiting on the owner, out of the Inbox", () => {
      const cleared = { quiet: WED };
      expect(chatSections([chat("quiet", WED - HOUR, { unread: true })], {}, WED, {}, cleared).inbox.map((c) => c.id)).toEqual(["quiet"]);
      expect(chatSections([chat("quiet", WED - HOUR, { items: [waiting] })], {}, WED, {}, cleared).inbox.map((c) => c.id)).toEqual(["quiet"]);
    });

    it("leaves a cleared chat where settling, snoozing, working or archiving puts it", () => {
      const cleared = { s: WED, z: WED, w: WED, a: WED };
      const s = chatSections(
        [chat("s", WED - HOUR, { settled: true }), chat("z", WED - HOUR), chat("w", WED - HOUR, { running: true }), chat("a", WED - HOUR, { archived: true })],
        { z: WED + HOUR },
        WED,
        {},
        cleared,
      );
      expect([s.settled, s.snoozed, s.working, s.archived].map((l) => l.map((c) => c.id))).toEqual([["s"], ["z"], ["w"], ["a"]]);
      expect(s.unsettled).toEqual([]);
    });

    it("offers Clear only for a read, quiet, Active chat", () => {
      expect(canClear(quiet)).toBe(true);
      expect(canClear(chat("x", WED, { unread: true }))).toBe(false);
      expect(canClear(chat("x", WED, { running: true }))).toBe(false);
      expect(canClear(chat("x", WED, { items: [waiting] }))).toBe(false);
      expect(canClear(chat("x", WED, { settled: true }))).toBe(false);
      expect(canClear(chat("x", WED, { archived: true }))).toBe(false);
    });

    it("counts a woken snooze and a stopped reply as activity, and a snooze still asleep as none", () => {
      expect(lastActive(quiet, { quiet: WED - 60_000 }, WED)).toBe(WED - 60_000);
      expect(lastActive(quiet, { quiet: WED + HOUR }, WED)).toBe(WED - HOUR);
      expect(lastActive(quiet, {}, WED, { quiet: WED - 1 })).toBe(WED - 1);
    });
  });

  it("finds the next wake", () => {
    expect(nextWake(snoozes, WED)).toBe(WED + HOUR);
    expect(nextWake(snoozes, WED + 2 * HOUR)).toBe(WED + 5 * HOUR);
    expect(nextWake(snoozes, WED + 6 * HOUR)).toBeUndefined();
  });
});

describe("ClearedStore", () => {
  it("keeps each connection and profile's cleared chats apart, under its own key, and survives a restart", () => {
    const storage = memory(undefined, CLEARED_KEY);
    const a = new ClearedStore(storage, "A", () => WED);
    const b = new ClearedStore(storage, "B", () => WED);
    a.clear("x", WED - HOUR);
    b.clear("y", WED - 2 * HOUR);
    expect(storage.keys).toEqual([CLEARED_KEY]);
    expect(storage.raw).toEqual({ v: 1, scopes: { A: { x: WED - HOUR }, B: { y: WED - 2 * HOUR } } });
    expect(new ClearedStore(storage, "A").getSnapshot()).toEqual({ x: WED - HOUR });
    a.restore("x");
    expect(storage.raw).toEqual({ v: 1, scopes: { B: { y: WED - 2 * HOUR } } });
  });

  it("keeps a clear of a chat that has no activity time yet, and ignores what isn't one", () => {
    const storage = memory(JSON.stringify({ v: 1, scopes: { A: { good: 5, bad: "x", neg: -1 } } }), CLEARED_KEY);
    const a = new ClearedStore(storage, "A");
    expect(a.getSnapshot()).toEqual({ good: 5 });
    a.clear("zero", 0);
    expect(a.getSnapshot()).toEqual({ good: 5, zero: 1 });
  });

  it("drops the oldest clears past its limit, not the newest", () => {
    const many = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`c${i}`, i + 1]));
    const storage = memory(JSON.stringify({ v: 1, scopes: { A: many } }), CLEARED_KEY);
    const a = new ClearedStore(storage, "A");
    a.clear("newest", WED);
    expect(a.getSnapshot().newest).toBe(WED);
    expect(a.getSnapshot().c0).toBeUndefined();
    expect(Object.keys(a.getSnapshot())).toHaveLength(5_000);
  });

  it("tells subscribers about its own changes and, on reread, another window's; restoring what isn't cleared changes nothing", () => {
    const storage = memory(undefined, CLEARED_KEY);
    const a = new ClearedStore(storage, "A");
    const other = new ClearedStore(storage, "A");
    let heard = 0;
    a.subscribe(() => heard++);
    a.restore("nothing");
    expect(heard).toBe(0);
    other.clear("x", WED);
    a.reread();
    expect(heard).toBe(1);
    expect(a.getSnapshot()).toEqual({ x: WED });
  });
});

describe("wakeLabel", () => {
  it("gives the time today, the weekday this week, and the date further off", () => {
    expect(wakeLabel(WED + HOUR, WED)).toBe(new Date(WED + HOUR).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(wakeLabel(WED + 24 * HOUR, WED)).toMatch(/^\S+ /);
    expect(wakeLabel(WED + 30 * 24 * HOUR, WED)).toBe(new Date(WED + 30 * 24 * HOUR).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});
