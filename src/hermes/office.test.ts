import { describe, expect, it } from "vitest";
import { inboxEntries, type InboxEntry } from "./inbox";
import type { Chat, OtherProfiles } from "./model";
import { FLOOR_MAX, GROUP_SEATS, ROOM_OF, floorLayout, officeRooms, officeTally, type FloorLayout } from "./office";
import { SUBAGENTS_MAX, onSubagentEvent, type SubagentTree } from "./subagents";

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: 1_000, items: [], ...over });
const started = (tree: SubagentTree | undefined, id: string, more: Record<string, unknown> = {}) =>
  onSubagentEvent(tree, "subagent.start", { subagent_id: id, goal: `Goal ${id}`, depth: 0, ...more }, 2_000);
const none: OtherProfiles = { byName: {} };

function rooms(chats: Chat[], { others = none, connected = true, dismissed = new Set<string>() } = {}) {
  const { entries } = inboxEntries({ profile: "default", chats, connected, others });
  return officeRooms({ entries, shown: (e: InboxEntry) => !dismissed.has(e.key), chats, profile: "default", connected });
}
const brief = (rs: ReturnType<typeof rooms>) => rs.map((r) => `${r.profile}/${r.chatId}: ${r.desks.map((d) => d.state).join(" ")}`);

describe("The office's rooms", () => {
  it("has a room for each chat the inbox lists, then each chat with subagents, the reply's desk first", () => {
    const tree = started(started(undefined, "a"), "b", { parent_id: "a", depth: 1 });
    const others: OtherProfiles = { byName: { work: { chats: [{ id: "w1", title: "Deploy", at: 5_000, unread: true, source: "app" }] } } };
    expect(brief(rooms([chat("quiet", { subagents: tree }), chat("busy", { running: true })], { others }))).toEqual([
      "work/w1: unread",
      "default/busy: running",
      "default/quiet: idle running running",
    ]);
  });

  it("shows the reply's most pressing state: an Approval over a failure, a failure over a finished reply", () => {
    const waiting = { kind: "approval", id: "ap", requestId: "r1", command: "rm", description: "", choices: ["once", "deny"] } as unknown as Chat["items"][number];
    const failure = { kind: "error", id: "e-1", text: "Boom" } as unknown as Chat["items"][number];
    expect(brief(rooms([chat("c", { running: true, unread: true, items: [failure, waiting] })]))).toEqual(["default/c: approval"]);
    expect(brief(rooms([chat("c", { unread: true, items: [failure] })]))).toEqual(["default/c: failed"]);
  });

  it("drops what already happened once the owner dismisses it in the inbox, but never running work", () => {
    const failure = { kind: "error", id: "e-1", text: "Boom" } as unknown as Chat["items"][number];
    const chats = [chat("done", { unread: true }), chat("broke", { items: [failure] }), chat("busy", { running: true })];
    const keys = new Set(inboxEntries({ profile: "default", chats, connected: true, others: none }).entries.map((e) => e.key));
    expect(brief(rooms(chats, { dismissed: keys }))).toEqual(["default/busy: running"]);
  });

  it("never shows a reply as finished on an unread chat alone, nor counts it as work", () => {
    const stopped = { kind: "assistant", id: "m-1", text: "Half a repl", stopped: true } as unknown as Chat["items"][number];
    const rs = rooms([chat("read-later", { unread: true }), chat("cut-short", { unread: true, items: [stopped], subagents: started(undefined, "a") })]);
    expect(rs.flatMap((r) => r.desks.filter((d) => d.agent.kind === "reply").map((d) => d.state))).toEqual(["unread", "unread"]);
    expect(rs.flatMap((r) => r.desks).some((d) => d.state === "completed")).toBe(false);
    expect(officeTally(rs)).toEqual({ working: 1, waiting: 0, failed: 0, desks: 3 });
  });

  it("marks another profile's desks as last seen once a check can't list the profiles, keeping what the one before read", () => {
    const listed = { chats: [{ id: "w1", title: "Deploy", at: 5_000, unread: true, source: "app" as const }], checkedAt: 4_000 };
    expect(rooms([], { others: { byName: { work: listed } } })[0].desks[0].stale).toBeUndefined();
    const failed = rooms([], { others: { byName: { work: listed }, error: "Couldn't list the profiles: 502" } });
    expect(failed[0].desks[0]).toMatchObject({ state: "unread", stale: "As last seen: Hermes couldn't be checked." });
    const seen = { ...listed, failures: [{ chatId: "w1", title: "Deploy", itemId: "e-1", mark: "x" }] };
    for (const others of [{ byName: { work: seen }, error: "502" }, { byName: { work: { ...seen, error: "502" } } }])
      expect(rooms([], { others })[0].desks[0]).toMatchObject({ state: "failed", stale: "As last seen: Hermes couldn't be checked." });
  });

  it("says why every desk is as last seen while disconnected, and never calls a reply it can't see idle", () => {
    const rs = rooms([chat("c", { subagents: started(undefined, "a") })], { connected: false });
    expect(rs[0].desks.map((d) => [d.state, d.stale])).toEqual([
      ["unknown", "Not connected to Hermes: as last seen."],
      ["running", "Not connected to Hermes: as last seen."],
    ]);
  });

  it("holds every subagent of many chats, each once, and counts them", () => {
    const chats = Array.from({ length: 30 }, (_, n) => {
      let tree: SubagentTree | undefined;
      for (let i = 0; i < SUBAGENTS_MAX; i++) tree = started(tree, `s${i}`, i % 10 ? { parent_id: `s${i - (i % 10)}`, depth: 1 } : {});
      return chat(`c${n}`, { running: true, subagents: tree });
    });
    const rs = rooms(chats);
    expect(rs).toHaveLength(30);
    expect(new Set(rs.flatMap((r) => r.desks.map((d) => d.key))).size).toBe(30 * (SUBAGENTS_MAX + 1));
    expect(officeTally(rs)).toEqual({ working: 30 * (SUBAGENTS_MAX + 1), waiting: 0, failed: 0, desks: 30 * (SUBAGENTS_MAX + 1) });
    const order = rs[0].desks.slice(1).map((d) => (d.agent.kind === "subagent" ? d.agent.id : ""));
    expect(order.slice(0, 11)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
  });
});

describe("The building's layout", () => {
  const ended = (tree: SubagentTree | undefined, id: string, status: string) => onSubagentEvent(tree, "subagent.complete", { subagent_id: id, status }, 3_000);
  /** Each drawn agent as `chat/agent room spot`. */
  const where = (l: FloorLayout) => l.placed.map((p) => `${p.room.chatId}/${p.desk.agent.kind === "subagent" ? p.desk.agent.id : "reply"} ${p.floorRoom}${p.door ? " door" : ""} ${p.spot}`);
  const group = (spot: number) => Math.floor(spot / GROUP_SEATS);

  it("seats a chat that delegates to two subagents at one group of Workroom desks, all in its team color", () => {
    const tree = started(started(undefined, "a"), "b");
    const l = floorLayout(rooms([chat("c", { running: true, subagents: tree })]), "default");
    expect(where(l)).toEqual(["c/reply workroom 0", "c/a workroom 1", "c/b workroom 2"]);
    expect(new Set(l.placed.map((p) => group(p.spot))).size).toBe(1);
    expect(new Set(l.placed.map((p) => p.team)).size).toBe(1);
  });

  it("puts each state in its room: an Approval waits, a failure is in trouble, a stopped one is in the Lounge, a queued one at the door", () => {
    const waiting = { kind: "approval", id: "ap", requestId: "r1", command: "rm", description: "", choices: ["once", "deny"] } as unknown as Chat["items"][number];
    let tree = started(started(started(undefined, "ok"), "boom"), "halt");
    tree = ended(ended(tree, "boom", "failed"), "halt", "interrupted");
    tree = onSubagentEvent(tree, "subagent.spawn_requested", { subagent_id: "next", goal: "Goal next", depth: 0 }, 2_500);
    const l = floorLayout(rooms([chat("c", { running: true, items: [waiting], subagents: tree })]), "default");
    expect(Object.fromEntries(l.placed.map((p) => [p.desk.agent.kind === "subagent" ? p.desk.agent.id : "reply", [p.floorRoom, p.desk.state]]))).toMatchObject({
      reply: ["waiting", "approval"],
      ok: ["workroom", "running"],
      boom: ["trouble", "failed"],
      halt: ["lounge", "stopped"],
      next: ["workroom", "queued"],
    });
    expect(where(l).find((w) => w.startsWith("c/next"))).toBe("c/next workroom door 0");
  });

  it("tells the card a subagent's goal and model, and when it started: Hermes's word, else when the app heard it start", () => {
    const heard = rooms([chat("c", { running: true, subagents: started(undefined, "a", { model: "m-1" }) })])[0].desks[1];
    expect(heard.about).toEqual({ goal: "Goal a", model: "m-1", startedAt: 2_000 });
  });

  it("maps every state to a room", () => {
    expect(Object.keys(ROOM_OF).sort()).toEqual(["approval", "completed", "ended", "failed", "idle", "queued", "running", "stopped", "uncertain", "unknown", "unread"]);
  });

  it("keeps a team's desks and color while it works, when another team starts or stops", () => {
    const one = chat("one", { running: true, subagents: started(started(undefined, "a"), "b") });
    const two = chat("two", { running: true, subagents: started(undefined, "x") });
    const first = floorLayout(rooms([two]), "default");
    const both = floorLayout(rooms([one, two]), "default", first);
    const twoAt = (l: FloorLayout) => l.placed.filter((p) => p.room.chatId === "two").map((p) => [p.spot, p.team]);
    expect(twoAt(both)).toEqual(twoAt(first));
    const groupsOf = (l: FloorLayout, id: string) => new Set(l.placed.filter((p) => p.room.chatId === id).map((p) => group(p.spot)));
    expect([...groupsOf(both, "one")].some((g) => groupsOf(both, "two").has(g))).toBe(false);
    expect(new Set(both.placed.map((p) => `${p.room.chatId} ${p.team}`)).size).toBe(2);
    const oneAt = both.placed.filter((p) => p.room.chatId === "one").map((p) => [p.spot, p.team]);
    const after = floorLayout(rooms([one]), "default", both);
    expect(after.placed.map((p) => [p.spot, p.team])).toEqual(oneAt);
  });

  it("draws the floor of the profile shown and counts the agents of the others", () => {
    const others: OtherProfiles = { byName: { work: { chats: [{ id: "w1", title: "Deploy", at: 5_000, unread: true, source: "app" }] } } };
    const l = floorLayout(rooms([chat("busy", { running: true })], { others }), "default");
    expect(where(l)).toEqual(["busy/reply workroom 0"]);
    expect(l.elsewhere).toBe(1);
  });

  it(`draws at most ${FLOOR_MAX} on a floor, those waiting for the owner first, and counts the rest`, () => {
    const waiting = { kind: "approval", id: "ap", requestId: "r1", command: "rm", description: "", choices: ["once", "deny"] } as unknown as Chat["items"][number];
    const busy = Array.from({ length: 45 }, (_, n) => chat(`c${n}`, { running: true }));
    const l = floorLayout(rooms([...busy, chat("asks", { running: true, items: [waiting] })]), "default");
    expect(l.placed).toHaveLength(FLOOR_MAX);
    expect(l.more).toBe(6);
    expect(l.placed.some((p) => p.room.chatId === "asks" && p.floorRoom === "waiting")).toBe(true);
    expect(new Set(l.placed.filter((p) => p.floorRoom === "workroom").map((p) => p.spot)).size).toBe(FLOOR_MAX - 1);
  });

  it("greys nobody out itself: a stale agent keeps its room, and the drawing marks it as last seen", () => {
    const l = floorLayout(rooms([chat("c", { subagents: started(undefined, "a") })], { connected: false }), "default");
    expect(l.placed.map((p) => [p.floorRoom, !!p.desk.stale])).toEqual([
      ["lounge", true],
      ["workroom", true],
    ]);
  });
});
