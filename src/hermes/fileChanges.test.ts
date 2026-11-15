import { describe, expect, it } from "vitest";
import type { Item } from "./model";
import { checkpointBefore, handEdit, parseCheckpointList, parseRollbackDiff, placeIn, planFiles, replyFiles, type Checkpoint, type FileEdit, type ReplyFiles } from "./fileChanges";

const FOLDER = "/tmp/work";
// `inline_diff` as Hermes `bf0203a` sent it for a patch of b.txt (measured 2026-11-15), the path absolute.
const B_DIFF =
  "  ┊ review diff\n\x1b[38;2;218;165;32ma//tmp/work/b.txt → b//tmp/work/b.txt\x1b[0m\n\x1b[38;2;139;134;130m@@ -1 +1 @@\x1b[0m\n" +
  "\x1b[38;2;255;255;255;48;2;119;20;20m-beta original\x1b[0m\n\x1b[38;2;255;255;255;48;2;19;87;20m+beta patched by the bot\x1b[0m";
const REFUSED = JSON.stringify({ error: "Refusing to overwrite a.txt: it exists but this task has not seen its full current content.", stale_write_blocked: true });

const user = (id: string, at?: number): Item => ({ kind: "user", id, text: "edit the files", ...(at !== undefined && { at: at * 1000 }) });
const reply = (id: string, at?: number): Item => ({ kind: "assistant", id, text: "Done.", ...(at !== undefined && { at: at * 1000 }) });
type Tool = Extract<Item, { kind: "tool" }>;
const write = (id: string, path: string, content: string, result = '{"bytes_written": 3}'): Tool => ({
  kind: "tool",
  id,
  name: "write_file",
  args: { path, content },
  status: "done",
  result,
});
const patch = (id: string, path: string, inlineDiff?: string): Tool => ({
  kind: "tool",
  id,
  name: "patch",
  args: { path, old_string: "beta original", new_string: "beta patched by the bot" },
  status: "done",
  result: '{"success": true}',
  ...(inlineDiff && { inlineDiff }),
});

describe("replyFiles", () => {
  it("counts each file a finished reply edited once, in the order it first edited them", () => {
    const items = [user("u1", 100.4), write("t1", "a.txt", "a"), patch("t2", "/tmp/work/b.txt", B_DIFF), write("t3", "./a.txt", "a2"), reply("r1", 101.2)];
    const [r] = replyFiles(items, FOLDER);
    expect(r).toMatchObject({ replyId: "r1", startedAt: 100.4, endedAt: 101.2, paths: ["a.txt", "/tmp/work/b.txt"] });
    expect(r.edits.map((e) => e.path)).toEqual(["a.txt", "/tmp/work/b.txt", "./a.txt"]);
  });

  it("doesn't count an edit Hermes refused, one that failed, or one still running", () => {
    const failed: Tool = { ...patch("t3", "c.txt"), result: '{"success": false, "error": "old_string not found"}' };
    const running: Tool = { ...write("t4", "d.txt", "d"), status: "running" };
    const items = [user("u1", 100), write("t1", "a.txt", "a", REFUSED), patch("t2", "b.txt", B_DIFF), failed, running, reply("r1", 101)];
    expect(replyFiles(items, FOLDER)[0].paths).toEqual(["b.txt"]);
  });

  it("has nothing for a reply with no file edit, or one with no time yet", () => {
    const items = [user("u1", 100), reply("r1", 101), user("u2", 102), patch("t1", "b.txt", B_DIFF), reply("r2")];
    expect(replyFiles(items, FOLDER)).toEqual([]);
  });

  it("gives each reply the end of the turn before, or that turn's start when its end isn't known", () => {
    const items = [user("u1", 100), reply("r1", 101.5), user("u2", 102), patch("t1", "b.txt", B_DIFF), reply("r2", 103), user("u3", 104), reply("r3"), user("u4", 105), patch("t2", "b.txt"), reply("r4", 106)];
    expect(replyFiles(items, FOLDER).map((r) => [r.replyId, r.prevEndedAt])).toEqual([
      ["r2", 101.5],
      ["r4", 105],
    ]);
  });
});

const turn = (over: Partial<ReplyFiles> = {}): ReplyFiles => ({ replyId: "r", startedAt: 100.4, endedAt: 104.6, edits: [], paths: [], ...over });
const cp = (hash: string, at: number, reason = "before write_file"): Checkpoint => ({ hash, at, reason });

describe("checkpointBefore", () => {
  it("takes the oldest checkpoint from the seconds the reply ran in", () => {
    const list = [cp("c5", 106), cp("c4", 105), cp("c3", 103), cp("c2", 100), cp("c1", 99)];
    expect(checkpointBefore(list, turn())).toEqual({ kind: "found", checkpoint: cp("c2", 100) });
  });

  it("of two in one second takes the one listed later, which Hermes took first", () => {
    expect(checkpointBefore([cp("new", 101), cp("old", 101)], turn())).toMatchObject({ checkpoint: { hash: "old" } });
  });

  it("skips the snapshot Hermes takes before a restore", () => {
    expect(checkpointBefore([cp("c2", 102), cp("snap", 101, "pre-rollback snapshot (restoring to 0a1b2c3d)")], turn())).toMatchObject({ checkpoint: { hash: "c2" } });
  });

  it("finds none when Hermes no longer keeps one from the reply's time", () => {
    expect(checkpointBefore([cp("later", 106), cp("earlier", 99)], turn())).toEqual({ kind: "none" });
  });

  it("won't pick one from the second the previous reply ended in", () => {
    const list = [cp("c2", 101), cp("c1", 100)];
    expect(checkpointBefore(list, turn({ prevEndedAt: 100.2 }))).toEqual({ kind: "ambiguous" });
    expect(checkpointBefore(list, turn({ prevEndedAt: 98.7 }))).toEqual({ kind: "found", checkpoint: cp("c1", 100) });
  });

  it("bounds a turn Hermes started by the end of the one before", () => {
    const list = [cp("c2", 103), cp("c1", 98)];
    expect(checkpointBefore(list, turn({ startedAt: undefined, prevEndedAt: 101.5 }))).toEqual({ kind: "found", checkpoint: cp("c2", 103) });
  });
});

describe("parseCheckpointList", () => {
  it("reads Hermes's rows, its times as whole seconds", () => {
    const answer = { enabled: true, checkpoints: [{ hash: "46e4ab858b63630394c3dfc11c5332e125ab0e5a", timestamp: "2026-11-15T22:25:22Z", message: "before write_file" }, { hash: "x", timestamp: "now" }] };
    expect(parseCheckpointList(answer)).toEqual({ enabled: true, checkpoints: [{ hash: "46e4ab858b63630394c3dfc11c5332e125ab0e5a", at: Date.UTC(2026, 10, 15, 22, 25, 22) / 1000, reason: "before write_file" }] });
    expect(parseCheckpointList({ enabled: false, checkpoints: [] })).toEqual({ enabled: false, checkpoints: [] });
    expect(parseCheckpointList({ checkpoints: [] })).toBeUndefined();
  });
});

describe("parseRollbackDiff", () => {
  // As Hermes `bf0203a` answered (measured), with a created file.
  const stat = "b.txt | 2 +-\n c.txt | 1 +\n .../deeply/nested/path/file.txt | 4 ++--\n 3 files changed, 4 insertions(+), 3 deletions(-)";
  const b = "diff --git a/b.txt b/b.txt\nindex af0b8cf..ef66662 100644\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-beta original\n+beta patched by the bot";
  const c = "diff --git a/c.txt b/c.txt\nnew file mode 100644\nindex 0000000..93cf0c6\n--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1 @@\n+a file the bot created";

  it("lists every file in the stat, with its section and whether it is new", () => {
    const parsed = parseRollbackDiff(stat, `${b}\n${c}`);
    expect(parsed.cut).toBe(false);
    expect(parsed.files).toEqual([
      { path: "b.txt", created: false, section: b },
      { path: "c.txt", created: true, section: c },
      { path: ".../deeply/nested/path/file.txt", created: false },
    ]);
  });

  it("says when the server cut the diff", () => {
    expect(parseRollbackDiff(stat, `${b}\n${"+x\n".repeat(2000)}`.slice(0, 4000)).cut).toBe(true);
  });

  it("has no files for an empty answer", () => {
    expect(parseRollbackDiff("", "")).toEqual({ files: [], cut: false });
  });
});

describe("handEdit", () => {
  const written: FileEdit = { path: "a.txt", tool: "write_file", content: "alpha\n" };
  const patched: FileEdit = { path: "b.txt", tool: "patch", newString: "beta patched by the bot", inlineDiff: B_DIFF };

  it("takes a written file as left only when it is exactly what was written", () => {
    expect(handEdit("alpha\n", written)).toBe("as-left");
    expect(handEdit("alpha\nmine\n", written)).toBe("edited");
  });

  it("takes a patched file as left while it still holds each hunk's new text", () => {
    expect(handEdit("first\nbeta patched by the bot\nlast\n", patched)).toBe("as-left");
    expect(handEdit("beta patched by me\n", patched)).toBe("edited");
  });

  it("can't tell when the file couldn't be read whole, or Hermes cut its diff", () => {
    expect(handEdit(undefined, written)).toBe("unknown");
    const cut = `${B_DIFF}\n\x1b[38;2;139;134;130m… 40 more lines omitted\x1b[0m`;
    expect(handEdit("beta patched by the bot\n", { ...patched, inlineDiff: cut })).toBe("unknown");
  });

  it("falls back to a patch's new text when Hermes drew no diff", () => {
    const bare: FileEdit = { path: "b.txt", tool: "patch", newString: "beta patched by the bot" };
    expect(handEdit("beta patched by the bot\n", bare)).toBe("as-left");
    expect(handEdit("beta\n", bare)).toBe("unknown");
  });
});

describe("placeIn", () => {
  it("places a path inside the chat's folder, and nothing outside it", () => {
    expect(placeIn(FOLDER, "b.txt")).toEqual({ rel: "b.txt", abs: "/tmp/work/b.txt" });
    expect(placeIn(`${FOLDER}/`, "./src/../b.txt")).toEqual({ rel: "b.txt", abs: "/tmp/work/b.txt" });
    expect(placeIn(FOLDER, "/tmp/work/sub/c.txt")).toEqual({ rel: "sub/c.txt", abs: "/tmp/work/sub/c.txt" });
    for (const outside of ["/etc/hosts", "../x", "~/notes.txt", "/tmp/workshop/a"]) expect(placeIn(FOLDER, outside), outside).toBeUndefined();
    expect(placeIn(undefined, "b.txt")).toBeUndefined();
  });
});

describe("planFiles", () => {
  const stat = "a.txt | 2 +-\n b.txt | 2 +-\n c.txt | 1 +\n 3 files changed";
  const bSection = "diff --git a/b.txt b/b.txt\nindex af0b8cf..ef66662 100644\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-beta original\n+beta patched by the bot";
  const cSection = "diff --git a/c.txt b/c.txt\nnew file mode 100644\n--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1 @@\n+new";
  const diff = `${bSection}\n${cSection}`;

  it("says what undoing each of a reply's files would do", () => {
    const items = [user("u1", 100), write("t1", "a.txt", "alpha\n"), patch("t2", "b.txt", B_DIFF), write("t3", "c.txt", "new"), write("t4", "d.txt", "same"), write("t5", "/etc/motd", "hi"), reply("r1", 101)];
    const [r] = replyFiles(items, FOLDER);
    const texts = new Map([
      ["/tmp/work/a.txt", "alpha\nand a line of mine\n"],
      ["/tmp/work/b.txt", "beta patched by the bot\n"],
    ]);
    expect(planFiles(r, items, FOLDER, parseRollbackDiff(stat, diff), texts)).toEqual([
      { state: "undoable", path: "a.txt", rel: "a.txt", abs: "/tmp/work/a.txt", handEdit: "edited", laterReply: false },
      { state: "undoable", path: "b.txt", rel: "b.txt", abs: "/tmp/work/b.txt", handEdit: "as-left", laterReply: false, section: bSection },
      { state: "created", path: "c.txt", rel: "c.txt", abs: "/tmp/work/c.txt", section: cSection },
      { state: "unchanged", path: "d.txt", rel: "d.txt", abs: "/tmp/work/d.txt" },
      { state: "outside", path: "/etc/motd" },
    ]);
  });

  it("sees a hand edit outside the bot's hunk of a patched file", () => {
    const items = [user("u1", 100), patch("t1", "b.txt", B_DIFF), reply("r1", 101)];
    const [r] = replyFiles(items, FOLDER);
    const texts = new Map([["/tmp/work/b.txt", "beta patched by the bot\na line of mine\n"]]);
    const mine = `${bSection.replace("@@ -1 +1 @@", "@@ -1 +1,2 @@")}\n+a line of mine`;
    expect(planFiles(r, items, FOLDER, parseRollbackDiff("b.txt | 3 ++-", mine), texts)[0]).toMatchObject({ state: "undoable", handEdit: "edited" });
    expect(planFiles(r, items, FOLDER, parseRollbackDiff("b.txt | 2 +-", bSection), texts)[0]).toMatchObject({ state: "undoable", handEdit: "as-left" });
  });

  it("can't tell a patched file is as the bot left it when the server cut its diff section", () => {
    const items = [user("u1", 100), patch("t1", "b.txt", B_DIFF), reply("r1", 101)];
    const [r] = replyFiles(items, FOLDER);
    const texts = new Map([["/tmp/work/b.txt", "beta patched by the bot\n"]]);
    expect(planFiles(r, items, FOLDER, parseRollbackDiff("b.txt | 2 +-", ""), texts)[0]).toMatchObject({ state: "undoable", handEdit: "unknown" });
  });

  it("judges a hand edit against a later reply's edit of the same file, and says a later reply edited it", () => {
    const items = [user("u1", 100), write("t1", "a.txt", "one\n"), reply("r1", 101), user("u2", 102), write("t2", "/tmp/work/a.txt", "two\n"), reply("r2", 103)];
    const [first] = replyFiles(items, FOLDER);
    const texts = new Map([["/tmp/work/a.txt", "two\n"]]);
    expect(planFiles(first, items, FOLDER, parseRollbackDiff("a.txt | 2 +-", ""), texts)[0]).toMatchObject({ state: "undoable", handEdit: "as-left", laterReply: true });
  });
});
