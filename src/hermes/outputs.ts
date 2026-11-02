// Outputs: the files Hermes's tools reported writing, found in the chats' stored tool results (GLOSSARY.md "Output",
// ADR 0013). Only a tool that says, in its own structured result, which file it wrote counts: `write_file`, `patch`
// (files it created), `text_to_speech` and `image_generate`. A path that a reply, a terminal command or any other tool
// merely mentions is never an Output.
//
// The stored rows come from dashboard REST `GET /api/sessions/{id}/messages`, the newest first, a bounded number of
// rows per chat and chats per run. Whether a file is still there is read with `GET /api/fs/list` on its folder, the same
// route family the preview pane reads files through, for the profile shown, so it is the machine the tools ran on. The
// index is metadata only (paths, sizes the tool reported, which message made each file), kept on this computer per
// connection and profile; no file's contents are copied.

/** A stored row of `GET /api/sessions/{id}/messages` (`SELECT *` from `messages`), as far as Outputs reads it. */
export type StoredRow = {
  id?: number;
  role?: string;
  content?: unknown;
  tool_name?: string | null;
  tool_call_id?: string | null;
  /** The assistant row's tool calls: JSON text as stored, or already parsed. */
  tool_calls?: unknown;
  timestamp?: number | null;
};

/**
 * How a file came to be an Output. `written`: `write_file` wrote it whole. `created`: `patch` created it. `speech`:
 * `text_to_speech` made it. `image`: `image_generate` saved it. `added`: the owner added it here by its path.
 */
export type OutputHow = "written" | "created" | "speech" | "image" | "added";

/**
 * Whether the file was at its path when last checked. `missing`: its folder doesn't list it, or the folder is gone:
 * deleted, moved or renamed, or hidden by Hermes. `forbidden`: the server's user may not open its folder. `folder`:
 * the path is a folder now. `unknown`: the check failed; `why` says how.
 */
export type Availability = { state: "available" | "missing" | "forbidden" | "folder" | "unknown"; checkedAt: number; why?: string };

/**
 * One Output: one file, as one tool call (or the owner) produced it. The same path written by two calls is two
 * Outputs, two versions of the file. `key` is the same however often the chat is indexed: chat, call (or stored row)
 * and path. `callId`: the tool call, to go to it in the chat. `rowId`: the stored row of the tool's result. `at`: when
 * Hermes stored it (Unix ms). `size`: bytes, as the tool reported writing them.
 */
export type Output = {
  key: string;
  chatId?: string;
  path: string;
  how: OutputHow;
  tool?: string;
  callId?: string;
  rowId?: number;
  at?: number;
  size?: number;
  availability?: Availability;
};

/**
 * One chat's Outputs as last indexed. `updatedAt`: the chat's last activity then, so an unchanged chat isn't read
 * again. `partial`: why the index may miss Outputs in it: older rows weren't read, a row was too big to read, or a
 * file tool's result didn't say which file it wrote (older Hermes versions, or a result Hermes cut short).
 */
export type ChatOutputs = { updatedAt: number; indexedAt: number; outputs: Output[]; partial?: IndexGaps };
export type IndexGaps = { olderRows?: boolean; bigRows?: number; unlabelled?: number };

/** The tools whose results name the files they wrote, and how. */
const PRODUCERS = new Set(["write_file", "patch", "text_to_speech", "image_generate"]);

/** Most stored rows read for one chat, newest first; most chats indexed in one run; rows per page. */
export const MAX_ROWS_PER_CHAT = 2000;
export const MAX_CHATS_PER_RUN = 25;
const PAGE_ROWS = 100;
/** The most one page's answer may be. Tool results such as `read_file` can be large; a bigger page is read in smaller ones. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Most folders listed in one availability check. */
export const MAX_FOLDERS_PER_CHECK = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A path a tool on the server wrote: absolute, or under its home. Anything else is ambiguous and isn't listed. */
export const isOutputPath = (p: unknown): p is string => typeof p === "string" && /^(\/|~\/)./.test(p) && !p.includes("\0") && p.length <= 4096;
const storedMs = (s: unknown) => (typeof s === "number" && s > 0 && s * 1000 <= 8.64e15 ? Math.round(s * 1000) : undefined);

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** The arguments of every tool call the assistant rows made, by call id. */
function callArgs(rows: StoredRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.role !== "assistant" || !r.tool_calls) continue;
    const calls = parseJson(r.tool_calls);
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!isObj(c) || !str(c.id) || !isObj(c.function)) continue;
      const args = parseJson(c.function.arguments);
      if (isObj(args)) out.set(c.id as string, args);
    }
  }
  return out;
}

/**
 * The files one producer tool's stored result says it wrote, or `undefined` when it is a producer's result that
 * doesn't say (an older Hermes, or a result cut short), so the chat's index is marked partial. A failed call made
 * nothing. `args`: the call's arguments, for an older `write_file` result that has no `resolved_path`.
 */
export function producedBy(tool: string, content: unknown, args?: Record<string, unknown>): { path: string; how: OutputHow; size?: number }[] | undefined {
  const r = parseJson(content);
  if (!isObj(r)) return undefined;
  if (r.error || r.success === false) return [];
  switch (tool) {
    case "write_file": {
      const listed = Array.isArray(r.files_modified) ? r.files_modified.find(isOutputPath) : undefined;
      const path = [r.resolved_path, listed, args?.path].find(isOutputPath);
      if (!path) return typeof r.bytes_written === "number" ? undefined : [];
      const size = typeof r.bytes_written === "number" && r.bytes_written >= 0 ? r.bytes_written : undefined;
      return [{ path, how: "written", ...(size !== undefined && { size }) }];
    }
    case "patch":
      if (!Array.isArray(r.files_created)) return r.success === true ? [] : undefined;
      return r.files_created.filter(isOutputPath).map((path) => ({ path, how: "created" as const }));
    case "text_to_speech": {
      const paths = Array.isArray(r.file_paths) ? r.file_paths : [r.file_path];
      const found = paths.filter(isOutputPath);
      return found.length ? found.map((path) => ({ path, how: "speech" as const })) : undefined;
    }
    case "image_generate": {
      // `image` is the file Hermes saved, or the provider's URL when it saved none: a web address isn't a Server file.
      const path = [r.host_image, r.image].find(isOutputPath);
      if (path) return [{ path, how: "image" }];
      return typeof r.image === "string" && /^https?:/i.test(r.image) ? [] : undefined;
    }
  }
  return [];
}

/** The Outputs in a chat's stored rows (any order), and how many file tools' results didn't say what they wrote. */
export function outputsFromRows(chatId: string, rows: StoredRow[]): { outputs: Output[]; unlabelled: number } {
  const args = callArgs(rows);
  const found = new Map<string, Output>();
  let unlabelled = 0;
  for (const r of rows) {
    const tool = r.role === "tool" ? (r.tool_name ?? "") : "";
    if (!PRODUCERS.has(tool)) continue;
    const callId = str(r.tool_call_id);
    const made = producedBy(tool, r.content, callId ? args.get(callId) : undefined);
    if (!made) {
      unlabelled++;
      continue;
    }
    const rowId = typeof r.id === "number" ? r.id : undefined;
    const at = storedMs(r.timestamp);
    for (const m of made) {
      const key = outputKey(chatId, callId ?? (rowId !== undefined ? `row:${rowId}` : ""), m.path);
      if (found.has(key) || (!callId && rowId === undefined)) continue;
      found.set(key, { key, chatId, path: m.path, how: m.how, tool, ...(callId && { callId }), ...(rowId !== undefined && { rowId }), ...(at && { at }), ...(m.size !== undefined && { size: m.size }) });
    }
  }
  return { outputs: [...found.values()], unlabelled };
}

export const outputKey = (chatId: string, producer: string, path: string) => JSON.stringify([chatId, producer, path]);

// --- How an Output reads on screen ---

/** Text direction and other invisible control characters, which can disguise a name (`evil‮gnp.exe`). */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** A file name as it is shown: invisible and direction-changing characters are made visible as `�`. */
export const shownName = (path: string) => (path.replace(/\/+$/, "").split("/").pop() || path).replace(HIDDEN_CHARS, "�");
/** A whole path, made safe the same way. */
export const shownPath = (path: string) => path.replace(HIDDEN_CHARS, "�");

export type OutputType = "image" | "text" | "document" | "media" | "archive" | "other";
export const TYPE_LABEL: Record<OutputType, string> = {
  image: "Image",
  text: "Text or code",
  document: "Document",
  media: "Audio or video",
  archive: "Archive",
  other: "Other",
};
const TYPE_EXTENSIONS: [OutputType, string][] = [
  ["image", "png jpg jpeg gif webp bmp svg ico avif tif tiff"],
  ["media", "mp3 ogg oga opus wav flac m4a aac mp4 webm mkv mov avi"],
  ["document", "pdf doc docx odt rtf xls xlsx ods ppt pptx odp epub"],
  ["archive", "zip tar gz tgz bz2 xz zst 7z rar whl deb"],
  [
    "text",
    "md markdown txt log csv tsv json jsonl yaml yml toml ini cfg conf xml html htm css scss js jsx mjs cjs ts tsx py rb go rs java kt c h cc cpp hpp cs swift sh bash zsh sql graphql proto vue svelte tex rst org diff patch ipynb",
  ],
];
const BY_EXTENSION = new Map(TYPE_EXTENSIONS.flatMap(([type, exts]) => exts.split(" ").map((e) => [e, type] as const)));

export const extensionOf = (path: string) => /\.([a-z0-9]{1,10})$/i.exec(shownName(path))?.[1].toLowerCase() ?? "";
export const typeOf = (path: string): OutputType => BY_EXTENSION.get(extensionOf(path)) ?? "other";

/** The most an image preview reads: Hermes's `read-data-url` limit. Text previews show the first 512 KB of any size. */
export const IMAGE_PREVIEW_MAX = 16 * 1024 * 1024;

/** Whether the preview pane can show the file, and why not. */
export function previewable(o: Output): { ok: true } | { ok: false; why: string } {
  if (o.availability?.state === "missing") return { ok: false, why: "The file isn't at this path any more." };
  if (o.availability?.state === "folder") return { ok: false, why: "This path is a folder now." };
  const type = typeOf(o.path);
  if (type === "image" && o.size !== undefined && o.size > IMAGE_PREVIEW_MAX) return { ok: false, why: "It's too large to preview (over 16 MB)." };
  if (type === "image" || type === "text") return { ok: true };
  if (type === "other" && !extensionOf(o.path)) return { ok: true };
  return { ok: false, why: `The preview can't show ${TYPE_LABEL[type].toLowerCase()} files.` };
}

/** What made it, in a few words. */
export const HOW_LABEL: Record<OutputHow, string> = {
  written: "Written by write_file",
  created: "Created by patch",
  speech: "Spoken by text_to_speech",
  image: "Made by image_generate",
  added: "Added by you",
};

export type Version = { n: number; of: number; latest: boolean };

/**
 * Each Output's version among the Outputs at the same path, oldest first by when it was stored. Only the latest one
 * is what the path holds now (if it is still there).
 */
export function versions(outputs: Output[]): Map<string, Version> {
  const byPath = new Map<string, Output[]>();
  for (const o of outputs) if (o.how !== "added") byPath.set(o.path, [...(byPath.get(o.path) ?? []), o]);
  const out = new Map<string, Version>();
  for (const list of byPath.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.rowId ?? 0) - (b.rowId ?? 0));
    sorted.forEach((o, i) => out.set(o.key, { n: i + 1, of: sorted.length, latest: i === sorted.length - 1 }));
  }
  return out;
}

// --- Reading Hermes ---

/** How the index reaches Hermes, for one profile. Both reject with the transport's message. */
export type OutputsIo = {
  /** One page of a chat's stored rows, newest first, refused past `maxBytes`. */
  rows(chatId: string, offset: number, limit: number, maxBytes: number): Promise<StoredRow[]>;
  /** `GET /api/fs/list` of a folder: its entries, or none and an errno-like `error`. */
  listDir(path: string): Promise<{ entries: { name: string; isDirectory: boolean }[]; error?: string }>;
};

const TOO_BIG = /over the .* MB limit/;
const NO_ROUTE = /answered 404: \{"detail":"Not Found"\}/;

/** The routes Outputs needs aren't on this server. */
export class OutputsUnsupported extends Error {}

/**
 * Reads a chat's newest stored rows, at most `MAX_ROWS_PER_CHAT`, a page at a time; a page too big to read is read in
 * smaller ones, and a single row too big is skipped and counted.
 */
export async function readRows(io: OutputsIo, chatId: string, stillWanted: () => boolean): Promise<{ rows: StoredRow[]; partial: IndexGaps }> {
  const rows: StoredRow[] = [];
  const partial: IndexGaps = {};
  let offset = 0;
  let limit = PAGE_ROWS;
  while (offset < MAX_ROWS_PER_CHAT && stillWanted()) {
    const want = Math.min(limit, MAX_ROWS_PER_CHAT - offset);
    let page: StoredRow[];
    try {
      page = await io.rows(chatId, offset, want, PAGE_MAX_BYTES);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (NO_ROUTE.test(message)) throw new OutputsUnsupported("This Hermes server can't list a chat's stored messages (GET /api/sessions/{id}/messages).");
      if (!TOO_BIG.test(message)) throw e;
      if (want > 1) {
        limit = Math.max(1, Math.floor(want / 5));
        continue;
      }
      partial.bigRows = (partial.bigRows ?? 0) + 1;
      offset += 1;
      limit = PAGE_ROWS;
      continue;
    }
    rows.push(...page);
    offset += page.length;
    if (page.length < want) return { rows, partial };
    limit = PAGE_ROWS;
  }
  if (offset >= MAX_ROWS_PER_CHAT) partial.olderRows = true;
  return { rows, partial };
}

/** The folder a path is in, and its name there. */
export function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\/+$/, "");
  const at = clean.lastIndexOf("/");
  if (at < 0) return { dir: "~", name: clean.slice(2) };
  return { dir: at === 0 ? "/" : clean.slice(0, at), name: clean.slice(at + 1) };
}

const FOLDER_ERRORS: Record<string, Omit<Availability, "checkedAt">> = {
  ENOENT: { state: "missing", why: "Its folder isn't on the server any more." },
  ENOTDIR: { state: "missing", why: "Its folder isn't a folder any more." },
  EACCES: { state: "forbidden", why: "The Hermes server's user isn't allowed to open its folder." },
};

/**
 * Checks where each of `paths` is now, one folder listing per folder, at most `MAX_FOLDERS_PER_CHECK` folders; paths
 * past that get no answer. Rejects with `OutputsUnsupported` on a server without `GET /api/fs/list`.
 */
export async function checkPaths(io: OutputsIo, paths: string[], now = Date.now()): Promise<Map<string, Availability>> {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const { dir } = splitPath(p);
    if (!byDir.has(dir) && byDir.size >= MAX_FOLDERS_PER_CHECK) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
  }
  const out = new Map<string, Availability>();
  for (const [dir, inDir] of byDir) {
    let listing: Awaited<ReturnType<OutputsIo["listDir"]>>;
    try {
      listing = await io.listDir(dir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (NO_ROUTE.test(message)) throw new OutputsUnsupported("This Hermes server can't list folders for the preview (GET /api/fs/list).");
      const forbidden = /answered 403/.test(message);
      for (const p of inDir) out.set(p, forbidden ? { state: "forbidden", checkedAt: now, why: "The server refused to list its folder." } : { state: "unknown", checkedAt: now, why: message });
      continue;
    }
    const err = listing.error ? (FOLDER_ERRORS[listing.error] ?? { state: "unknown" as const, why: `The server couldn't list its folder (${listing.error}).` }) : undefined;
    const names = new Map(listing.entries.map((e) => [e.name, e.isDirectory]));
    for (const p of inDir) {
      const { name } = splitPath(p);
      if (err) out.set(p, { ...err, checkedAt: now });
      else if (!names.has(name))
        out.set(p, { state: "missing", checkedAt: now, why: "Its folder doesn't list it: it was deleted, moved or renamed, or Hermes hides it." });
      else out.set(p, names.get(name) ? { state: "folder", checkedAt: now } : { state: "available", checkedAt: now });
    }
  }
  return out;
}

// --- What this computer keeps ---

export const OUTPUTS_KEY = "hermes-chat.outputs";
const OUTPUTS_VERSION = 1;
/** Most connections and profiles kept, and Outputs kept for one; the least recently indexed chats go first. */
const SCOPES_KEPT = 8;
export const OUTPUTS_KEPT = 3000;

/** One connection and profile's index. `usedAt`: when it was last read or written, to keep the most recent scopes. */
export type ScopeIndex = { chats: Record<string, ChatOutputs>; added: Output[]; usedAt: number };
type Doc = { v: number; scopes: Record<string, ScopeIndex> };
export type OutputsStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY_SCOPE = (): ScopeIndex => ({ chats: {}, added: [], usedAt: 0 });

function cleanOutput(v: unknown): Output | undefined {
  if (!isObj(v) || typeof v.key !== "string" || !isOutputPath(v.path)) return undefined;
  const how = ["written", "created", "speech", "image", "added"].includes(v.how as string) ? (v.how as OutputHow) : undefined;
  if (!how) return undefined;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  const a = isObj(v.availability) && typeof v.availability.state === "string" && num(v.availability.checkedAt) !== undefined ? (v.availability as Availability) : undefined;
  return {
    key: v.key,
    path: v.path,
    how,
    ...(str(v.chatId) && { chatId: v.chatId as string }),
    ...(str(v.tool) && { tool: v.tool as string }),
    ...(str(v.callId) && { callId: v.callId as string }),
    ...(num(v.rowId) !== undefined && { rowId: v.rowId as number }),
    ...(num(v.at) !== undefined && { at: v.at as number }),
    ...(num(v.size) !== undefined && { size: v.size as number }),
    ...(a && { availability: { state: a.state, checkedAt: a.checkedAt, ...(str(a.why) && { why: a.why }) } }),
  };
}

function cleanScope(v: unknown): ScopeIndex {
  if (!isObj(v)) return EMPTY_SCOPE();
  const chats: Record<string, ChatOutputs> = {};
  if (isObj(v.chats))
    for (const [id, c] of Object.entries(v.chats)) {
      if (!isObj(c) || typeof c.updatedAt !== "number" || !Array.isArray(c.outputs)) continue;
      chats[id] = {
        updatedAt: c.updatedAt,
        indexedAt: typeof c.indexedAt === "number" ? c.indexedAt : 0,
        outputs: c.outputs.flatMap((o) => cleanOutput(o) ?? []),
        ...(isObj(c.partial) && { partial: c.partial as IndexGaps }),
      };
    }
  const added = Array.isArray(v.added) ? v.added.flatMap((o) => cleanOutput(o) ?? []) : [];
  return { chats, added, usedAt: typeof v.usedAt === "number" ? v.usedAt : 0 };
}

export function readScope(storage: OutputsStorage, scope: string): ScopeIndex {
  try {
    const doc = JSON.parse(storage.getItem(OUTPUTS_KEY) ?? "null") as Doc | null;
    return cleanScope(isObj(doc) && doc.v === OUTPUTS_VERSION && isObj(doc.scopes) ? doc.scopes[scope] : undefined);
  } catch {
    return EMPTY_SCOPE();
  }
}

/** Keeps `index` as `scope`'s, within the limits. Returns false when the storage refused it. */
export function writeScope(storage: OutputsStorage, scope: string, index: ScopeIndex): boolean {
  let doc: Doc;
  try {
    const read = JSON.parse(storage.getItem(OUTPUTS_KEY) ?? "null") as Doc | null;
    doc = isObj(read) && read.v === OUTPUTS_VERSION && isObj(read.scopes) ? read : { v: OUTPUTS_VERSION, scopes: {} };
  } catch {
    doc = { v: OUTPUTS_VERSION, scopes: {} };
  }
  doc.scopes[scope] = trimmed(index);
  const kept = Object.entries(doc.scopes).sort(([, a], [, b]) => (b.usedAt ?? 0) - (a.usedAt ?? 0)).slice(0, SCOPES_KEPT);
  try {
    storage.setItem(OUTPUTS_KEY, JSON.stringify({ v: OUTPUTS_VERSION, scopes: Object.fromEntries(kept) }));
    return true;
  } catch {
    return false;
  }
}

/** The index within `OUTPUTS_KEPT` Outputs: the chats indexed longest ago are dropped first, to be read again. */
function trimmed(index: ScopeIndex): ScopeIndex {
  let total = index.added.length + Object.values(index.chats).reduce((n, c) => n + c.outputs.length, 0);
  if (total <= OUTPUTS_KEPT) return index;
  const chats = { ...index.chats };
  for (const [id, c] of Object.entries(chats).sort(([, a], [, b]) => a.indexedAt - b.indexedAt)) {
    if (total <= OUTPUTS_KEPT) break;
    total -= c.outputs.length;
    delete chats[id];
  }
  return { ...index, chats };
}

// --- The index for one connection and profile ---

/**
 * What the Outputs screen shows. `indexing`: a run is reading chats, `done` of `total`. `waiting`: chats in the last
 * run's scope that weren't read because of the per-run limit. `error`: why the last run or check failed.
 * `unsupported`: this server lacks a route Outputs needs. `notSaved`: this computer's storage refused the index.
 */
export type OutputsSnapshot = {
  chats: Record<string, ChatOutputs>;
  added: Output[];
  indexing?: { done: number; total: number };
  checking?: boolean;
  waiting: number;
  error?: string;
  unsupported?: string;
  notSaved?: boolean;
};

/** A chat to index: its id and last activity. */
export type ChatRef = { id: string; updatedAt: number };

export class OutputsIndex {
  private snap: OutputsSnapshot;
  private listeners = new Set<() => void>();
  /** Bumped by every run, check and `cancel`; an answer for an older one is dropped. */
  private runSeq = 0;
  private checkSeq = 0;

  constructor(
    private readonly io: OutputsIo,
    private readonly storage: OutputsStorage,
    readonly scope: string,
    private readonly now: () => number = Date.now,
  ) {
    const kept = readScope(storage, scope);
    this.snap = { chats: kept.chats, added: kept.added, waiting: 0 };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<OutputsSnapshot> | ((s: OutputsSnapshot) => Partial<OutputsSnapshot>), save = false) {
    const next = { ...this.snap, ...(typeof patch === "function" ? patch(this.snap) : patch) };
    if (save) next.notSaved = !writeScope(this.storage, this.scope, { chats: next.chats, added: next.added, usedAt: this.now() });
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  /** Stops the run and check under way; whatever they read later is dropped. For a profile switch or sign-out. */
  cancel() {
    this.runSeq++;
    this.checkSeq++;
    if (this.snap.indexing || this.snap.checking) this.set({ indexing: undefined, checking: false });
  }

  /**
   * Indexes the chats in `chats` that changed since they were indexed (all of them with `force`), the most recently
   * active first, at most `MAX_CHATS_PER_RUN`. Each chat's Outputs replace its old ones once it is read, keeping the
   * availability already known for a path. A new run replaces one under way.
   */
  async index(chats: ChatRef[], force = false): Promise<void> {
    const seq = ++this.runSeq;
    const live = () => seq === this.runSeq;
    const due = chats.filter((c) => force || this.snap.chats[c.id]?.updatedAt !== c.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt);
    const now = due.slice(0, MAX_CHATS_PER_RUN);
    this.set({ indexing: now.length ? { done: 0, total: now.length } : undefined, waiting: due.length - now.length, error: undefined });
    for (const [i, chat] of now.entries()) {
      let read: Awaited<ReturnType<typeof readRows>>;
      try {
        read = await readRows(this.io, chat.id, live);
      } catch (e) {
        if (!live()) return;
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof OutputsUnsupported) return this.set({ indexing: undefined, unsupported: message });
        // A chat deleted meanwhile has no rows to read; the rest go on.
        if (/answered 404/.test(message)) continue;
        return this.set({ indexing: undefined, error: `Couldn't read a chat's messages: ${message}` });
      }
      if (!live()) return;
      const { outputs, unlabelled } = outputsFromRows(chat.id, read.rows);
      const known = new Map(this.snap.chats[chat.id]?.outputs.map((o) => [o.path, o.availability]));
      const partial: IndexGaps = { ...read.partial, ...(unlabelled && { unlabelled }) };
      const entry: ChatOutputs = {
        updatedAt: chat.updatedAt,
        indexedAt: this.now(),
        outputs: outputs.map((o) => (known.get(o.path) ? { ...o, availability: known.get(o.path) } : o)),
        ...(Object.keys(partial).length && { partial }),
      };
      this.set((s) => ({ chats: { ...s.chats, [chat.id]: entry }, indexing: { done: i + 1, total: now.length } }), true);
    }
    if (live()) this.set({ indexing: undefined, unsupported: undefined });
  }

  /** Reads where each of `outputs` is now (`checkPaths`) and keeps the answers. */
  async check(outputs: Output[]): Promise<void> {
    const seq = ++this.checkSeq;
    this.set({ checking: true, error: undefined });
    let found: Map<string, Availability>;
    try {
      found = await checkPaths(this.io, [...new Set(outputs.map((o) => o.path))], this.now());
    } catch (e) {
      if (seq !== this.checkSeq) return;
      const message = e instanceof Error ? e.message : String(e);
      return this.set(e instanceof OutputsUnsupported ? { checking: false, unsupported: message } : { checking: false, error: `Couldn't check the files: ${message}` });
    }
    if (seq !== this.checkSeq) return;
    const keys = new Set(outputs.map((o) => o.key));
    const update = (o: Output) => (keys.has(o.key) && found.has(o.path) ? { ...o, availability: found.get(o.path) } : o);
    this.set(
      (s) => ({
        checking: false,
        chats: Object.fromEntries(Object.entries(s.chats).map(([id, c]) => [id, { ...c, outputs: c.outputs.map(update) }])),
        added: s.added.map(update),
      }),
      true,
    );
  }

  /**
   * Adds a Server file the owner names, for a file the index can't find on its own. It is checked first, and added
   * only when its folder lists it as a file. `chatId`: the chat it belongs with, if any. Rejects saying why not.
   */
  async add(path: string, chatId?: string): Promise<Output> {
    const p = path.trim();
    if (!isOutputPath(p)) throw new Error("Enter a full path on the Hermes server, starting with / or ~/.");
    const key = outputKey(chatId ?? "", "added", p);
    if (this.snap.added.some((o) => o.key === key)) throw new Error("That file is already in Outputs.");
    const checked = (await checkPaths(this.io, [p], this.now())).get(p);
    if (checked?.state !== "available") throw new Error(checked?.state === "folder" ? "That's a folder, not a file." : (checked?.why ?? "The server couldn't find that file."));
    const out: Output = { key, path: p, how: "added", at: this.now(), availability: checked, ...(chatId && { chatId }) };
    this.set((s) => ({ added: [...s.added, out] }), true);
    return out;
  }

  /** Takes an Output the owner added back out. Found ones go only when their chat is indexed without them. */
  remove(key: string) {
    this.set((s) => ({ added: s.added.filter((o) => o.key !== key) }), true);
  }
}

/** Every Output kept for the chats in `chatIds` (all of them when undefined), and the added ones that go with them. */
export function outputsIn(snap: Pick<OutputsSnapshot, "chats" | "added">, chatIds?: Set<string>): Output[] {
  const fromChats = Object.entries(snap.chats).flatMap(([id, c]) => (!chatIds || chatIds.has(id) ? c.outputs : []));
  const added = snap.added.filter((o) => !chatIds || (o.chatId !== undefined && chatIds.has(o.chatId)));
  return [...fromChats, ...added];
}
