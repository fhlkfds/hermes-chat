// Which chats are in which project, kept by Hermes so every computer sees the same (ADR 0023, GLOSSARY.md "Project
// membership"). The deployed Hermes (`bf0203a`) has no record of it: `projects.db` has projects and folders only, and
// the official desktop groups chats by working folder. So this is written against the backend contract ADR 0023 lays
// out, and used only when Hermes says it has it: `projects.list` answering with `chat_membership: {version: 1}`. A
// server that doesn't say so is never sent a membership call, and membership stays on this computer (projectLinks.ts).
//
// Every change is an operation: put this chat in this project, or take it out. Each names the pair's revision as this
// computer last read it, and Hermes applies it only if the pair hasn't changed since; otherwise Hermes answers with what
// it has now and the change waits for the owner (a conflict). A change Hermes already agrees with is done. Operations
// carry an id Hermes remembers, so one sent twice (a retry, another window) is applied once.
import type { Project } from "./projects";

/** Hermes's record of one chat in one project. `rev`: the record's revision; 0 when Hermes has none. */
export type PairState = { member: boolean; rev: number };

/** Every record Hermes has, by project id then chat id, taken-out ones included (they carry the revision). */
export type ServerLinks = Record<string, Record<string, PairState>>;

/** One change to membership, waiting for Hermes to confirm it. */
export type MembershipOp = {
  /** Sent as `op_id`; Hermes applies an id once. */
  id: string;
  project: string;
  chat: string;
  /** In the project (true) or out of it. */
  member: boolean;
  /** The pair's revision when the owner made the change: Hermes applies it only over that revision. */
  base: number;
  /** When the owner made it, for showing. */
  at: number;
  /** Hermes changed the pair meanwhile, to this: the change waits for the owner to keep it or drop it. */
  conflict?: PairState;
};

/** What `projects.list` says about membership: undefined when Hermes doesn't keep it. */
export type MembershipSupport = { version: 1; revision: number };

/** How Hermes answered one operation (contract in ADR 0023). */
export type OpResult = {
  id: string;
  status: "applied" | "unchanged" | "conflict" | "no_such_project";
  member: boolean;
  rev: number;
};

/** The membership calls, profile-scoped like the other `projects.*` calls. */
export type MembershipApi = {
  list(profile: string): Promise<{ revision: number; links: ServerLinks }>;
  apply(profile: string, ops: readonly MembershipOp[]): Promise<{ revision: number; results: OpResult[] }>;
};

/** The most operations sent in one call; the contract allows 500. */
export const OPS_PER_CALL = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 400;
const revOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The `chat_membership` field of a `projects.list` answer, if Hermes keeps membership in a version this app speaks. */
export function membershipSupport(listing: unknown): MembershipSupport | undefined {
  const m = isObj(listing) ? listing.chat_membership : undefined;
  if (!isObj(m) || m.version !== 1) return undefined;
  return { version: 1, revision: revOk(m.revision) ? m.revision : 0 };
}

function toLinks(v: unknown): ServerLinks {
  if (!isObj(v) || !Array.isArray(v.links)) throw new Error("Hermes answered without the project memberships.");
  const out: ServerLinks = {};
  for (const l of v.links) {
    if (!isObj(l) || !idOk(l.project_id) || !idOk(l.session_id) || !revOk(l.rev)) continue;
    (out[l.project_id] ??= {})[l.session_id] = { member: l.member === true || l.member === 1, rev: l.rev };
  }
  return out;
}

const STATUSES = new Set(["applied", "unchanged", "conflict", "no_such_project"]);

function toResults(v: unknown): OpResult[] {
  if (!isObj(v) || !Array.isArray(v.results)) throw new Error("Hermes answered without what it did with the changes.");
  return v.results.flatMap((r) =>
    isObj(r) && idOk(r.op_id) && typeof r.status === "string" && STATUSES.has(r.status)
      ? [{ id: r.op_id, status: r.status as OpResult["status"], member: r.member === true || r.member === 1, rev: revOk(r.rev) ? r.rev : 0 }]
      : [],
  );
}

/** The membership calls over a projects JSON-RPC. Only called once `membershipSupport` said Hermes has them. */
export function membershipApi(rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>): MembershipApi {
  return {
    list: async (profile) => {
      const res = await rpc("projects.chats.list", { profile, include_removed: true });
      return { revision: isObj(res) && revOk(res.revision) ? res.revision : 0, links: toLinks(res) };
    },
    apply: async (profile, ops) => {
      const res = await rpc("projects.chats.apply", {
        profile,
        ops: ops.map((o) => ({
          op_id: o.id,
          kind: o.member ? "add" : "remove",
          project_id: o.project,
          session_id: o.chat,
          expected_rev: o.base,
        })),
      });
      return { revision: isObj(res) && revOk(res.revision) ? res.revision : 0, results: toResults(res) };
    },
  };
}

/** A new operation id: random, so no two computers make the same one. */
export function opId(): string {
  return `m_${crypto.randomUUID()}`;
}

const pairOf = (links: ServerLinks, project: string, chat: string): PairState => links[project]?.[chat] ?? { member: false, rev: 0 };

/** Each project's chats as Hermes has them, newest record first. */
export function membersOf(links: ServerLinks): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [project, chats] of Object.entries(links)) {
    const ids = Object.entries(chats)
      .filter(([, s]) => s.member)
      .sort((a, b) => b[1].rev - a[1].rev)
      .map(([c]) => c);
    if (ids.length) out[project] = ids;
  }
  return out;
}

/**
 * What the list shows: Hermes's records with the changes still waiting on top, in the order they were made. A change in
 * conflict shows Hermes's side until the owner decides.
 */
export function overlay(links: ServerLinks, pending: readonly MembershipOp[]): Record<string, string[]> {
  const chats = membersOf(links);
  for (const op of pending) {
    if (op.conflict) continue;
    const ids = (chats[op.project] ?? []).filter((c) => c !== op.chat);
    const next = op.member ? [op.chat, ...ids] : ids;
    if (next.length) chats[op.project] = next;
    else delete chats[op.project];
  }
  return chats;
}

/**
 * The waiting changes after the owner changes one pair. A change waiting for the same pair is replaced, a conflict
 * included: the owner has just decided it. A change that leaves the pair as Hermes has it is no change at all.
 */
export function queueOp(links: ServerLinks, pending: readonly MembershipOp[], change: Omit<MembershipOp, "base">): MembershipOp[] {
  const earlier = pending.find((o) => o.project === change.project && o.chat === change.chat);
  const rest = pending.filter((o) => o !== earlier);
  const now = pairOf(links, change.project, change.chat);
  // Over a conflict, the owner decides against what Hermes said it has, which may be newer than the last read.
  const base = earlier?.conflict && earlier.conflict.rev > now.rev ? earlier.conflict : now;
  if (base.member === change.member) return rest;
  return [...rest, { ...change, base: base.rev }];
}

/**
 * The waiting changes after Hermes was read again: one Hermes already agrees with is done, and a conflict takes what
 * Hermes has now. The rest wait to be sent.
 */
export function settle(links: ServerLinks, pending: readonly MembershipOp[]): MembershipOp[] {
  return pending.flatMap((op) => {
    const now = pairOf(links, op.project, op.chat);
    if (now.member === op.member) return [];
    return op.conflict ? [{ ...op, conflict: now }] : [op];
  });
}

/**
 * Hermes's answers applied: the records it reports now, and the changes still waiting. A change applied or already so
 * is done; one to a project Hermes no longer has is dropped; a conflict waits with Hermes's side. A change Hermes didn't
 * answer about waits as it was.
 */
export function applyResults(
  links: ServerLinks,
  pending: readonly MembershipOp[],
  sent: readonly MembershipOp[],
  results: readonly OpResult[],
): { links: ServerLinks; pending: MembershipOp[] } {
  const byId = new Map(results.map((r) => [r.id, r]));
  const sentById = new Map(sent.map((o) => [o.id, o]));
  const next: ServerLinks = { ...links };
  for (const r of results) {
    const op = sentById.get(r.id);
    if (!op || r.status === "no_such_project") continue;
    next[op.project] = { ...next[op.project], [op.chat]: { member: r.member, rev: r.rev } };
  }
  const left = pending.flatMap((op) => {
    const r = sentById.has(op.id) ? byId.get(op.id) : undefined;
    if (!r) return [op];
    if (r.status === "conflict") return [{ ...op, conflict: { member: r.member, rev: r.rev } }];
    return [];
  });
  return { links: next, pending: left };
}

/** Keep this computer's side of a conflict: sent again over the revision Hermes reported. */
export function keepMine(pending: readonly MembershipOp[], id: string): MembershipOp[] {
  return pending.map((o) => (o.id === id && o.conflict ? { id: opId(), project: o.project, chat: o.chat, member: o.member, at: o.at, base: o.conflict.rev } : o));
}

/** Keep Hermes's side of a conflict: this computer's change is dropped. */
export function keepTheirs(pending: readonly MembershipOp[], id: string): MembershipOp[] {
  return pending.filter((o) => !(o.id === id && o.conflict));
}

/** What copying this computer's membership to Hermes would do, before the owner agrees to it. */
export type MigrationPlan = {
  /** Pairs Hermes has no record of: they will be added. */
  add: { project: string; chat: string }[];
  /** Pairs Hermes already has: nothing to do. */
  already: number;
  /** Pairs Hermes records as taken out, on another computer: left out. */
  takenOut: { project: string; chat: string }[];
  /** Pairs in projects Hermes no longer has, or has archived: left out. */
  skipped: number;
  /** Projects with something to add, by id, with how many. */
  byProject: Record<string, number>;
};

/**
 * The plan for copying `local` (this computer's membership) to Hermes, given Hermes's records and projects. Hermes keeps
 * one record per pair, so nothing is added twice: a pair Hermes has, in or out, is left as it is. Running it again after
 * it is done adds nothing.
 */
export function migrationPlan(local: Readonly<Record<string, readonly string[]>>, links: ServerLinks, projects: readonly Project[]): MigrationPlan {
  const live = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
  const plan: MigrationPlan = { add: [], already: 0, takenOut: [], skipped: 0, byProject: {} };
  for (const [project, chats] of Object.entries(local)) {
    for (const chat of new Set(chats)) {
      if (!live.has(project)) plan.skipped++;
      else {
        const rec = links[project]?.[chat];
        if (!rec) {
          plan.add.push({ project, chat });
          plan.byProject[project] = (plan.byProject[project] ?? 0) + 1;
        } else if (rec.member) plan.already++;
        else plan.takenOut.push({ project, chat });
      }
    }
  }
  return plan;
}

/** The operations that carry out `plan`, or put back `pairs` from the recovery copy. */
export function addOps(links: ServerLinks, pairs: readonly { project: string; chat: string }[], at: number): MembershipOp[] {
  return pairs.map(({ project, chat }) => ({ id: opId(), project, chat, member: true, base: pairOf(links, project, chat).rev, at }));
}

/** The pairs in the recovery copy that Hermes doesn't have in, for projects it still has. */
export function recoveryPairs(recovery: Readonly<Record<string, readonly string[]>>, links: ServerLinks, projects: readonly Project[]) {
  const live = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
  return Object.entries(recovery).flatMap(([project, chats]) =>
    live.has(project) ? [...new Set(chats)].filter((chat) => !links[project]?.[chat]?.member).map((chat) => ({ project, chat })) : [],
  );
}

/** `ops` in calls of at most `size`. */
export function batches<T>(ops: readonly T[], size = OPS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}
