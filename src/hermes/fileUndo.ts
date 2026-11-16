// Undoing a reply's files one at a time (issue #601, ADR 0177), as every restore here goes (ADR 0110, ADR 0024): a
// preview, a refusal if the server changed since it, the writes, and a read back. Only one-file restores are sent: a
// whole-folder restore also drops the chat's newest message, whatever checkpoint it restores.
import { checkpointBefore, fileIn, parseRollbackDiff, planFiles, type Checkpoint, type FilePlan, type RelPath, type ReplyFiles, type RollbackDiff, type UndoableFile } from "./fileChanges";
import type { Item } from "./model";
import { errorText } from "./values";

/** What undoing reads and writes, for one chat. */
export type RollbackIO = {
  list(): Promise<{ enabled: boolean; checkpoints: Checkpoint[] }>;
  diff(hash: string): Promise<RollbackDiff>;
  /** `rollback.restore` of one file: Hermes checks it out of the checkpoint, and leaves the chat alone. */
  restoreFile(hash: string, file: RelPath): Promise<Restored>;
  /** A file's whole text now, or undefined when it can't be read whole. */
  readText(abs: string): Promise<string | undefined>;
};

export type Restored = { restored: true } | { restored: false; error: string };

/**
 * What the Preview shows for a reply's files. `off`: Hermes takes no checkpoints for the chat. `none` and `ambiguous`:
 * no checkpoint can be told to be the one before the reply (`checkpointBefore`). `found`: each file's plan, against
 * `shown`, the diff and the texts the plans were made from, which an undo checks are still so.
 */
export type FilesView =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "found"; checkpoint: Checkpoint; files: FilePlan[]; cut: boolean; shown: { diff: RollbackDiff; texts: ReadonlyMap<string, string | undefined> } };
export type FoundFiles = Extract<FilesView, { kind: "found" }>;

/**
 * One file's undo. `restored`: Hermes restored it, and it no longer differs from the checkpoint. `still-differs`: Hermes
 * answered success but it does. `unconfirmed`: the read back failed. `failed`: Hermes didn't restore it. `not-tried`:
 * an earlier file failed, so it wasn't sent.
 */
export type FileOutcome = { file: UndoableFile; outcome: "restored" | "still-differs" | "unconfirmed" | "failed" | "not-tried"; error?: string };

/** `changed`: the server changed since the preview, so nothing was restored. */
export type UndoReport = { kind: "changed" } | { kind: "done"; files: FileOutcome[] };

const undoable = (f: FilePlan): f is UndoableFile => f.state === "undoable";

/** Reads what undoing `reply`'s files would do: its checkpoint, the diff from it, and each undoable file's text now. */
export async function loadFiles(io: RollbackIO, reply: ReplyFiles, items: Item[], folder: string | undefined): Promise<FilesView> {
  const list = await io.list();
  if (!list.enabled) return { kind: "off" };
  const match = checkpointBefore(list.checkpoints, reply);
  if (match.kind !== "found") return match;
  const diff = await io.diff(match.checkpoint.hash);
  const parsed = parseRollbackDiff(diff.stat, diff.diff);
  const toRead = planFiles(reply, items, folder, parsed, new Map()).filter(undoable);
  const texts = new Map(await Promise.all(toRead.map(async (f) => [f.abs, await io.readText(f.abs)] as const)));
  return { kind: "found", checkpoint: match.checkpoint, files: planFiles(reply, items, folder, parsed, texts), cut: parsed.cut, shown: { diff, texts } };
}

/**
 * Restores `chosen`, one file at a time in order, to `view`'s checkpoint. Refuses, restoring nothing, when the diff or
 * a chosen file's text is no longer what `view` showed. Stops at the first file Hermes doesn't restore. Then reads the
 * diff back: a restored file must be gone from it, and its text must have changed.
 */
export async function undoFiles(io: RollbackIO, view: FoundFiles, chosen: UndoableFile[]): Promise<UndoReport> {
  const { hash } = view.checkpoint;
  const [now, texts] = await Promise.all([io.diff(hash), Promise.all(chosen.map((f) => io.readText(f.abs)))]);
  const shown = view.shown;
  if (now.stat !== shown.diff.stat || now.diff !== shown.diff.diff || chosen.some((f, n) => texts[n] !== shown.texts.get(f.abs))) return { kind: "changed" };
  const sent: FileOutcome[] = [];
  for (const file of chosen) {
    if (sent.some((o) => o.outcome === "failed")) {
      sent.push({ file, outcome: "not-tried" });
      continue;
    }
    const r = await io.restoreFile(hash, file.rel).catch((e: unknown): Restored => ({ restored: false, error: errorText(e) }));
    sent.push(r.restored ? { file, outcome: "restored" } : { file, outcome: "failed", error: r.error });
  }
  if (!sent.some((o) => o.outcome === "restored")) return { kind: "done", files: sent };
  try {
    const back = await io.diff(hash);
    const parsed = parseRollbackDiff(back.stat, back.diff);
    const after = await Promise.all(sent.map((o) => (o.outcome === "restored" ? io.readText(o.file.abs) : undefined)));
    // Hermes answers a diff it failed to make as an empty one, so a file whose text didn't change wasn't restored.
    const differs = (o: FileOutcome, n: number) => !!fileIn(parsed, o.file.rel) || after[n] === shown.texts.get(o.file.abs);
    return {
      kind: "done",
      files: sent.map((o, n): FileOutcome => {
        if (o.outcome !== "restored") return o;
        if (differs(o, n)) return { ...o, outcome: "still-differs" };
        // An empty diff is also how Hermes answers one it failed to make, so only the file's own text can confirm it.
        return after[n] === undefined ? { ...o, outcome: "unconfirmed", error: "the file couldn't be read back." } : o;
      }),
    };
  } catch (e) {
    return { kind: "done", files: sent.map((o) => (o.outcome === "restored" ? { ...o, outcome: "unconfirmed", error: errorText(e) } : o)) };
  }
}
