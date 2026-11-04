// The Repository screen's model: a Git checkout on the Hermes server, read through the owner's own ssh by a helper
// the app sends there (src-tauri/src/repo_git.rs, repo_git_helper.py, ADR 0034). This file holds what the helper
// answers, how its changes are grouped for the screen, and how a diff is read. The screen is src/ui/Repository.tsx.

/** One line of `git status --porcelain=v2`, as the helper reports it. Paths are relative to the checkout's top. */
export type Entry = {
  kind: "ordinary" | "renamed" | "copied" | "unmerged" | "untracked";
  /** The index's status code against HEAD ("." for none), and the working tree's against the index. */
  x: string;
  y: string;
  /** A submodule. */
  sub: boolean;
  modes?: string[];
  path: string;
  /** A rename's or copy's path in HEAD. */
  origPath?: string;
  /** Lines added and removed, staged and unstaged; null for a binary file; absent when unknown. */
  staged?: [number, number] | null;
  unstaged?: [number, number] | null;
  /** An untracked file whose first 8000 bytes hold a NUL, as Git decides. */
  binary?: boolean;
};

export type Status = {
  /** The top folder of the checkout: every path is relative to it, and every later request names it. */
  top: string;
  gitDir: string;
  branch: {
    /** HEAD's commit, or null before the first commit. */
    oid: string | null;
    /** The branch checked out, or null when HEAD is detached. */
    head: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
  };
  /** A merge, rebase, cherry-pick, revert or bisect waiting to be finished. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null;
  entries: Entry[];
  /** More than 5000 changed files: the rest aren't listed. */
  truncated: boolean;
};

/** Which changes of a file a diff shows. */
export type Side = "staged" | "unstaged" | "untracked" | "conflict";

export type DiffReply = {
  diff: string;
  /** Cut at 2 MiB. */
  truncated: boolean;
  /** Some bytes weren't UTF-8, so the text isn't byte for byte what Git printed. */
  lossy: boolean;
  bytes: number;
  /** SHA-256 of the diff's bytes. */
  sha: string;
  /** For a conflict, which index stages exist: 1 the common base, 2 ours, 3 theirs. */
  stages: number[];
};

/** What the screen asks the helper for. Mirrors `Request` in repo_git.rs; nothing else can be asked. */
export type RepoRequest =
  | { op: "status"; repo: string }
  | { op: "diff"; repo: string; path: string; origPath?: string; side: Side; context: number };

/** Rust's one command: send `request` to the helper through ssh to `target`. Rejects with a `RepoFailure`. */
export type RepoApi = { run(target: string, request: RepoRequest): Promise<unknown> };

/**
 * A failure the screen tells apart by `kind`:
 * - ssh: "bad-target", "spawn", "ssh-auth", "ssh-host-key", "ssh-unreachable", "ssh"
 * - the server: "unsupported" (no python3 or git), "timeout", "bad-reply"
 * - the repository: "bad-path", "not-found", "not-repo", "stale", "git", "internal"
 * `output` is what ssh or Git printed, shown as it is.
 */
export class RepoFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly output = "",
  ) {
    super(message);
  }
}

export function asRepoFailure(e: unknown): RepoFailure {
  if (e instanceof RepoFailure) return e;
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const o = e as { kind: unknown; message: unknown; output?: unknown };
    return new RepoFailure(String(o.kind), String(o.message), typeof o.output === "string" ? o.output : "");
  }
  return new RepoFailure("internal", e instanceof Error ? e.message : String(e));
}

/** What to do about a failure, beyond what it says, or undefined when there's nothing to add. */
export function failureHint(f: RepoFailure): string | undefined {
  switch (f.kind) {
    case "ssh-auth":
      return "The Repository screen runs ssh without a terminal, so it can't ask for a passphrase. Add the key to your SSH agent (ssh-add), then try again.";
    case "ssh-host-key":
      return "Open the Terminal, connect to the same target, and accept the host key there.";
    case "bad-target":
      return "Change the SSH target above.";
    case "unsupported":
      return "The server needs OpenSSH, python3 (3.8 or newer) and git on the PATH a non-interactive ssh gets.";
    case "timeout":
      return "Nothing was changed by reading. Refresh to try again.";
    case "stale":
      return "Refresh to see the repository as it is now.";
    default:
      return undefined;
  }
}

/** A change of one file on one side, as the screen lists it. */
export type Change = {
  /** Unique among the listed changes. */
  key: string;
  side: Side;
  path: string;
  origPath?: string;
  /** One letter: M, A, D, R, C, T, U (conflict) or ? (untracked). */
  code: string;
  /** What the code means, in words. */
  label: string;
  /** Lines added and removed, when known. */
  counts?: [number, number];
  binary: boolean;
  submodule: boolean;
};

const CODE_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Updated but unmerged",
};

/** Git's two-letter codes for a merge conflict. */
const CONFLICT_LABEL: Record<string, string> = {
  DD: "Deleted on both sides",
  AU: "Added by us",
  UD: "Deleted by them",
  UA: "Added by them",
  DU: "Deleted by us",
  AA: "Added on both sides",
  UU: "Changed on both sides",
};

export type Grouped = { conflicts: Change[]; staged: Change[]; unstaged: Change[]; untracked: Change[] };

/** The changes in a status, by where they are: conflicts, staged (in the index), unstaged (in the working tree) and untracked. */
export function group(s: Status): Grouped {
  const out: Grouped = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const e of s.entries) {
    if (e.kind === "untracked") {
      out.untracked.push({ key: `untracked:${e.path}`, side: "untracked", path: e.path, code: "?", label: "Untracked", binary: !!e.binary, submodule: false });
      continue;
    }
    if (e.kind === "unmerged") {
      const xy = e.x + e.y;
      out.conflicts.push({ key: `conflict:${e.path}`, side: "conflict", path: e.path, code: "U", label: CONFLICT_LABEL[xy] ?? `Conflict (${xy})`, binary: false, submodule: e.sub });
      continue;
    }
    if (e.x !== ".") {
      out.staged.push({
        key: `staged:${e.path}`,
        side: "staged",
        path: e.path,
        ...(e.origPath && { origPath: e.origPath }),
        code: e.x,
        label: CODE_LABEL[e.x] ?? e.x,
        ...(e.staged && { counts: e.staged }),
        binary: e.staged === null,
        submodule: e.sub,
      });
    }
    if (e.y !== ".") {
      out.unstaged.push({
        key: `unstaged:${e.path}`,
        side: "unstaged",
        path: e.path,
        code: e.y,
        label: CODE_LABEL[e.y] ?? e.y,
        ...(e.unstaged && { counts: e.unstaged }),
        binary: e.unstaged === null,
        submodule: e.sub,
      });
    }
  }
  return out;
}

/** The branch line: "main", or "detached at 1a2b3c4", or "no commits yet on main". */
export function branchLabel(b: Status["branch"]): string {
  if (b.detached) return b.oid ? `detached at ${b.oid.slice(0, 7)}` : "detached";
  if (!b.oid) return `${b.head ?? "?"} (no commits yet)`;
  return b.head ?? "?";
}

/** How the branch stands against its upstream, in words. */
export function upstreamLabel(b: Status["branch"]): string {
  if (b.detached) return "No branch, so nothing to compare with.";
  if (!b.upstream) return "No upstream branch set.";
  if (b.ahead === null || b.behind === null) return `${b.upstream} (gone from the remote, or never fetched)`;
  if (!b.ahead && !b.behind) return `Up to date with ${b.upstream}, as of the last fetch.`;
  const parts = [b.ahead ? `${b.ahead} ahead` : "", b.behind ? `${b.behind} behind` : ""].filter(Boolean);
  return `${parts.join(", ")} of ${b.upstream}, as of the last fetch.`;
}

export const OPERATION_LABEL: Record<NonNullable<Status["operation"]>, string> = {
  merge: "A merge is in progress.",
  rebase: "A rebase is in progress.",
  "cherry-pick": "A cherry-pick is in progress.",
  revert: "A revert is in progress.",
  bisect: "A bisect is in progress.",
};

// ── diffs ───────────────────────────────────────────────────────────────────

export type DiffLine = {
  kind: "context" | "add" | "del" | "note";
  text: string;
  /** Line numbers in the old and new file, where the line has one. */
  oldNo?: number;
  newNo?: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  /** A conflict's combined diff (`diff --cc`): two columns of signs, no single old file. */
  combined: boolean;
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  rename?: { from: string; to: string; similarity?: string };
  copy?: { from: string; to: string };
  mode?: { from: string; to: string };
  /** A file whose mode alone is shown, such as a new empty file. */
  newMode?: string;
  submodule: boolean;
  hunks: DiffHunk[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads one file's unified diff, as the helper returns it. An empty string is no change. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { combined: false, binary: false, newFile: false, deletedFile: false, submodule: false, hunks: [] };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let renameFrom: string | undefined;
  let copyFrom: string | undefined;
  let oldMode: string | undefined;
  let similarity: string | undefined;
  for (const line of lines) {
    if (hunk) {
      if (out.combined) {
        if (line.startsWith("@@@")) hunk = undefined;
        else {
          const signs = line.slice(0, 2);
          hunk.lines.push({ kind: signs.includes("+") ? "add" : signs.includes("-") ? "del" : line.startsWith("\\") ? "note" : "context", text: line.slice(2) });
          continue;
        }
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        continue;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        continue;
      } else if (line.startsWith("\\")) {
        hunk.lines.push({ kind: "note", text: line.slice(2) });
        continue;
      } else if (line === "") {
        // A blank context line whose leading space was lost.
        hunk.lines.push({ kind: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
        continue;
      } else hunk = undefined;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) out.combined = true;
    else if (line.startsWith("new file mode ")) {
      out.newFile = true;
      out.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) out.deletedFile = true;
    else if (line.startsWith("old mode ")) oldMode = line.slice("old mode ".length);
    else if (line.startsWith("new mode ") && oldMode) out.mode = { from: oldMode, to: line.slice("new mode ".length) };
    else if (line.startsWith("similarity index ")) similarity = line.slice("similarity index ".length);
    else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ") && renameFrom !== undefined) out.rename = { from: renameFrom, to: line.slice("rename to ".length), ...(similarity && { similarity }) };
    else if (line.startsWith("copy from ")) copyFrom = line.slice("copy from ".length);
    else if (line.startsWith("copy to ") && copyFrom !== undefined) out.copy = { from: copyFrom, to: line.slice("copy to ".length) };
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") out.binary = true;
    else if (line.startsWith("Subproject commit ") || line.startsWith("-Subproject commit ") || line.startsWith("+Subproject commit ")) out.submodule = true;
    else if (out.combined && line.startsWith("@@@")) {
      hunk = { header: line, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] };
      out.hunks.push(hunk);
    } else {
      const m = HUNK.exec(line);
      if (m) {
        hunk = {
          header: line,
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        };
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        out.hunks.push(hunk);
      }
    }
  }
  return out;
}

/** Lines added and removed in a parsed diff. */
export function diffCounts(d: ParsedDiff): [number, number] {
  let add = 0;
  let del = 0;
  for (const h of d.hunks) for (const l of h.lines) l.kind === "add" ? add++ : l.kind === "del" ? del++ : undefined;
  return [add, del];
}

/** How many lines of context a diff shows. "Whole file" asks for as many as the helper allows. */
export const CONTEXT_CHOICES: { label: string; lines: number }[] = [
  { label: "No context", lines: 0 },
  { label: "3 lines", lines: 3 },
  { label: "10 lines", lines: 10 },
  { label: "25 lines", lines: 25 },
  { label: "Whole file", lines: 1_000_000 },
];

// ── where ───────────────────────────────────────────────────────────────────

/** The repository folder last opened, and the SSH target the screen uses (else the Terminal's, else the sign-in's). */
export const REPO_PATH_KEY = "hermes-chat.repo-path";
export const REPO_RECENT_KEY = "hermes-chat.repo-recent";
export const REPO_TARGET_KEY = "hermes-chat.repo-target";

export function repoTarget(signIn: { mode: "ssh" | "url"; sshTarget: string }, saved: string | null, terminalSaved: string | null): string {
  if (saved?.trim()) return saved.trim();
  if (terminalSaved?.trim()) return terminalSaved.trim();
  return signIn.mode === "ssh" ? signIn.sshTarget.trim() : "";
}

/** The folders opened lately, newest first, at most five. */
export function remember(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, 5);
}

export function readRecent(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Checks a reply's shape just enough that the screen can't be broken by an older or different helper. */
export function asStatus(v: unknown): Status {
  const s = v as Status;
  if (!s || typeof s.top !== "string" || !s.branch || !Array.isArray(s.entries)) throw new RepoFailure("bad-reply", "The server's answer wasn't a repository status.");
  return s;
}

export function asDiff(v: unknown): DiffReply {
  const d = v as DiffReply;
  if (!d || typeof d.diff !== "string") throw new RepoFailure("bad-reply", "The server's answer wasn't a diff.");
  return { ...d, stages: Array.isArray(d.stages) ? d.stages : [] };
}
