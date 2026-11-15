// The files a reply changed on the server, and what undoing them one at a time would do (issue #601, ADR 0177). Hermes
// ties a checkpoint to nothing but its time, and `rollback.diff` compares a checkpoint with the files as they are now,
// so everything here is worked out from the transcript and those two reads. No I/O: `fileUndo.ts` does the reading.
import type { Item } from "./model";
import { splitPatch } from "./repo";

type ToolItem = Extract<Item, { kind: "tool" }>;

/** One successful `write_file` or `patch` in a reply. `path`: as the tool got it, relative to the chat's folder or not. */
export type FileEdit = { path: string; tool: "write_file" | "patch"; content?: string; newString?: string; inlineDiff?: string };

/**
 * A finished reply that edited files. `replyId`: its last reply item, which the chip sits under. Times are Unix seconds,
 * as Hermes stores them: `startedAt` its owner's message (none for a turn Hermes started), `endedAt` its last reply,
 * `prevEndedAt` the turn before's end (that turn's start when its end isn't known). `paths`: each file once, in the
 * order the reply first edited it.
 */
export type ReplyFiles = { replyId: string; startedAt?: number; endedAt: number; prevEndedAt?: number; edits: FileEdit[]; paths: string[] };

/** A checkpoint as `rollback.list` lists it: `at` in Unix seconds, which Hermes keeps to the whole second. */
export type Checkpoint = { hash: string; at: number; reason: string };

/**
 * Which checkpoint Hermes took just before a reply's first edit. `none`: no checkpoint from the reply's time is left.
 * `ambiguous`: the one found is from the second the previous reply ended in, so it may be that reply's.
 */
export type CheckpointMatch = { kind: "found"; checkpoint: Checkpoint } | { kind: "none" } | { kind: "ambiguous" };

/** One file in a `rollback.diff`. `section`: its part of the diff, none when the server's cut came first. */
export type DiffFile = { path: string; created: boolean; section?: string };
export type RollbackDiff = { stat: string; diff: string };
export type ParsedRollbackDiff = { files: DiffFile[]; cut: boolean };

/** Whether the owner changed a file since the bot last did: `unknown` when the app can't tell. */
export type HandEdit = "as-left" | "edited" | "unknown";

declare const relPath: unique symbol;
/** A non-empty path inside a chat's folder, relative to it: the only kind of path a one-file restore is sent. */
export type RelPath = string & { readonly [relPath]: true };

/**
 * What undoing one of a reply's files would do. `outside`: not in the chat's folder, which checkpoints don't cover.
 * `unchanged`: as it was in the checkpoint, so there is nothing to undo. `created`: the reply made it, and a one-file
 * restore can't take a file away. `undoable`: restoring it puts back the checkpoint's copy. `laterReply`: a later reply
 * edited it too, and the undo takes that back as well.
 */
export type FilePlan =
  | { state: "outside"; path: string }
  | { state: "unchanged"; path: string; rel: RelPath; abs: string }
  | { state: "created"; path: string; rel: RelPath; abs: string; section?: string }
  | { state: "undoable"; path: string; rel: RelPath; abs: string; handEdit: HandEdit; laterReply: boolean; section?: string };
export type UndoableFile = Extract<FilePlan, { state: "undoable" }>;

/** `rollback.diff` keeps the first this many characters of the diff (`tui_gateway/methods_tools.py:1178` at `bf0203a`). */
export const DIFF_CUT = 4000;
/** The reason Hermes gives the checkpoint it takes of the folder before a restore (`checkpoint_manager.py:1278`). */
const BEFORE_RESTORE = "pre-rollback snapshot";

const seconds = (ms?: number) => (ms === undefined ? undefined : ms / 1000);

/** A tool call that changed a file, or none: a refused edit (`error`, or `success: false`) didn't. */
function fileEdit(t: ToolItem): FileEdit | undefined {
  if ((t.name !== "write_file" && t.name !== "patch") || t.status !== "done") return undefined;
  const path = t.args?.path;
  if (typeof path !== "string" || !path || refused(t.result)) return undefined;
  const content = t.name === "write_file" && typeof t.args?.content === "string" ? t.args.content : undefined;
  const newString = t.name === "patch" && typeof t.args?.new_string === "string" ? t.args.new_string : undefined;
  return { path, tool: t.name, ...(content !== undefined && { content }), ...(newString !== undefined && { newString }), ...(t.inlineDiff && { inlineDiff: t.inlineDiff }) };
}

/** As Hermes judges an edit's result (`agent/display.py` `_result_succeeded`), but a result that isn't JSON isn't refused. */
function refused(result?: string): boolean {
  if (!result) return false;
  try {
    const r: unknown = JSON.parse(result);
    return !!r && typeof r === "object" && (!!(r as Record<string, unknown>).error || (r as Record<string, unknown>).success === false);
  } catch {
    return false;
  }
}

type Turn = { startedAt?: number; replyId?: string; endedAt?: number; edits: FileEdit[] };

/** The transcript's turns: each starts at a message of the owner's, or at work that came back. A steer is part of its turn. */
function turnsIn(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  for (const i of items) {
    if (i.kind === "user" && (i.outgoing || i.steer)) continue;
    if (i.kind === "user" || i.kind === "returned") {
      turn = { startedAt: seconds(i.at), edits: [] };
      turns.push(turn);
      continue;
    }
    if (!turn) turns.push((turn = { edits: [] }));
    if (i.kind === "assistant") {
      turn.replyId = i.id;
      turn.endedAt = seconds(i.at);
    } else if (i.kind === "tool") {
      const edit = fileEdit(i);
      if (edit) turn.edits.push(edit);
    }
  }
  return turns;
}

/** A path's key for telling two spellings of one file apart: where it is, when the folder places it. */
const fileKey = (folder: string | undefined, path: string) => placeIn(folder, path)?.abs ?? path;

/**
 * Every finished reply that edited a file, oldest first. A reply still running, or one Hermes hasn't given a time yet,
 * has none: its checkpoint can't be told by its time.
 */
export function replyFiles(items: Item[], folder?: string): ReplyFiles[] {
  const turns = turnsIn(items);
  return turns.flatMap((t, n): ReplyFiles[] => {
    if (!t.replyId || t.endedAt === undefined || !t.edits.length) return [];
    const prev = turns[n - 1];
    const prevEndedAt = prev ? (prev.endedAt ?? t.startedAt) : undefined;
    const seen = new Set<string>();
    const paths = t.edits.flatMap((e) => (seen.has(fileKey(folder, e.path)) ? [] : (seen.add(fileKey(folder, e.path)), [e.path])));
    return [{ replyId: t.replyId, ...(t.startedAt !== undefined && { startedAt: t.startedAt }), endedAt: t.endedAt, ...(prevEndedAt !== undefined && { prevEndedAt }), edits: t.edits, paths }];
  });
}

/**
 * `rollback.list`'s answer as checkpoints, newest first as Hermes lists them; undefined for an answer of another shape.
 * A row without a hash or a time it can read is left out.
 */
export function parseCheckpointList(answer: unknown): { enabled: boolean; checkpoints: Checkpoint[] } | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const { enabled, checkpoints } = answer as Record<string, unknown>;
  if (typeof enabled !== "boolean" || !Array.isArray(checkpoints)) return undefined;
  return {
    enabled,
    checkpoints: checkpoints.flatMap((c): Checkpoint[] => {
      const { hash, timestamp, message } = (c ?? {}) as Record<string, unknown>;
      const ms = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      if (typeof hash !== "string" || !/^[0-9a-f]{4,64}$/i.test(hash) || Number.isNaN(ms)) return [];
      return [{ hash, at: Math.floor(ms / 1000), reason: typeof message === "string" ? message : "" }];
    }),
  };
}

/**
 * The checkpoint taken before `reply`'s first edit: the oldest from the seconds the reply ran in, leaving out the ones
 * Hermes takes before a restore. Hermes keeps whole seconds, so one from the second the previous reply ended in is
 * ambiguous, and never guessed at.
 */
export function checkpointBefore(list: Checkpoint[], reply: ReplyFiles): CheckpointMatch {
  const from = reply.startedAt ?? reply.prevEndedAt;
  const lo = from === undefined ? -Infinity : Math.floor(from);
  const hi = Math.ceil(reply.endedAt);
  let oldest: Checkpoint | undefined;
  for (const c of list) {
    if (c.reason.startsWith(BEFORE_RESTORE) || c.at < lo || c.at > hi) continue;
    // Newest first: of two in one second, the later in the list is the older.
    if (!oldest || c.at <= oldest.at) oldest = c;
  }
  if (!oldest) return { kind: "none" };
  if (reply.prevEndedAt !== undefined && oldest.at <= Math.ceil(reply.prevEndedAt)) return { kind: "ambiguous" };
  return { kind: "found", checkpoint: oldest };
}

/** The file a git diff section is of: its new side, or its old one for a deleted file. */
function sectionPath(section: string): string | undefined {
  const to = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1] ?? /^--- a\/(.*)$/m.exec(section)?.[1];
  return to ?? /^diff --git a\/.* b\/(.*)$/m.exec(section)?.[1];
}

/** Whether a name in git's `--stat` names `rel`: the same, or git's `.../tail` for a long path. */
const statNames = (name: string, rel: string) => name === rel || (name.startsWith(".../") && rel.endsWith(name.slice(3)));

/**
 * `rollback.diff`'s stat and diff, as the files that differ from the checkpoint now. Membership is the stat's, which
 * the server doesn't cut; a file's diff section is missing once the 4000-character cut came before it.
 */
export function parseRollbackDiff(stat: string, diff: string): ParsedRollbackDiff {
  const sections = splitPatch(diff).flatMap((s) => {
    const path = sectionPath(s.diff);
    return path === undefined ? [] : [{ path, diff: s.diff.replace(/\n$/, "") }];
  });
  const files = stat.split("\n").flatMap((line): DiffFile[] => {
    const bar = line.lastIndexOf(" | ");
    if (bar < 0) return [];
    const path = line.slice(0, bar).trim();
    const section = sections.find((s) => statNames(path, s.path))?.diff;
    const created = !!section && (/^new file mode /m.test(section) || /^--- \/dev\/null$/m.test(section));
    return [{ path, created, ...(section !== undefined && { section }) }];
  });
  return { files, cut: diff.length >= DIFF_CUT };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const FILE_LINE = /^a\/.* → b\/.*$/;

/**
 * The text each hunk of an `inline_diff` left behind, in order: its context and added lines. Undefined when the diff
 * isn't whole: Hermes cut lines or files from it (the summary line it adds then), or it isn't of one file.
 */
function hunksAfter(inlineDiff: string): string[] | undefined {
  // The first line is Hermes's heading, in the owner's language.
  const lines = inlineDiff.replace(ANSI, "").split("\n").slice(1);
  const hunks: string[][] = [];
  let files = 0;
  for (const line of lines) {
    if (FILE_LINE.test(line)) files++;
    else if (line.startsWith("@@")) hunks.push([]);
    else if (line.startsWith("+") || line.startsWith(" ")) hunks.at(-1)?.push(line.slice(1));
    else if (!line.startsWith("-") && !line.startsWith("\\") && line) return undefined;
  }
  return files === 1 && hunks.length ? hunks.map((h) => h.join("\n")) : undefined;
}

/**
 * Whether the file now is as the bot's last edit of it left it. `current`: its text now, undefined when it couldn't be
 * read whole. A `write_file` left exactly its content; a `patch` left each of its hunks' after-text, which the file
 * must still hold. Changes outside those hunks can't be seen this way.
 */
export function handEdit(current: string | undefined, last: FileEdit): HandEdit {
  if (current === undefined) return "unknown";
  if (last.tool === "write_file" && last.content !== undefined) return current === last.content ? "as-left" : "edited";
  const after = last.inlineDiff === undefined ? undefined : hunksAfter(last.inlineDiff);
  if (after) return after.every((h) => current.includes(h)) ? "as-left" : "edited";
  if (last.inlineDiff === undefined && last.tool === "patch" && last.newString) return current.includes(last.newString) ? "as-left" : "unknown";
  return "unknown";
}

/**
 * Where `path` is, given the folder it is relative to: its full path, and its path inside the folder. None for a path
 * outside the folder, a `~` path (whose home is the server's to say), or with no folder to place it in.
 */
export function placeIn(folder: string | undefined, path: string): { rel: RelPath; abs: string } | undefined {
  if (!folder?.startsWith("/") || !path || path.startsWith("~")) return undefined;
  const base = folder.replace(/\/+$/, "");
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  const abs = `/${parts.join("/")}`;
  return abs.startsWith(`${base}/`) ? { rel: abs.slice(base.length + 1) as RelPath, abs } : undefined;
}

/**
 * What undoing each of `reply`'s files would do, against the diff from its checkpoint (`diff`) and each file's text now
 * (`current`, by full path; undefined for one that couldn't be read whole). A hand edit is judged against the last
 * successful edit of the file anywhere in the transcript.
 */
export function planFiles(reply: ReplyFiles, items: Item[], folder: string | undefined, diff: ParsedRollbackDiff, current: ReadonlyMap<string, string | undefined>): FilePlan[] {
  const turns = turnsIn(items);
  const at = turns.findIndex((t) => t.replyId === reply.replyId);
  return reply.paths.map((path): FilePlan => {
    const placed = placeIn(folder, path);
    if (!placed) return { state: "outside", path };
    const { rel, abs } = placed;
    const file = diff.files.find((f) => statNames(f.path, rel));
    if (!file) return { state: "unchanged", path, rel, abs };
    const section = file.section !== undefined ? { section: file.section } : {};
    if (file.created) return { state: "created", path, rel, abs, ...section };
    const ofFile = (t: { edits: FileEdit[] }) => t.edits.filter((e) => fileKey(folder, e.path) === abs);
    const later = turns.slice(at + 1).flatMap(ofFile);
    const last = later.at(-1) ?? ofFile(reply).at(-1)!;
    const laterReply = later.length > 0;
    return { state: "undoable", path, rel, abs, handEdit: handEdit(current.get(abs), last), laterReply, ...section };
  });
}
