// The agent office (ADR 0077, ADR 0089): the agents at work on this connection, one room per chat. Worked out from what
// the app already has, and nothing else: a chat's own reply from the inbox's entries for it (inbox.ts), and its
// subagents from its subagent tree (subagents.ts). The office reads nothing of its own, keeps nothing, and never answers,
// approves, retries or starts anything.
import type { InboxEntry, InboxKind } from "./inbox";
import type { Chat } from "./model";
import { childrenOf, type Subagent, type SubagentId, type SubagentState, type SubagentTree } from "./subagents";

/**
 * What a desk's agent is doing. `approval`: the chat's reply waits for the owner's answer. `uncertain`: a message the
 * owner sent may not have reached Hermes. `completed`: Hermes said the subagent finished, never guessed. `unread`: the
 * chat has something the owner hasn't read, which alone doesn't say its reply finished. `idle`: the chat's reply
 * isn't running, and nothing about it needs the owner, but its subagents are known. `unknown`: a subagent known only as
 * the parent of another, or a reply while the app isn't connected and nothing else says how it is.
 */
export type DeskState = "queued" | "running" | "approval" | "failed" | "uncertain" | "completed" | "unread" | "stopped" | "ended" | "unknown" | "idle";

export type Desk = {
  key: string;
  /** The chat's own reply, with the inbox entry its state comes from, or one of the chat's subagents. */
  agent: { kind: "reply"; entry?: InboxEntry } | { kind: "subagent"; id: SubagentId; depth: number; parent?: SubagentId };
  name: string;
  state: DeskState;
  /** What it last did, if known, and when; `at` 0 when that isn't known. */
  doing?: { text: string; at: number };
  /** Why its state may not be current: shown as last heard. None when it is current. */
  stale?: string;
  /** What its card says about it, when the app knows: a subagent's goal, the model, when it started or how long it ran. */
  about?: { goal?: string; model?: string; startedAt?: number; durationS?: number };
};

export type Room = { key: string; profile: string; chatId: string; title: string; desks: Desk[] };

const SUBAGENT_STATE: Record<SubagentState, DeskState> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  error: "failed",
  timeout: "failed",
  interrupted: "stopped",
  ended: "ended",
  unknown: "unknown",
};

/** Which inbox entry a chat's reply desk shows when there are several: what needs the owner first. */
const REPLY_ORDER: readonly InboxKind[] = ["approval", "running", "failed", "uncertain", "completed"];
// The inbox's "completed" is a chat with something unread: no event confirms that a reply finished.
const REPLY_STATE: Record<InboxKind, DeskState> = { approval: "approval", running: "running", failed: "failed", uncertain: "uncertain", completed: "unread" };

/** Live work is shown whatever the owner dismissed; what already happened goes once they dismiss it in the inbox. */
const isLive = (e: InboxEntry) => e.kind === "running" || (e.kind === "approval" && !e.ended);

const NOT_CONNECTED = "Not connected to Hermes: as last seen.";

function treeStale(tree: SubagentTree, connected: boolean): string | undefined {
  if (tree.sync.kind === "lost") return `Disconnected since ${new Date(tree.sync.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: as last heard.`;
  if (tree.sync.kind === "unchecked") return `As last heard. ${tree.sync.why}`;
  return connected ? undefined : NOT_CONNECTED;
}

function subagentDesks(tree: SubagentTree, chatKey: string, stale: string | undefined): Desk[] {
  const out: Desk[] = [];
  const walk = (parent?: SubagentId) => {
    for (const s of childrenOf(tree, parent)) {
      out.push(subagentDesk(s, chatKey, stale));
      walk(s.id);
    }
  };
  walk();
  return out;
}

function subagentDesk(s: Subagent, chatKey: string, stale: string | undefined): Desk {
  return {
    key: `${chatKey} ${s.id}`,
    agent: { kind: "subagent", id: s.id, depth: s.depth, ...(s.parent && { parent: s.parent }) },
    name: s.goal || "A subagent Hermes hasn't described yet",
    state: SUBAGENT_STATE[s.state],
    ...(s.lastActivity && { doing: { text: s.lastActivity.text, at: s.lastActivity.at } }),
    ...(stale && { stale }),
    about: {
      ...(s.goal && { goal: s.goal }),
      ...(s.model && { model: s.model }),
      ...((s.startedAt ?? s.startHeardAt) && { startedAt: s.startedAt ?? s.startHeardAt }),
      ...(s.durationS !== undefined && { durationS: s.durationS }),
    },
  };
}

/**
 * The office's rooms: one for each chat the inbox lists, in the inbox's order, then each chat of the shown profile
 * whose subagents this connection has heard of. `entries`: all the inbox's entries; `shown`: whether the owner left an
 * entry in the inbox (not dismissed). A room's first desk is the chat's own reply; its subagents follow, each after
 * the one that started it.
 */
export function officeRooms({
  entries,
  shown,
  chats,
  profile,
  connected,
}: {
  entries: readonly InboxEntry[];
  shown: (e: InboxEntry) => boolean;
  chats: readonly Chat[];
  profile: string;
  connected: boolean;
}): Room[] {
  const rooms = new Map<string, { profile: string; chatId: string; title: string; entries: InboxEntry[] }>();
  const room = (p: string, chatId: string, title: string) => {
    const key = `${p} ${chatId}`;
    if (!rooms.has(key)) rooms.set(key, { profile: p, chatId, title, entries: [] });
    return rooms.get(key)!;
  };
  for (const e of entries) if (isLive(e) || (!e.ended && shown(e))) room(e.profile, e.chatId, e.title).entries.push(e);
  for (const c of chats) if (c.subagents?.subagents.length) room(profile, c.id, c.title);

  return [...rooms.entries()].map(([key, r]) => {
    const entry = REPLY_ORDER.map((k) => r.entries.find((e) => e.kind === k)).find((e) => !!e);
    const stale = !connected ? NOT_CONNECTED : entry?.stale ? "As last seen: Hermes couldn't be checked." : undefined;
    const chat = r.profile === profile ? chats.find((c) => c.id === r.chatId) : undefined;
    const reply: Desk = {
      key: `${key} reply`,
      agent: { kind: "reply", ...(entry && { entry }) },
      name: "The chat's reply",
      // A drop ends the app's word on whether the reply runs; it's resumed and known again once connected.
      state: entry ? REPLY_STATE[entry.kind] : connected ? "idle" : "unknown",
      ...(entry && { doing: { text: entry.summary, at: entry.at || entry.noticedAt || 0 } }),
      ...(stale && { stale }),
      ...(chat?.model && { about: { model: chat.model.model } }),
    };
    const tree = chat?.subagents;
    return {
      key,
      profile: r.profile,
      chatId: r.chatId,
      title: r.title,
      desks: [reply, ...(tree ? subagentDesks(tree, key, treeStale(tree, connected)) : [])],
    };
  });
}

/** How many desks are at work, wait for the owner, or failed, for the office's heading. */
export function officeTally(rooms: readonly Room[]): { working: number; waiting: number; failed: number; desks: number } {
  let working = 0;
  let waiting = 0;
  let failed = 0;
  let desks = 0;
  for (const r of rooms)
    for (const d of r.desks) {
      desks++;
      if (d.state === "running" || d.state === "queued") working++;
      else if (d.state === "approval") waiting++;
      else if (d.state === "failed") failed++;
    }
  return { working, waiting, failed, desks };
}

// The building (ADR 0089): which room of the floor each agent is in, where in it, and its team's color. Pure, so it is
// tested without WebGL; the three.js layer (officeEngine.ts) only draws what this says.

/** The four rooms every floor has. */
export type FloorRoom = "workroom" | "waiting" | "trouble" | "lounge";

/** Which room each state puts an agent in. A new `DeskState` needs a line here, and the type checker asks for it. */
export const ROOM_OF: Record<DeskState, FloorRoom> = {
  running: "workroom",
  queued: "workroom",
  approval: "waiting",
  uncertain: "waiting",
  failed: "trouble",
  completed: "lounge",
  unread: "lounge",
  stopped: "lounge",
  ended: "lounge",
  idle: "lounge",
  unknown: "lounge",
};

export const FLOOR_ROOM_NAME: Record<FloorRoom, string> = { workroom: "Workroom", waiting: "Waiting room", trouble: "Trouble room", lounge: "Lounge" };

/** The Workroom's desks: groups of `GROUP_SEATS` side by side, a team to a group. */
export const WORK_GROUPS = 16;
export const GROUP_SEATS = 3;
/** The most characters drawn on one floor; the rest are counted on a "+N more" sign. */
export const FLOOR_MAX = 40;
/** How many team colors there are; a team's color is an index into the building's palette. */
export const TEAM_COLORS = 8;

/**
 * Where one agent is. `spot`: in the Workroom, its desk (group × GROUP_SEATS + seat); queued, its place in the line at
 * the Workroom's door (`door`); elsewhere, its place among the room's agents in reading order.
 */
export type Placement = { desk: Desk; room: Room; floorRoom: FloorRoom; spot: number; door?: true; team: number };

/**
 * A floor's layout. `seats` and `teams` are what the next layout keeps: each working agent's desk, and each team's
 * color, so nobody changes seats or colors when another team starts or stops. `more`: agents on the floor not drawn,
 * past FLOOR_MAX. `elsewhere`: agents in the other profiles, which this stage doesn't draw.
 */
export type FloorLayout = {
  placed: Placement[];
  counts: Record<FloorRoom, number>;
  more: number;
  elsewhere: number;
  seats: ReadonlyMap<string, number>;
  teams: ReadonlyMap<string, number>;
};

/** Who is drawn first when a floor has more than FLOOR_MAX: who needs the owner, then who works, then the rest. */
const DRAW_ORDER: Record<FloorRoom, number> = { waiting: 0, trouble: 1, workroom: 2, lounge: 3 };

/**
 * The floor of `profile`: its rooms' agents placed in the building. `before`: the last layout, whose seats and team
 * colors carry over.
 */
export function floorLayout(rooms: readonly Room[], profile: string, before?: Pick<FloorLayout, "seats" | "teams">): FloorLayout {
  const here = rooms.filter((r) => r.profile === profile);
  const elsewhere = rooms.filter((r) => r.profile !== profile).reduce((n, r) => n + r.desks.length, 0);

  // Team colors: a team keeps its color; a new one gets the color fewest teams on the floor wear, the lowest first.
  const teams = new Map<string, number>();
  const worn = new Array<number>(TEAM_COLORS).fill(0);
  for (const r of here) {
    const was = before?.teams.get(r.key);
    if (was !== undefined) {
      teams.set(r.key, was);
      worn[was]++;
    }
  }
  for (const r of here) {
    if (teams.has(r.key)) continue;
    const pick = worn.indexOf(Math.min(...worn));
    teams.set(r.key, pick);
    worn[pick]++;
  }

  let all = here.flatMap((room) => room.desks.map((desk) => ({ room, desk, floorRoom: ROOM_OF[desk.state] })));
  const more = Math.max(0, all.length - FLOOR_MAX);
  if (more) all = all.map((a, i) => ({ a, i })).sort((x, y) => DRAW_ORDER[x.a.floorRoom] - DRAW_ORDER[y.a.floorRoom] || x.i - y.i).slice(0, FLOOR_MAX).sort((x, y) => x.i - y.i).map(({ a }) => a);

  // The Workroom: a team keeps the groups of desks it sits at while any of it works there. Agents keep their desks;
  // a newcomer sits in its team's groups, else takes a free group, else any free desk.
  const working = all.filter((a) => a.floorRoom === "workroom" && a.desk.state !== "queued");
  const taken = new Set<number>();
  const groupOf = (seat: number) => Math.floor(seat / GROUP_SEATS);
  const held = new Map<string, Set<number>>();
  const hold = (team: string, seat: number) => {
    if (!held.has(team)) held.set(team, new Set());
    held.get(team)!.add(groupOf(seat));
  };
  const placedSeat = new Map<string, number>();
  for (const a of working) {
    const was = before?.seats.get(a.desk.key);
    if (was === undefined || was >= WORK_GROUPS * GROUP_SEATS || taken.has(was)) continue;
    taken.add(was);
    placedSeat.set(a.desk.key, was);
    hold(a.room.key, was);
  }
  const groupsHeld = () => new Set([...held.values()].flatMap((g) => [...g]));
  const freeIn = (group: number) => Array.from({ length: GROUP_SEATS }, (_, i) => group * GROUP_SEATS + i).find((s) => !taken.has(s));
  for (const a of working) {
    if (placedSeat.has(a.desk.key)) continue;
    const mine = [...(held.get(a.room.key) ?? [])].sort((x, y) => x - y);
    let seat = mine.map(freeIn).find((s) => s !== undefined);
    if (seat === undefined) {
      const busy = groupsHeld();
      const free = Array.from({ length: WORK_GROUPS }, (_, g) => g).filter((g) => !busy.has(g));
      // Next to the team's own groups when it can, so a growing team stays together.
      const near = mine.length ? free.sort((x, y) => Math.min(...mine.map((m) => Math.abs(m - x))) - Math.min(...mine.map((m) => Math.abs(m - y))) || x - y) : free;
      if (near.length) seat = near[0] * GROUP_SEATS;
    }
    if (seat === undefined) seat = Array.from({ length: WORK_GROUPS * GROUP_SEATS }, (_, s) => s).find((s) => !taken.has(s));
    if (seat === undefined) continue;
    taken.add(seat);
    placedSeat.set(a.desk.key, seat);
    hold(a.room.key, seat);
  }

  const counts: Record<FloorRoom, number> = { workroom: 0, waiting: 0, trouble: 0, lounge: 0 };
  let line = 0;
  const placed: Placement[] = all.map(({ room, desk, floorRoom }) => {
    const team = teams.get(room.key)!;
    counts[floorRoom]++;
    if (floorRoom === "workroom") {
      if (desk.state === "queued") return { desk, room, floorRoom, spot: line++, door: true, team };
      return { desk, room, floorRoom, spot: placedSeat.get(desk.key)!, team };
    }
    return { desk, room, floorRoom, spot: counts[floorRoom] - 1, team };
  });
  return { placed, counts, more, elsewhere, seats: placedSeat, teams };
}
