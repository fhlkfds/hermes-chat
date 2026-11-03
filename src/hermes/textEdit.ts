// Editing a Server file's text (ADR 0024): which files can be edited and how their bytes round-trip, the revision a
// save checks, the line diff the review shows, and the three-way merge offered when the file changed on the server.
import { looksBinary } from "./remoteFiles";

/** The biggest file the editor opens, and the most a save writes: the text preview's limit. */
export const EDIT_MAX_BYTES = 1024 * 1024;

/**
 * A file's text as the editor holds it: always with LF line ends and without a byte order mark. `eol` and `bom` say how
 * it is written back, so a save changes only what the owner changed.
 */
export type EditableText = { text: string; eol: "\n" | "\r\n"; bom: boolean };

/** The file's text for editing, or why it can't be edited here. Only UTF-8 text with one kind of line end is. */
export function decodeForEdit(bytes: Uint8Array): EditableText | { why: string } {
  if (bytes.length > EDIT_MAX_BYTES) return { why: `It's over ${EDIT_MAX_BYTES / 1024 / 1024} MB, the most the editor opens.` };
  if (looksBinary(bytes)) return { why: "It looks like a binary file, so there's no text to edit." };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { why: "It isn't UTF-8 text, so editing it here could change bytes you didn't touch." };
  }
  const bom = text.startsWith("﻿");
  if (bom) text = text.slice(1);
  if (/\r(?!\n)/.test(text)) return { why: "It has old Mac line ends (CR), which the editor would change." };
  const crlf = /\r\n/.test(text);
  if (crlf && /(^|[^\r])\n/.test(text)) return { why: "It mixes Windows (CRLF) and Unix (LF) line ends, which the editor would change." };
  return { text: crlf ? text.replace(/\r\n/g, "\n") : text, eol: crlf ? "\r\n" : "\n", bom };
}

/** The text a save writes: the edit with the file's own line ends and byte order mark. */
export function encodeEdit(text: string, eol: EditableText["eol"], bom: boolean): string {
  const lines = text.replace(/\r\n?/g, "\n");
  return (bom ? "﻿" : "") + (eol === "\r\n" ? lines.replace(/\n/g, "\r\n") : lines);
}

/** A file's revision: the SHA-256 of its bytes, in hex. Hermes has no revision of its own for a file. */
export async function revisionOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type DiffOp = { op: "same" | "del" | "add"; text: string };

/** Past this many changed lines, the diff stops looking for the shortest one and shows a whole replacement. */
const DIFF_MAX_EDITS = 4000;

/** The line-by-line difference from `a` to `b` (Myers's O(ND) diff, after the common start and end are set aside). */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text: string): DiffOp => ({ op: "same", text });
  return [...a.slice(0, start).map(same), ...myers(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(same)];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const del = (text: string): DiffOp => ({ op: "del", text });
  const add = (text: string): DiffOp => ({ op: "add", text });
  if (!n || !m) return [...a.map(del), ...b.map(add)];
  const max = Math.min(n + m, DIFF_MAX_EDITS);
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 1);
  // Each round's furthest reaches, kept only for diagonals -d..d, so memory grows with the edits, not the file.
  const trace: Int32Array[] = [];
  const at = (row: Int32Array, d: number, k: number) => row[k + d + 1];
  const down = (row: Int32Array, d: number, k: number) => k === -d || (k !== d && at(row, d, k - 1) < at(row, d, k + 1));
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    const row = v.slice(off - d - 1, off + d + 2);
    trace.push(row);
    for (let k = -d; k <= d; k += 2) {
      let x = down(row, d, k) ? at(row, d, k + 1) : at(row, d, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [...a.map(del), ...b.map(add)];
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const row = trace[d];
    const k = x - y;
    const prevK = down(row, d, k) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(row, d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ op: "same", text: a[--x] }), y--;
    if (d === 0) break;
    if (x === prevX) ops.push(add(b[--y]));
    else ops.push(del(a[--x]));
  }
  return ops.reverse();
}

/** One stretch of a diff to show: changed lines with up to `context` unchanged ones around them, and where it starts. */
export type Hunk = { oldStart: number; newStart: number; lines: DiffOp[] };

export function hunks(ops: DiffOp[], context = 3): Hunk[] {
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  const ranges: [number, number][] = [];
  ops.forEach((op, i) => {
    oldAt.push(o);
    newAt.push(n);
    if (op.op !== "add") o++;
    if (op.op !== "del") n++;
    if (op.op === "same") return;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  });
  return ranges.map(([from, to]) => ({ oldStart: oldAt[from], newStart: newAt[from], lines: ops.slice(from, to + 1) }));
}

/** A change one side made to the base: base lines `[start, end)` became `lines`. */
type Change = { start: number; end: number; lines: string[] };

function changes(base: string[], side: string[]): Change[] {
  const out: Change[] = [];
  let i = 0;
  let open: Change | undefined;
  for (const o of diffLines(base, side)) {
    if (o.op === "same") {
      open = undefined;
      i++;
      continue;
    }
    if (!open) out.push((open = { start: i, end: i, lines: [] }));
    if (o.op === "del") open.end = ++i;
    else open.lines.push(o.text);
  }
  return out;
}

/** The lines `side` has for base lines `[start, end)`, given that every one of its changes there lies inside. */
function sideText(base: string[], start: number, end: number, own: Change[]): string[] {
  const out: string[] = [];
  let i = start;
  for (const c of own) {
    append(out, base, i, c.start);
    append(out, c.lines);
    i = c.end;
  }
  append(out, base, i, end);
  return out;
}

/** Appends `from[start..end)` to `out` one by one: spreading a big array into `push` overflows the call stack. */
function append(out: string[], from: string[], start = 0, end = from.length) {
  for (let i = start; i < end; i++) out.push(from[i]);
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

export const MINE_MARK = "<<<<<<< your edit";
export const SPLIT_MARK = "=======";
export const THEIRS_MARK = ">>>>>>> on the server now";

/**
 * Merges the owner's edit and the server's newer text, both made from `base`, line by line. Where only one side
 * changed a stretch, it wins. Where both changed the same or neighbouring lines differently, both are kept between
 * conflict markers for the owner to settle. `conflicts` counts those stretches.
 */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflicts: number } {
  const b = base.split("\n");
  const ours = changes(b, mine.split("\n")).map((c) => ({ ...c, side: "mine" as const }));
  const their = changes(b, theirs.split("\n")).map((c) => ({ ...c, side: "theirs" as const }));
  const all = [...ours, ...their].sort((p, q) => p.start - q.start || p.end - q.end);
  const out: string[] = [];
  let i = 0;
  let conflicts = 0;
  for (let n = 0; n < all.length; ) {
    // A region: changes that overlap or touch, from either side. They are sorted, so the first starts it.
    const start = all[n].start;
    let end = all[n].end;
    const group = [all[n++]];
    while (n < all.length && all[n].start <= end) {
      end = Math.max(end, all[n].end);
      group.push(all[n++]);
    }
    append(out, b, i, start);
    const mineHere = group.filter((c) => c.side === "mine");
    const theirsHere = group.filter((c) => c.side === "theirs");
    const m = sideText(b, start, end, mineHere);
    const t = sideText(b, start, end, theirsHere);
    if (!theirsHere.length) append(out, m);
    else if (!mineHere.length) append(out, t);
    // Line by line: a deleted line and one made blank both join to "", but aren't the same change.
    else if (sameLines(m, t)) append(out, m);
    else {
      conflicts++;
      out.push(MINE_MARK);
      append(out, m);
      out.push(SPLIT_MARK);
      append(out, t);
      out.push(THEIRS_MARK);
    }
    i = end;
  }
  append(out, b, i);
  return { text: out.join("\n"), conflicts };
}
