import { describe, expect, it } from "vitest";
import { CLEARED_KEY, takeHeldClears } from "./clearsToSettle";
import type { Chat, Item } from "./model";

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 6, 10, 30).getTime();
const SCOPE = "ssh:liam@hermes\u0000default";

const chat = (id: string, updatedAt: number, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt, items: [], ...extra });
const waiting: Item = { kind: "approval", id: "ap", requestId: "r", command: "rm", description: "", choices: [], allowSession: true, allowPermanent: true };

/** A Storage stand-in holding the old clear store. */
function storage(start?: unknown, over: { setThrows?: boolean; getThrows?: boolean } = {}) {
  const m = new Map<string, string>(start === undefined ? [] : [[CLEARED_KEY, typeof start === "string" ? start : JSON.stringify(start)]]);
  return {
    getItem: (k: string) => {
      if (over.getThrows) throw new Error("denied");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (over.setThrows) throw new Error("full");
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
    get doc() {
      const raw = m.get(CLEARED_KEY);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}
const cleared = (marks: Record<string, number>, others: Record<string, Record<string, number>> = {}) => ({ v: 1, scopes: { [SCOPE]: marks, ...others } });
const take = (st: ReturnType<typeof storage>, chats: Chat[], extra: { snoozes?: Record<string, number>; pins?: Record<string, number>; since?: Record<string, number> } = {}) =>
  takeHeldClears(st, SCOPE, chats, extra.snoozes ?? {}, extra.pins ?? {}, NOW, extra.since);

describe("takeHeldClears", () => {
  it("answers the cleared chats nothing has happened in since, newest mark or older", () => {
    const st = storage(cleared({ quiet: NOW - HOUR, later: NOW }));
    expect(take(st, [chat("quiet", NOW - HOUR), chat("later", NOW - 2 * HOUR), chat("untouched", NOW - HOUR)]).sort()).toEqual(["later", "quiet"]);
  });

  it("drops a clear that no longer holds: newer activity, unread, waiting, running", () => {
    const marks = { newer: NOW - HOUR, unread: NOW, waits: NOW, runs: NOW };
    const chats = [
      chat("newer", NOW - HOUR + 1),
      chat("unread", NOW - HOUR, { unread: true }),
      chat("waits", NOW - HOUR, { items: [waiting] }),
      chat("runs", NOW - HOUR, { running: true }),
    ];
    const st = storage(cleared(marks));
    expect(take(st, chats)).toEqual([]);
    expect(st.doc).toBeUndefined();
  });

  it("counts a woken snooze and a reply this app saw stop as activity after the clear", () => {
    const marks = { woke: NOW - HOUR, stopped: NOW - HOUR };
    const chats = [chat("woke", NOW - HOUR), chat("stopped", NOW - HOUR)];
    expect(take(storage(cleared(marks)), chats, { snoozes: { woke: NOW - 60_000 }, since: { stopped: NOW - 1 } })).toEqual([]);
  });

  it("answers nothing for a chat the list has put somewhere other than the Inbox: snoozed, pinned, settled, archived", () => {
    const marks = { z: NOW, p: NOW, s: NOW, a: NOW };
    const chats = [chat("z", NOW - HOUR), chat("p", NOW - HOUR), chat("s", NOW - HOUR, { settled: true }), chat("a", NOW - HOUR, { archived: true })];
    expect(take(storage(cleared(marks)), chats, { snoozes: { z: NOW + HOUR }, pins: { p: NOW - 1 } })).toEqual([]);
  });

  it("answers nothing for a chat missing from the list, and still forgets its clear", () => {
    const st = storage(cleared({ gone: NOW }));
    expect(take(st, [chat("other", NOW - HOUR)])).toEqual([]);
    expect(st.doc).toBeUndefined();
  });

  it("keeps a held fractional mark held: the mark is Hermes's activity time exactly", () => {
    const at = NOW - HOUR + 0.25;
    expect(take(storage(cleared({ frac: at })), [chat("frac", at)])).toEqual(["frac"]);
  });

  it("takes only this scope's clears, keeping the others and the fields it doesn't know", () => {
    const st = storage({ ...cleared({ a: NOW }, { other: { x: NOW } }), later: true });
    expect(take(st, [chat("a", NOW - HOUR)])).toEqual(["a"]);
    expect(st.doc).toEqual({ v: 1, later: true, scopes: { other: { x: NOW } } });
  });

  it("removes the key once the last scope goes", () => {
    const st = storage(cleared({ a: NOW }));
    take(st, [chat("a", NOW - HOUR)]);
    expect(st.doc).toBeUndefined();
  });

  it("is a no-op the second time, and for a scope with no clears", () => {
    const st = storage(cleared({ a: NOW }, { other: { x: NOW } }));
    expect(take(st, [chat("a", NOW - HOUR)])).toEqual(["a"]);
    const after = JSON.stringify(st.doc);
    expect(take(st, [chat("a", NOW - HOUR)])).toEqual([]);
    expect(JSON.stringify(st.doc)).toBe(after);
    const empty = storage();
    expect(take(empty, [chat("a", NOW - HOUR)])).toEqual([]);
    expect(empty.doc).toBeUndefined();
  });

  it("answers nothing, throwing nothing, for an unreadable document or storage that throws", () => {
    for (const raw of ["{nope", "null", "[1]", '"x"', JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, scopes: [] })]) {
      expect(take(storage(raw), [chat("a", NOW - HOUR)])).toEqual([]);
    }
    expect(take(storage(cleared({ a: NOW }), { getThrows: true }), [chat("a", NOW - HOUR)])).toEqual([]);
  });

  it("ignores marks that aren't times", () => {
    expect(take(storage(cleared({ a: "now" as unknown as number, b: NOW })), [chat("a", NOW - HOUR), chat("b", NOW - HOUR)])).toEqual(["b"]);
  });

  it("still answers the held chats when the document can't be written back", () => {
    expect(take(storage(cleared({ a: NOW }), { setThrows: true }), [chat("a", NOW - HOUR)])).toEqual(["a"]);
    expect(take(storage(cleared({ a: NOW }, { other: { x: 1 } }), { setThrows: true }), [chat("a", NOW - HOUR)])).toEqual(["a"]);
  });
});
