// Settings → Memory: the built-in memory Hermes keeps for the profile, read and edited one entry at a time on the
// server (GLOSSARY.md "Memory", ADR 0020). Hermes keeps two files in the profile's home, `memories/MEMORY.md` (its own
// notes) and `memories/USER.md` (what it knows about the owner), each a list of entries separated by a line holding only
// "§" (`tools/memory_tool.py`, `tools/memory_tool_store.py` at the deployed `bf0203a`).
//
// The only client calls Hermes has that change memory are the legacy `learning.*` JSON-RPC methods on `/api/ws`, which
// its own TUI uses for `/journey` (`tui_gateway/methods_tools.py`, `agent/learning_mutations.py`):
// - `learning.frames` lists every entry as a node `memory:<source>:<index>:<fingerprint>`, `source` being `memory` for
//   MEMORY.md and `profile` for USER.md, and the fingerprint a digest of the entry's text.
// - `learning.detail` reads one entry's full text, `learning.edit` replaces it and `learning.delete` removes it. They
//   find the entry by its fingerprint inside the memory tool's own file lock, so a write to an entry that changed or
//   went since it was read is refused ("memory node id is stale"), never applied to another entry.
// - There is no call that adds an entry; only the agent's memory tool does.
// - They take no `profile` and refuse one ("Extra inputs are not permitted"): they always act on the memory of the
//   profile the dashboard process runs as. So this screen edits memory only when that profile, `GET
//   /api/profiles/active` → `current`, is the profile shown, and checks it again before every write.
//
// Memory text comes from the agent and whatever it read, so it is shown as plain text, never rendered, and never kept
// on this computer. The one exception to "never kept": what a save from here replaced, held in this app's memory (never
// on disk) until sign-out or quit, so the owner can put it back (ADR 0040).

/** Which of the profile's memory files an entry is in, by the name `learning.*` gives it. */
export type MemorySource = "memory" | "profile";

/** The memory files Hermes keeps, in the order it lists them. */
export const MEMORY_RESOURCES: readonly { source: MemorySource; file: string; name: string; about: string }[] = [
  { source: "memory", file: "MEMORY.md", name: "Agent notes", about: "What Hermes noted for itself, such as facts about your setup and projects." },
  { source: "profile", file: "USER.md", name: "User profile", about: "What Hermes noted about you, such as your preferences and how you work." },
];

export const resourceOf = (source: MemorySource) => MEMORY_RESOURCES.find((r) => r.source === source)!;

/** One memory entry. `id` names it to Hermes by its text; once the text changes on the server, the id is stale. */
export type MemoryEntry = { id: string; source: MemorySource; text: string };

/** One memory file as Hermes has it. `bytes`: the file's size, when Hermes reported it. */
export type MemoryResource = { source: MemorySource; file: string; entries: MemoryEntry[]; bytes?: number };

/**
 * The profile's memory as read from Hermes. `home`: the profile's folder on the server, when Hermes reported it.
 * `provider`: an external memory provider the profile also uses, whose memories aren't edited here.
 */
export type MemoryView = {
  profile: string;
  home?: string;
  resources: Record<MemorySource, MemoryResource>;
  provider?: string;
};

/** The line Hermes puts between entries (`ENTRY_DELIMITER`). An entry can't hold it, or it reads back as several. */
export const ENTRY_DELIMITER = "\n§\n";

/**
 * Why memory can't be edited here. `server`: Hermes has no `learning.*` methods, or none this app can use safely.
 * `profile`: the dashboard runs as another profile (`served`), and `learning.*` reach only its memory.
 */
export class MemoryUnsupportedError extends Error {
  constructor(
    readonly reason: "server" | "profile",
    message: string,
    readonly served?: string,
  ) {
    super(message);
  }
}

/** Hermes refused for lack of permission on the server, or the sign-in no longer covers the request. */
export class MemoryPermissionError extends Error {}

/**
 * The entry changed on the server, or went, since it was read, so nothing was written. `view`: memory as Hermes has
 * it now.
 */
export class MemoryConflictError extends Error {
  constructor(readonly view: MemoryView) {
    super("This entry changed on the server, or was removed, since you opened it. Nothing was saved.");
  }
}

/** Hermes answered that it didn't write, with its reason, such as the file's size limit. Nothing was written. */
export class MemoryRefusedError extends Error {}

/** The connection dropped before Hermes answered a write, so it may or may not have made it. */
export class MemoryUnsureError extends Error {}

/** Hermes said it wrote, but reading memory back doesn't show the change. `view`: memory as read back. */
export class MemoryUnverifiedError extends Error {
  constructor(
    message: string,
    readonly view: MemoryView,
  ) {
    super(message);
  }
}

/**
 * What a save from this app replaced: `text` was the entry before it, `saved` the entry the save left, at `savedAt`
 * (ms). Kept in this app's memory only, per profile and file, the most recent `KEEP_REPLACED` (ADR 0040).
 */
export type MemoryReplaced = { text: string; saved: string; savedAt: number };

/** How the memory calls reach Hermes: a legacy JSON-RPC request on `/api/ws`, and a dashboard REST read. */
export type MemoryIO = {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  get(pathAndQuery: string): Promise<unknown>;
};

export type MemoryApi = {
  /** The profile's memory. Rejects with `MemoryUnsupportedError` when it can't be edited from here. */
  load(profile: string): Promise<MemoryView>;
  /**
   * Replaces `entry`, as last read, with `text`, then reads memory back. Resolves to memory as read back and the entry
   * as saved. Rejects with `MemoryConflictError` when the entry changed on the server since it was read.
   */
  save(profile: string, entry: MemoryEntry, text: string): Promise<{ view: MemoryView; entry: MemoryEntry }>;
  /** Removes `entry`, as last read, then reads memory back to check it's gone. */
  remove(profile: string, entry: MemoryEntry): Promise<MemoryView>;
  /**
   * What this app's latest confirmed save to `entry`'s text replaced, while the entry still holds what that save left.
   * Undefined once the entry changed since, or when no save from here made it.
   */
  replacedBy(profile: string, entry: MemoryEntry): MemoryReplaced | undefined;
};

// JSON-RPC codes the deployed `bf0203a` answers: method not found (an older server), and params its contract refuses
// (`tui_gateway/contracts`, extra or mistyped fields: a server whose `learning.*` changed shape).
const NO_SUCH_METHOD = -32601;
const BAD_PARAMS = 4000;
/** The smallest timeline `learning.frames` renders (`methods_tools.py` clamps to 20 by 10, two frames); only its
 * nodes are read. */
const FRAMES_PARAMS = { cols: 20, rows: 10, frames: 2 };
/** How often a read starts over when an entry changes between being listed and being read. */
const READ_TRIES = 3;
/** How many replaced texts are kept per profile and file. */
const KEEP_REPLACED = 10;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A JSON-RPC error answer: Hermes got the request and answered it. Anything else may not have reached it. */
const rpcCode = (e: unknown): number | undefined => (isObj(e) && typeof e.code === "number" ? e.code : undefined);

/** What `learning.*` answers when the id names text that's no longer there (`agent/learning_mutations.py`). */
const isStale = (message: string) => /\bstale\b/i.test(message);
/** A refusal for lack of permission: the server's file permissions, or a dashboard answer of 403. */
const isPermission = (message: string) => /permission denied|errno 13|not writable|\b403\b|forbidden/i.test(message);

/**
 * Python's `str.strip()`, which Hermes applies to every entry: the characters `str.isspace()` counts. JavaScript's
 * `trim` differs at the edges (it strips U+FEFF and keeps U+001C to U+001F and U+0085).
 */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
export const pyStrip = (s: string) => s.replace(PY_STRIP, "");

/** Characters as Hermes counts them toward a file's limit (Python `len`: code points). */
export const charCount = (s: string) => [...s].length;

/** A file's size as Hermes counts it toward its limit: the entries joined by the delimiter. */
export const resourceChars = (entries: { text: string }[]) =>
  entries.length ? entries.reduce((n, e) => n + charCount(e.text), 0) + charCount(ENTRY_DELIMITER) * (entries.length - 1) : 0;

/**
 * Why `text` can't be saved as one entry, if it can't: Hermes refuses an empty one, and a line holding only "§" would
 * split it into several when Hermes reads the file again.
 */
export function entryProblem(text: string): string | undefined {
  const t = pyStrip(text);
  if (!t) return "An entry can't be empty. To remove it, use Delete.";
  if (/(^|\n)§(\n|$)/.test(t)) return "A line holding only “§” separates entries in Hermes's memory file, so this would be saved as several entries. Change or remove that line.";
}

/** `memory:<source>:<index>:<fingerprint>` → its parts; anything else isn't a memory node. */
function parseId(id: string): { source: MemorySource; index: number; fingerprint?: string } | undefined {
  const parts = id.split(":");
  if (parts[0] !== "memory" || (parts.length !== 3 && parts.length !== 4)) return undefined;
  if (parts[1] !== "memory" && parts[1] !== "profile") return undefined;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return { source: parts[1], index, fingerprint: parts[3] || undefined };
}

/** The memory nodes in a `learning.frames` answer, in Hermes's order: MEMORY.md's entries first, then USER.md's. */
function memoryNodes(frames: unknown): { id: string; source: MemorySource; index: number; fingerprint?: string }[] {
  if (!isObj(frames) || !Array.isArray(frames.buckets)) throw new MemoryUnsupportedError("server", "Hermes answered the memory list in a shape this app doesn't know.");
  const seen = new Map<string, { id: string; source: MemorySource; index: number; fingerprint?: string }>();
  for (const bucket of frames.buckets) {
    if (!isObj(bucket) || !Array.isArray(bucket.nodes)) continue;
    for (const node of bucket.nodes) {
      const id = isObj(node) && typeof node.id === "string" ? node.id : "";
      const parsed = parseId(id);
      if (parsed) seen.set(id, { id, ...parsed });
    }
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/** A failed `learning.*` or REST call, as the reason the screen shows. */
function classify(e: unknown): Error {
  if (e instanceof MemoryUnsupportedError || e instanceof MemoryPermissionError) return e;
  const code = rpcCode(e);
  if (code === NO_SUCH_METHOD)
    return new MemoryUnsupportedError("server", "This Hermes server has no memory editing calls (`learning.detail`, `learning.edit`). Updating Hermes adds them.");
  if (code === BAD_PARAMS)
    return new MemoryUnsupportedError("server", `This Hermes server's memory calls changed shape, so this app won't use them: ${messageOf(e)}`);
  const message = messageOf(e);
  if (/signed out|401|unauthori[sz]ed/i.test(message)) return new MemoryPermissionError(`The dashboard no longer accepts this sign-in: ${message}`);
  if (isPermission(message)) return new MemoryPermissionError(`Hermes isn't allowed to do that on the server: ${message}`);
  return e instanceof Error ? e : new Error(message);
}

/** The profile's folder and memory sizes, as dashboard REST reports them; missing when it can't. */
async function extras(io: MemoryIO, profile: string): Promise<Pick<MemoryView, "home" | "provider"> & { bytes?: Record<MemorySource, number> }> {
  const q = new URLSearchParams({ profile });
  const [status, profiles] = await Promise.all([io.get(`api/memory?${q}`).catch(() => undefined), io.get("api/profiles").catch(() => undefined)]);
  const files = isObj(status) && isObj(status.builtin_files) ? status.builtin_files : undefined;
  const size = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
  const memoryBytes = size(files?.memory);
  const userBytes = size(files?.user);
  const listed = isObj(profiles) && Array.isArray(profiles.profiles) ? profiles.profiles : [];
  const row = listed.find((p) => isObj(p) && p.name === profile);
  return {
    home: isObj(row) && typeof row.path === "string" && row.path ? row.path : undefined,
    provider: isObj(status) && typeof status.active === "string" && status.active ? status.active : undefined,
    bytes: memoryBytes !== undefined && userBytes !== undefined ? { memory: memoryBytes, profile: userBytes } : undefined,
  };
}

export function memoryApi(io: MemoryIO, now = () => Date.now()): MemoryApi {
  // What saves from here replaced, by profile and file, most recent first. Lives as long as this connection's client.
  const replaced = new Map<string, MemoryReplaced[]>();
  const rpc = (method: string, params: Record<string, unknown>) => io.rpc(method, params).catch((e) => Promise.reject(classify(e)));

  /** Rejects unless the dashboard runs as `profile`, whose memory `learning.*` reach. */
  const checkServed = async (profile: string) => {
    const active = await io.get("api/profiles/active").catch((e) => Promise.reject(classify(e)));
    const served = isObj(active) && typeof active.current === "string" ? active.current : "";
    if (served === profile) return;
    throw new MemoryUnsupportedError(
      "profile",
      served && served !== "custom"
        ? `Hermes can edit memory only for the profile its dashboard runs as, which is ${served}. The ${profile} profile's memory can't be read or changed from here.`
        : `Hermes can edit memory only for the profile its dashboard runs as, and it doesn't say which that is, so the ${profile} profile's memory can't be read or changed from here.`,
      served || undefined,
    );
  };

  const read = async (profile: string): Promise<MemoryView> => {
    for (let attempt = 1; ; attempt++) {
      const nodes = memoryNodes(await rpc("learning.frames", FRAMES_PARAMS));
      if (nodes.some((n) => !n.fingerprint))
        throw new MemoryUnsupportedError("server", "This Hermes server names memory entries by position only, so an edit could land on the wrong entry. Updating Hermes fixes this.");
      const details = await Promise.all(nodes.map((n) => rpc("learning.detail", { id: n.id })));
      const stale = details.some((d) => isObj(d) && d.ok === false && isStale(String(d.message ?? "")));
      if (stale) {
        if (attempt < READ_TRIES) continue;
        throw new Error("Memory kept changing on the server while it was read. Try Reload.");
      }
      const resources: Record<MemorySource, MemoryResource> = {
        memory: { source: "memory", file: "MEMORY.md", entries: [] },
        profile: { source: "profile", file: "USER.md", entries: [] },
      };
      nodes.forEach((n, i) => {
        const d = details[i];
        if (!isObj(d) || d.ok !== true || typeof d.content !== "string") {
          const why = isObj(d) && typeof d.message === "string" ? d.message : "no content";
          throw classify(new Error(`Hermes couldn't read a memory entry: ${why}`));
        }
        resources[n.source].entries.push({ id: n.id, source: n.source, text: d.content });
      });
      const more = await extras(io, profile);
      if (more.bytes) {
        resources.memory.bytes = more.bytes.memory;
        resources.profile.bytes = more.bytes.profile;
      }
      return { profile, home: more.home, provider: more.provider, resources };
    }
  };

  const load = async (profile: string) => {
    await checkServed(profile);
    return read(profile);
  };

  /** Rejects with a conflict unless `entry` is on the server as it was read. */
  const checkUnchanged = async (profile: string, entry: MemoryEntry) => {
    const now = await rpc("learning.detail", { id: entry.id });
    if (isObj(now) && now.ok === true && now.content === entry.text) return;
    if (isObj(now) && now.ok === false && !isStale(String(now.message ?? ""))) throw classify(new Error(String(now.message ?? "Hermes couldn't read the entry.")));
    throw new MemoryConflictError(await read(profile));
  };

  /** One `learning.edit` or `learning.delete`, and what its answer means. */
  const write = async (profile: string, method: string, params: Record<string, unknown>) => {
    let res: unknown;
    try {
      res = await io.rpc(method, params);
    } catch (e) {
      if (rpcCode(e) === undefined)
        throw new MemoryUnsureError(`The connection dropped before Hermes answered, so it may or may not have saved the change. Reload once connected to see. (${messageOf(e)})`);
      throw classify(e);
    }
    if (isObj(res) && res.ok === true) return;
    const message = isObj(res) && typeof res.message === "string" ? res.message : "Hermes didn't say why.";
    if (isStale(message)) throw new MemoryConflictError(await read(profile));
    if (isPermission(message)) throw new MemoryPermissionError(`Hermes isn't allowed to change the memory file: ${message}`);
    throw new MemoryRefusedError(`Hermes didn't save it: ${message}`);
  };

  return {
    load,
    async save(profile, entry, text) {
      const problem = entryProblem(text);
      if (problem) throw new MemoryRefusedError(problem);
      const next = pyStrip(text);
      await checkServed(profile);
      await checkUnchanged(profile, entry);
      if (next !== entry.text) await write(profile, "learning.edit", { id: entry.id, content: next });
      const view = await read(profile);
      const saved = view.resources[entry.source].entries.find((e) => e.text === next);
      if (!saved) throw new MemoryUnverifiedError(`Hermes said it saved the entry, but ${entry.source === "memory" ? "MEMORY.md" : "USER.md"} doesn't have it when read back. It may have been changed again meanwhile.`, view);
      if (next !== entry.text) {
        const key = `${profile}\n${entry.source}`;
        replaced.set(key, [{ text: entry.text, saved: next, savedAt: now() }, ...(replaced.get(key) ?? [])].slice(0, KEEP_REPLACED));
      }
      return { view, entry: saved };
    },
    async remove(profile, entry) {
      await checkServed(profile);
      await checkUnchanged(profile, entry);
      await write(profile, "learning.delete", { id: entry.id });
      const view = await read(profile);
      if (view.resources[entry.source].entries.some((e) => e.text === entry.text))
        throw new MemoryUnverifiedError("Hermes said it removed the entry, but it is still there when read back.", view);
      return view;
    },
    replacedBy(profile, entry) {
      return replaced.get(`${profile}\n${entry.source}`)?.find((r) => r.saved === entry.text);
    },
  };
}
