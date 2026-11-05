import { describe, expect, it } from "vitest";
import { inboxEntries, type InboxEntry } from "./inbox";
import type { Chat, OtherProfiles } from "./model";
import { officeRooms, officeTally } from "./office";
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
      "work/w1: completed",
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
    // Each subagent follows the one that started it.
    const order = rs[0].desks.slice(1).map((d) => (d.agent.kind === "subagent" ? d.agent.id : ""));
    expect(order.slice(0, 11)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
  });
});
