// The checkpoints a fake Hermes keeps for a folder (`tools/checkpoint_manager.py` at `bf0203a`, measured on a real
// Hermes on 2026-11-15, ADR 0177): each one the folder's files as they were, newest first, with the time to the whole
// second. `rollback.diff` compares one with the files now, in git's format, cut at 4000 characters. A one-file restore
// checks that file out of it; either restore first takes a "pre-rollback snapshot". The files are FakeHermes's
// `serverFiles`, so `GET /api/fs/read-text` reads what a restore wrote.

export type FakeCheckpoint = { hash: string; timestamp: string; message: string; files: Record<string, string> };

/** One edit the scripted file turn makes. `refused`: Hermes refuses it, as a write over a file the bot hasn't read. */
export type FakeEdit = { tool: "write_file"; path: string; content: string; refused?: boolean } | { tool: "patch"; path: string; old: string; new: string };

type Disk = Record<string, string | { dir: true }>;

const iso = (seconds: number) => new Date(Math.floor(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export class FakeCheckpoints {
  /** `checkpoints.enabled` for the profile. Off, as Hermes's default: none are taken, and `rollback.list` says so. */
  on = false;
  /** `checkpoints.max_snapshots`: how many a folder keeps. */
  max = 20;
  /** The stored chats whose terminal runs in a container, which Hermes takes no checkpoints for and won't diff. */
  readonly containerChats = new Set<string>();
  /** Each folder's checkpoints, newest first. */
  readonly byFolder: Record<string, FakeCheckpoint[]> = {};
  private seq = 0;

  constructor(
    private readonly disk: () => Disk,
    private readonly now: () => number,
  ) {}

  /** The folder's files, by path relative to it. */
  files(folder: string): Record<string, string> {
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    return Object.fromEntries(Object.entries(this.disk()).flatMap(([p, v]) => (p.startsWith(prefix) && typeof v === "string" ? [[p.slice(prefix.length), v]] : [])));
  }

  take(folder: string, message: string): FakeCheckpoint {
    const hash = `${(++this.seq).toString(16).padStart(8, "0")}${"c".repeat(32)}`;
    const cp = { hash, timestamp: iso(this.now()), message, files: this.files(folder) };
    this.byFolder[folder] = [cp, ...(this.byFolder[folder] ?? [])].slice(0, this.max);
    return cp;
  }

  list(folder: string) {
    return (this.byFolder[folder] ?? []).map(({ hash, timestamp, message }) => ({ hash, timestamp, message }));
  }

  private find(folder: string, hash: string) {
    return hash.length >= 4 ? this.byFolder[folder]?.find((c) => c.hash.startsWith(hash)) : undefined;
  }

  /** `rollback.diff`'s answer: an unknown hash answers an empty diff, as Hermes's failed diff does. */
  diff(folder: string, hash: string): { stat: string; diff: string } {
    const cp = this.find(folder, hash);
    if (!cp) return { stat: "", diff: "" };
    const now = this.files(folder);
    const paths = [...new Set([...Object.keys(cp.files), ...Object.keys(now)])].filter((p) => cp.files[p] !== now[p]).sort();
    const parts = paths.map((p) => fileDiff(p, cp.files[p], now[p]));
    if (!parts.length) return { stat: "", diff: "" };
    const width = Math.max(...paths.map((p) => p.length));
    const [ins, del] = [parts.reduce((n, d) => n + d.insertions, 0), parts.reduce((n, d) => n + d.deletions, 0)];
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const summary = [plural(paths.length, "file") + " changed", ...(ins ? [`${plural(ins, "insertion")}(+)`] : []), ...(del ? [`${plural(del, "deletion")}(-)`] : [])].join(", ");
    const stat = [...paths.map((p, n) => ` ${p.padEnd(width)} | ${parts[n].insertions + parts[n].deletions} ${"+".repeat(parts[n].insertions)}${"-".repeat(parts[n].deletions)}`), ` ${summary}`];
    return { stat: stat.join("\n").trim(), diff: parts.map((d) => d.section).join("\n").slice(0, 4000) };
  }

  /** `rollback.restore`'s answer: of `file` alone, or of the whole folder. */
  restore(folder: string, hash: string, file?: string): Record<string, unknown> {
    const cp = this.find(folder, hash);
    if (!cp) return { success: false, error: `Checkpoint '${hash}' not found` };
    if (file !== undefined && !(file in cp.files)) {
      const debug = `error: pathspec '${file}' did not match any file(s) known to git`;
      return { success: false, error: `Restore failed: ${debug}`, debug };
    }
    this.take(folder, `pre-rollback snapshot (restoring to ${cp.hash.slice(0, 8)})`);
    const disk = this.disk();
    if (file !== undefined) disk[`${folder}/${file}`] = cp.files[file];
    else {
      for (const p of Object.keys(this.files(folder))) if (!(p in cp.files)) delete disk[`${folder}/${p}`];
      for (const [p, text] of Object.entries(cp.files)) disk[`${folder}/${p}`] = text;
    }
    return { success: true, restored_to: cp.hash.slice(0, 8), reason: cp.message, directory: folder, ...(file !== undefined && { file }) };
  }
}

const lines = (text?: string) => {
  const out = text ? text.split("\n") : [];
  if (out.at(-1) === "") out.pop();
  return out;
};

type Op = { kind: " " | "-" | "+"; text: string; old: number; new: number };

/** A line diff by longest common subsequence: small files only. `old` and `new` are each line's 1-based number before it. */
function lineOps(a: string[], b: string[]): Op[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ kind: " ", text: a[i++], old: i, new: ++j });
    else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) ops.push({ kind: "+", text: b[j++], old: i + 1, new: j });
    else ops.push({ kind: "-", text: a[i++], old: i, new: j + 1 });
  }
  return ops;
}

/** Unified hunks with three lines of context, as git and difflib make them. */
function hunks(ops: Op[]): string[] {
  const changed = ops.flatMap((o, n) => (o.kind === " " ? [] : [n]));
  const groups: [number, number][] = [];
  for (const n of changed) {
    const last = groups.at(-1);
    if (last && n - 3 <= last[1] + 1) last[1] = Math.min(ops.length - 1, n + 3);
    else groups.push([Math.max(0, n - 3), Math.min(ops.length - 1, n + 3)]);
  }
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`);
  return groups.map(([s, e]) => {
    const part = ops.slice(s, e + 1);
    const olds = part.filter((o) => o.kind !== "+").length;
    const news = part.filter((o) => o.kind !== "-").length;
    return [`@@ -${range(part[0].old, olds)} +${range(part[0].new, news)} @@`, ...part.map((o) => `${o.kind}${o.text}`)].join("\n");
  });
}

const blob = (text?: string) => (text === undefined ? "0000000" : [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(7, "0").slice(0, 7));

/** One file's section of a git diff, from its text in the checkpoint (`before`) to its text now (`after`). */
function fileDiff(path: string, before?: string, after?: string) {
  const ops = lineOps(lines(before), lines(after));
  const head = [
    `diff --git a/${path} b/${path}`,
    ...(before === undefined ? ["new file mode 100644"] : after === undefined ? ["deleted file mode 100644"] : []),
    `index ${blob(before)}..${blob(after)}${before !== undefined && after !== undefined ? " 100644" : ""}`,
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
  ];
  return { section: [...head, ...hunks(ops)].join("\n"), insertions: ops.filter((o) => o.kind === "+").length, deletions: ops.filter((o) => o.kind === "-").length };
}

const PAINT = { file: "\x1b[38;2;218;165;32m", hunk: "\x1b[38;2;139;134;130m", minus: "\x1b[38;2;255;255;255;48;2;119;20;20m", plus: "\x1b[38;2;255;255;255;48;2;19;87;20m", dim: "\x1b[38;2;150;150;150m" };
const RESET = "\x1b[0m";

/** A file edit's `inline_diff` as Hermes draws it (`agent/display.py` `_render_inline_unified_diff` at `bf0203a`). */
export function inlineDiff(path: string, before: string | undefined, after: string): string {
  const body = hunks(lineOps(lines(before), lines(after))).flatMap((h) => h.split("\n"));
  const paint = (l: string) => `${l.startsWith("@@") ? PAINT.hunk : l.startsWith("-") ? PAINT.minus : l.startsWith("+") ? PAINT.plus : PAINT.dim}${l}${RESET}`;
  return ["  ┊ review diff", `${PAINT.file}a/${path} → b/${path}${RESET}`, ...body.map(paint)].join("\n");
}
