// Worktrees of a repository on the Hermes server, made and managed through the Repository screen's helper over the
// owner's ssh (src-tauri/src/repo_worktrees_helper.py, ADR 0042). This file holds the requests, what the helper
// answers, and the rules the screen applies on top: what stops a removal, and how far a setup has got. The screen is
// src/ui/Worktrees.tsx.
import { RepoFailure } from "./repo";

/** A chat recorded as working in a worktree: the connection and profile it's in, its stored id, and its title. */
export type ChatRef = { scope: string; chat: string; title: string; at?: number };

/** One `.worktreeinclude` entry: copied (a file) or linked (a folder) from the repository's own checkout, once. */
export type SetupStep = {
  entry: string;
  action: "copy" | "link" | "skip";
  state: "pending" | "done" | "failed" | "skipped";
  message: string;
  at?: number;
};

/** Hermes Chat's record of a worktree it made, kept beside the repository on the server. */
export type WorktreeRecord = {
  id: string;
  path: string;
  branch: string;
  newBranch: boolean;
  base: string;
  baseSha: string;
  setup: SetupStep[];
  state: "creating" | "ready" | "removing" | "removed" | "restoring";
  protected: boolean;
  chats: ChatRef[];
  createdAt: number;
  createdBy: string;
  removed?: {
    at: number;
    head: string | null;
    branch: string | null;
    /** The recovery ref the changes were kept in, if there were any. `staged`: the commit holding what was staged,
     * when it differed from HEAD; `commit` (the working tree) is on top of it. */
    kept: { ref: string; commit: string; staged?: string | null } | null;
    files: number;
    unpushed: number;
  } | null;
};

export type Counts = { staged: number; changed: number; untracked: number; conflicts: number };

/** One worktree, as `git worktree list` reports it, with what the helper found in it. */
export type WorktreeRow = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  /** Its lock reason ("" for none given), or null when it isn't locked. */
  locked: string | null;
  prunable: boolean;
  main: boolean;
  /** The checkout the screen has open. */
  current: boolean;
  missing: boolean;
  record: WorktreeRecord | null;
  changes?: Counts;
  /** Commits no remote-tracking branch has; null without a remote. */
  unpushed?: number | null;
  error?: string;
};

export type WorktreeList = {
  top: string;
  main: string;
  hasRemote: boolean;
  /** A newer Hermes Chat keeps the record: it's shown, never changed. */
  newer: boolean;
  worktrees: WorktreeRow[];
  unfinished: WorktreeRecord[];
  removed: WorktreeRecord[];
  /** The record's path on the server, which Hermes reads to show it's on the same server. */
  registry: string;
};

export type WorktreePlan = {
  repo: string;
  path: string;
  branch: string;
  newBranch: boolean;
  base: string;
  baseSha: string;
  subject: string;
  setup: SetupStep[];
  stamp: string;
  source: Counts & { path: string };
  submodules: string[];
  submoduleCount: number;
};

export type Blocker = { kind: string; message: string };

export type RemovalFacts = {
  path: string;
  blockers: Blocker[];
  files: { status: "staged" | "changed" | "both" | "conflict" | "untracked"; path: string }[];
  fileCount?: number;
  ignored: string[];
  unpushed: { sha: string; subject: string }[];
  hasRemote?: boolean;
  head: string | null;
  branch: string | null;
  keepHead: boolean;
  stamp: string;
};

/** What the screen can ask about worktrees. Mirrors the `Worktree*` requests in repo_git.rs. */
export type WorktreeRequest =
  | { op: "worktreeList"; repo: string }
  | { op: "worktreePlan"; repo: string; branch: string; newBranch: boolean; base?: string }
  | { op: "worktreeCreate"; repo: string; id: string; branch: string; newBranch: boolean; base?: string; stamp: string; by: string }
  | { op: "worktreeSetup"; repo: string; id: string; step: number }
  | { op: "worktreeAttach"; repo: string; id: string; chat: ChatRef }
  | { op: "worktreeDetach"; repo: string; id: string; scope: string; chat: string }
  | { op: "worktreeProtect"; repo: string; id: string; protected: boolean }
  | { op: "worktreeForget"; repo: string; id: string }
  | { op: "worktreeRemoval"; repo: string; id: string }
  | { op: "worktreeRemove"; repo: string; id: string; stamp: string }
  | { op: "worktreeRestore"; repo: string; id: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The helper's answer, if it has the fields named: an older helper or something else answering is `bad-reply`. */
function shaped<T>(v: unknown, ...fields: string[]): T {
  if (!isObj(v) || fields.some((f) => !(f in v))) throw new RepoFailure("bad-reply", "The server's answer about worktrees wasn't one this app understands.");
  return v as T;
}

export const asList = (v: unknown) => shaped<WorktreeList>(v, "top", "main", "worktrees", "unfinished", "removed", "registry");
export const asPlan = (v: unknown) => shaped<WorktreePlan>(v, "path", "branch", "baseSha", "stamp", "setup", "source");
export const asRemoval = (v: unknown) => shaped<RemovalFacts>(v, "path", "blockers", "files", "ignored", "unpushed", "stamp");
export const asRecord = (v: unknown) => shaped<{ record: WorktreeRecord; output?: string }>(v, "record");

/** A lost answer: whether the server did it isn't known until it's read again. Writes are never sent again on their own. */
export const answerLost = (f: RepoFailure) => f.kind === "timeout" || f.kind === "bad-reply" || f.kind === "spawn" || f.kind.startsWith("ssh");

/** The steps still to run, in order: pending ones, and failed ones being tried again. */
export const stepsToRun = (r: WorktreeRecord) => r.setup.flatMap((s, i) => (s.state === "pending" || s.state === "failed" ? [i] : []));

export function setupSummary(r: WorktreeRecord): { done: number; total: number; failed: SetupStep[]; pending: number } {
  const real = r.setup.filter((s) => s.action !== "skip");
  return {
    done: real.filter((s) => s.state === "done").length,
    total: real.length,
    failed: real.filter((s) => s.state === "failed"),
    pending: real.filter((s) => s.state === "pending").length,
  };
}

export function countsLabel(c?: Counts): string {
  if (!c) return "";
  const parts = [
    c.conflicts && `${c.conflicts} conflicted`,
    c.staged && `${c.staged} staged`,
    c.changed && `${c.changed} changed`,
    c.untracked && `${c.untracked} untracked`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No changes";
}

export const dirty = (c?: Counts) => !!c && c.staged + c.changed + c.untracked + c.conflicts > 0;

/**
 * Everything that stops a removal: the helper's own blockers (protected, chats recorded, another tool's lock, a
 * submodule, an operation in progress), and the chats Hermes says work in the folder, from any client. Archived chats
 * are listed but don't block. A Hermes that can't be asked blocks too: a chat working there can't be ruled out.
 */
export function removalBlockers(facts: RemovalFacts, hermes: { chats: { id: string; title: string; archived: boolean }[]; more: boolean } | Error | undefined): Blocker[] {
  const out = [...facts.blockers];
  if (hermes === undefined) out.push({ kind: "hermes", message: "Hermes isn't connected, so the chats working in this folder can't be checked. Connect first." });
  else if (hermes instanceof Error) out.push({ kind: "hermes", message: `Couldn't ask Hermes which chats work in this folder: ${hermes.message}` });
  else {
    const live = hermes.chats.filter((c) => !c.archived);
    if (live.length || hermes.more)
      out.push({
        kind: "hermes-chats",
        message: `Hermes has ${hermes.more ? "100 or more" : live.length} chat${live.length === 1 && !hermes.more ? "" : "s"} working in this folder: ${live
          .slice(0, 5)
          .map((c) => `“${c.title}”`)
          .join(", ")}${live.length > 5 ? "…" : ""}. Archive or delete them first, or keep the worktree.`,
      });
  }
  return out;
}

/** The branch name as a folder name, as the helper makes it (`folder_name`), for the preview before it's asked. */
export const folderName = (branch: string) =>
  branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .replace(/[.-]+$/, "");

/** A managed worktree as the server's record has it: its folder, the record's path, and its id there. */
export type ServerWorktree = { path: string; registry: string; id: string };

/** Where a chat was started in a worktree: the SSH target and repository to reach its record, and what to show. */
export type WorktreeLaunch = ServerWorktree & { target: string; repo: string; branch: string };

/**
 * Checks that Hermes is on the same server as the worktree: it reads the worktree's record, at the path the helper
 * gave, and finds this worktree in it under its random id. The Repository screen's SSH target can name another
 * computer than the one Hermes runs on, and the same folder can exist on both. Throws when Hermes can't read it, or
 * reads another record.
 */
export async function sameServer(readText: (path: string) => Promise<string>, w: ServerWorktree): Promise<void> {
  const elsewhere = `Hermes can't see this worktree's record (${w.registry}), so it may be running on another computer than the Repository screen's SSH target`;
  let text: string;
  try {
    text = await readText(w.registry);
  } catch (e) {
    throw new Error(`${elsewhere}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let rec: unknown;
  try {
    rec = (JSON.parse(text) as { worktrees?: Record<string, unknown> }).worktrees?.[w.id];
  } catch {
    rec = undefined;
  }
  if (!isObj(rec) || rec.path !== w.path) throw new Error(`${elsewhere}. Nothing was done.`);
}

// Which chats this computer started in a worktree, so a chat can show its branch and folder (`hermes-chat.chat-
// worktrees`, per connection and profile). The server's record is what counts; this is only for showing.
const CHAT_WORKTREES = "hermes-chat.chat-worktrees";
type Shown = { path: string; branch: string };

function readShown(): Record<string, Shown> {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_WORKTREES) ?? "null");
    return isObj(v) && v.v === 1 && isObj(v.chats) ? (v.chats as Record<string, Shown>) : {};
  } catch {
    return {};
  }
}

export function rememberChatWorktree(scope: string, chatId: string, w: Shown) {
  const chats = { ...readShown(), [`${scope}\n${chatId}`]: { path: w.path, branch: w.branch } };
  try {
    localStorage.setItem(CHAT_WORKTREES, JSON.stringify({ v: 1, chats }));
  } catch {
    // Only for showing: the server's record still has it.
  }
}

export const chatWorktree = (scope: string, chatId: string): Shown | undefined => readShown()[`${scope}\n${chatId}`];
