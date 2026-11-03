// What this computer keeps about projects (ADR 0007): which chats are in each project, which project the chat list
// shows, and the projects as Hermes listed them last, so the list can show them before Hermes is read. Hermes keeps
// the projects themselves; it has no record of which chats belong to one.
//
// All of it lives in one versioned JSON document under one localStorage key, kept apart for each connection and
// profile, the way drafts are. "Clear local cache" doesn't touch it (chatCache.ts clears only chat lists and Saved
// copies): which chats are in a project is the owner's own grouping, not a copy of anything on the server.
import type { SavedSignIn } from "./account";
import { overlay, type MembershipOp, type ServerLinks } from "./membership";
import { toProject, type Project } from "./projects";
import { migrateUIPrefs as migrateDoc, type UIPrefsDoc, type UIPrefsMigrations } from "./uiPrefs";

export const PROJECTS_KEY = "hermes-chat.projects";
/** The shape the document has now. Bump it, and add a step to PROJECTS_MIGRATIONS, when a field changes meaning. */
export const PROJECTS_VERSION = 1;

export const PROJECTS_MIGRATIONS: UIPrefsMigrations = {
  // Version 0 is a document written without `v`; nothing ever wrote one, so it is read as version 1.
  0: (doc) => doc,
};

/** The most connections and profiles kept, and the most chats kept in one project; a hand-edited document can't grow without end. */
const SCOPE_LIMIT = 200;
const CHATS_PER_PROJECT = 10_000;

/**
 * Once this computer's membership was copied to Hermes (membership.ts, ADR 0023): Hermes's records as last read, the
 * changes not yet confirmed by Hermes, and when the copy was made. `chats` then holds what the list shows, Hermes's
 * records with the waiting changes on top, so it can show them before Hermes is read.
 */
export type SyncedLinks = { at: number; links: ServerLinks; pending: MembershipOp[] };

/** This computer's membership as it was just before it was copied to Hermes, kept to put chats back from. */
export type RecoveryCopy = { at: number; chats: Record<string, string[]> };

/** One connection and profile's part of the document. */
export type ScopeLinks = {
  selected?: string;
  chats: Record<string, string[]>;
  known: Project[];
  synced?: SyncedLinks;
  recovery?: RecoveryCopy;
};

/** The storage the document is kept in: localStorage in the app. */
export type LinksStorage = Pick<Storage, "getItem" | "setItem">;

/** Where a connection and profile's projects are kept: the same parts as a draft's key (drafts.ts). */
export function projectScope(connection: SavedSignIn, profile: string): string {
  const target = connection.mode === "ssh" ? connection.sshTarget : connection.url;
  return JSON.stringify([connection.mode, target, connection.username, profile]);
}

export type ProjectLinks = {
  read(scope: string): Readonly<ScopeLinks>;
  /** `id` undefined: the list shows every chat. */
  select(scope: string, id: string | undefined): void;
  setChat(scope: string, projectId: string, chatId: string, inProject: boolean): void;
  forgetChat(scope: string, chatId: string): void;
  forgetProject(scope: string, projectId: string): void;
  /** Hermes's projects as just read. Links to a project it no longer has go; archived ones are kept. */
  remember(scope: string, projects: Project[]): void;
  /**
   * Changes the copy of Hermes's membership records and the changes waiting for it; `chats` follows. `recovery`, when
   * given, is kept as this computer's copy from before (only ever set, never cleared).
   */
  setSynced(scope: string, fn: (synced: SyncedLinks | undefined) => SyncedLinks, recovery?: RecoveryCopy): void;
};

const isDoc = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, max = 400) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const EMPTY: Readonly<ScopeLinks> = Object.freeze({ chats: Object.freeze({}) as Record<string, string[]>, known: [] });

// The cache holds our normalized Project shape, rather than Hermes's is_primary wire field.
function storedProject(v: unknown): Project | undefined {
  const project = toProject(v);
  if (!project || !isDoc(v)) return project;
  return { ...project, folders: Array.isArray(v.folders) ? v.folders.flatMap((f) =>
    isDoc(f) && typeof f.path === "string" && f.path
      ? [{ path: f.path, primary: f.primary === true }]
      : [],
  ) : [] };
}

function toChats(v: unknown): Record<string, string[]> {
  if (!isDoc(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [project, chats] of Object.entries(v)) {
    if (!id(project) || !Array.isArray(chats)) continue;
    const ids = [...new Set(chats.filter((c): c is string => id(c) !== undefined))].slice(0, CHATS_PER_PROJECT);
    if (ids.length) out[project] = ids;
  }
  return out;
}

const rev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** The most of Hermes's records kept, and the most waiting changes: a hand-edited document can't grow without end. */
const RECORDS_LIMIT = 100_000;
const PENDING_LIMIT = 20_000;

function toServerLinks(v: unknown): ServerLinks {
  const out: ServerLinks = {};
  if (!isDoc(v)) return out;
  let n = 0;
  for (const [project, chats] of Object.entries(v)) {
    if (!id(project) || !isDoc(chats)) continue;
    for (const [chat, s] of Object.entries(chats)) {
      if (!id(chat) || !isDoc(s) || !rev(s.rev) || typeof s.member !== "boolean" || ++n > RECORDS_LIMIT) continue;
      (out[project] ??= {})[chat] = { member: s.member, rev: s.rev };
    }
  }
  return out;
}

function toOp(v: unknown): MembershipOp | undefined {
  if (!isDoc(v)) return undefined;
  const opId = id(v.id), project = id(v.project), chat = id(v.chat);
  if (!opId || !project || !chat || typeof v.member !== "boolean" || !rev(v.base)) return undefined;
  const c = v.conflict;
  const conflict = isDoc(c) && typeof c.member === "boolean" && rev(c.rev) ? { member: c.member, rev: c.rev } : undefined;
  return { id: opId, project, chat, member: v.member, base: v.base, at: typeof v.at === "number" ? v.at : 0, ...(conflict && { conflict }) };
}

function toSynced(v: unknown): SyncedLinks | undefined {
  if (!isDoc(v)) return undefined;
  const pending = Array.isArray(v.pending) ? v.pending.slice(0, PENDING_LIMIT).map(toOp).filter((o): o is MembershipOp => !!o) : [];
  return { at: typeof v.at === "number" ? v.at : 0, links: toServerLinks(v.links), pending };
}

function toRecovery(v: unknown): RecoveryCopy | undefined {
  if (!isDoc(v)) return undefined;
  return { at: typeof v.at === "number" ? v.at : 0, chats: toChats(v.chats) };
}

/** One scope's links as stored; anything that isn't valid is left out. */
export function toScope(v: unknown): ScopeLinks | undefined {
  if (!isDoc(v)) return undefined;
  const known = Array.isArray(v.known) ? v.known.map(storedProject).filter((p): p is Project => !!p) : [];
  const selected = id(v.selected);
  const synced = toSynced(v.synced);
  const recovery = toRecovery(v.recovery);
  return {
    ...(selected && { selected }),
    // Once synced, what the list shows follows from Hermes's records and the waiting changes, whatever `chats` says.
    chats: synced ? overlay(synced.links, synced.pending) : toChats(v.chats),
    known,
    ...(synced && { synced }),
    ...(recovery && { recovery }),
  };
}

/** Every scope a document holds, checked; a document from a newer app is read for the fields this one knows. */
export function readLinks(raw: unknown): Record<string, ScopeLinks> {
  const doc: UIPrefsDoc = migrateDoc(raw, PROJECTS_MIGRATIONS, PROJECTS_VERSION);
  const scopes = isDoc(doc.scopes) ? doc.scopes : {};
  const out: Record<string, ScopeLinks> = {};
  for (const [scope, v] of Object.entries(scopes).slice(0, SCOPE_LIMIT)) {
    const s = id(scope, 2000) && toScope(v);
    if (s) out[scope] = s;
  }
  return out;
}

const isEmpty = (s: ScopeLinks) => !s.selected && !Object.keys(s.chats).length && !s.known.length && !s.synced && !s.recovery;

/** `synced` with only the projects `keep` passes: a project Hermes no longer has takes its records and changes with it. */
function onlyProjects(synced: SyncedLinks, keep: (project: string) => boolean): SyncedLinks {
  return {
    ...synced,
    links: Object.fromEntries(Object.entries(synced.links).filter(([p]) => keep(p))),
    pending: synced.pending.filter((o) => keep(o.project)),
  };
}

/** The scope's `chats` and `synced` together: once synced, `chats` is what Hermes's records and the changes make. */
function withSynced(chats: Record<string, string[]>, synced: SyncedLinks | undefined): Pick<ScopeLinks, "chats" | "synced"> {
  return synced ? { chats: overlay(synced.links, synced.pending), synced } : { chats };
}

/**
 * The links kept in `storage`. They're read again only when the stored document changes, so a change that couldn't be
 * stored (the storage is full) is held in memory until the app closes or another window writes.
 */
export function projectLinks(storage: LinksStorage): ProjectLinks {
  let cachedRaw: string | null | undefined;
  let doc: UIPrefsDoc = { v: PROJECTS_VERSION };
  let scopes: Record<string, ScopeLinks> = {};

  const current = () => {
    let raw: string | null = null;
    try {
      raw = storage.getItem(PROJECTS_KEY);
    } catch {
      return scopes;
    }
    if (raw === cachedRaw) return scopes;
    cachedRaw = raw;
    let parsed: unknown;
    try {
      parsed = raw === null ? undefined : JSON.parse(raw);
    } catch {
      // Unreadable: start empty.
    }
    doc = migrateDoc(parsed, PROJECTS_MIGRATIONS, PROJECTS_VERSION);
    scopes = readLinks(parsed);
    return scopes;
  };

  const change = (scope: string, fn: (s: ScopeLinks) => ScopeLinks) => {
    const before = current()[scope] ?? EMPTY;
    const after = fn({ ...before, chats: { ...before.chats } });
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    scopes = { ...scopes };
    if (isEmpty(after)) delete scopes[scope];
    else scopes[scope] = after;
    // Update this scope's known fields only. Preserve newer fields here and leave other scopes untouched,
    // including scopes this version couldn't parse. Explicitly drop selected when the owner picks All chats.
    const storedScopes = isDoc(doc.scopes) ? { ...doc.scopes } : {};
    const prior = isDoc(storedScopes[scope]) ? storedScopes[scope] : {};
    const { selected: _selected, chats: _chats, known: _known, synced: _synced, recovery: _recovery, ...extra } = prior;
    if (isEmpty(after) && !Object.keys(extra).length) delete storedScopes[scope];
    else storedScopes[scope] = { ...extra, ...after };
    doc = { ...doc, v: Math.max(PROJECTS_VERSION, Number(doc.v) || 0), scopes: storedScopes };
    const raw = JSON.stringify(doc);
    try {
      storage.setItem(PROJECTS_KEY, raw);
      cachedRaw = raw;
    } catch {
      // Not kept: memory holds the change while the stored document is still the one last read.
    }
  };

  const withoutChat = (chats: Record<string, string[]>, chatId: string) =>
    Object.fromEntries(Object.entries(chats).flatMap(([p, ids]) => {
      const left = ids.filter((c) => c !== chatId);
      return left.length ? [[p, left]] : [];
    }));

  return {
    read: (scope) => current()[scope] ?? EMPTY,
    select: (scope, projectId) =>
      change(scope, ({ selected: _, ...s }) => (projectId ? { ...s, selected: projectId } : s)),
    // Once synced, membership changes only through Hermes's records and the waiting changes (`setSynced`).
    setChat: (scope, projectId, chatId, inProject) =>
      change(scope, (s) => {
        if (s.synced) return s;
        const ids = (s.chats[projectId] ?? []).filter((c) => c !== chatId);
        const next = inProject ? [chatId, ...ids].slice(0, CHATS_PER_PROJECT) : ids;
        const chats = { ...s.chats, [projectId]: next };
        if (!next.length) delete chats[projectId];
        return { ...s, chats };
      }),
    forgetChat: (scope, chatId) => change(scope, (s) => (s.synced ? s : { ...s, chats: withoutChat(s.chats, chatId) })),
    forgetProject: (scope, projectId) =>
      change(scope, ({ selected, ...s }) => {
        const { [projectId]: _, ...chats } = s.chats;
        const synced = s.synced && onlyProjects(s.synced, (p) => p !== projectId);
        return { ...s, ...(selected && selected !== projectId && { selected }), ...withSynced(chats, synced), known: s.known.filter((p) => p.id !== projectId) };
      }),
    remember: (scope, projects) =>
      change(scope, ({ selected, ...s }) => {
        const ids = new Set(projects.map((p) => p.id));
        const chats = Object.fromEntries(Object.entries(s.chats).filter(([p]) => ids.has(p)));
        const synced = s.synced && onlyProjects(s.synced, (p) => ids.has(p));
        return { ...s, ...(selected && ids.has(selected) && { selected }), ...withSynced(chats, synced), known: projects };
      }),
    setSynced: (scope, fn, recovery) =>
      change(scope, (s) => {
        const synced = fn(s.synced);
        return { ...s, ...withSynced(s.chats, synced), ...((s.recovery ?? recovery) && { recovery: s.recovery ?? recovery }) };
      }),
  };
}
