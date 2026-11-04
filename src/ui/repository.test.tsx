// @vitest-environment jsdom
// The Repository screen (ADR 0034) against a fake of Rust's `repo_git` command. Its answers have the shapes
// repo_git_helper.py gives for real repositories (src-tauri/tests/repo_git.rs).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoFailure, type DiffReply, type RepoApi, type RepoRequest, type Status } from "../hermes/repo";
import { RepositoryScreen } from "./Repository";

afterEach(cleanup);

const TOP = "/home/liam/app";

function statusOf(over: Partial<Status> = {}): Status {
  return {
    top: TOP,
    gitDir: `${TOP}/.git`,
    head: "1e6a7627084ab1d090745282b589f5d3de623b23",
    index: "i1",
    branch: { oid: "1e6a7627084ab1d090745282b589f5d3de623b23", head: "feature/login", detached: false, upstream: "origin/feature/login", ahead: 2, behind: 0 },
    operation: null,
    entries: [
      { kind: "ordinary", x: "M", y: "M", sub: false, path: "src/auth.ts", staged: [1, 1], unstaged: [3, 0] },
      { kind: "renamed", x: "R", y: ".", sub: false, path: "docs/login.md", origPath: "docs/auth.md", staged: [0, 0] },
      { kind: "ordinary", x: ".", y: "M", sub: false, path: "assets/logo.png", unstaged: null },
      { kind: "untracked", x: "?", y: "?", sub: false, path: "notes.txt", binary: false },
    ],
    truncated: false,
    ...over,
  };
}

const diffOf = (diff: string, over: Partial<DiffReply> = {}): DiffReply => ({ diff, truncated: false, lossy: false, bytes: diff.length, sha: "x", stages: [], ...over });

/** How many requests of `op` were made. */
const count = (calls: { request: RepoRequest }[], op: RepoRequest["op"]) => calls.filter((c) => c.request.op === op).length;

/** Answers each request with `answer`, and records them. */
function fakeApi(answer: (target: string, r: RepoRequest) => unknown | Promise<unknown>) {
  const calls: { target: string; request: RepoRequest }[] = [];
  const api: RepoApi = {
    run: async (target, request) => {
      calls.push({ target, request });
      return answer(target, request);
    },
  };
  return { api, calls };
}

const DIFFS: Record<string, string> = {
  "staged:src/auth.ts": "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n import x\n-const a = 1\n+const a = 2\n end\n",
  "unstaged:src/auth.ts": "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,2 +10,5 @@\n x\n+one\n+two\n+three\n y\n",
  "staged:docs/login.md": "diff --git a/docs/auth.md b/docs/login.md\nsimilarity index 100%\nrename from docs/auth.md\nrename to docs/login.md\n",
  "unstaged:assets/logo.png": "diff --git a/assets/logo.png b/assets/logo.png\nindex 1..2 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n",
  "untracked:notes.txt": "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+remember\n",
};

function standard(s: () => Status = () => statusOf()) {
  return fakeApi((_t, r) => {
    if (r.op === "status") return s();
    if (r.op === "diff") return diffOf(DIFFS[`${r.side}:${r.path}`] ?? "");
    throw new Error(`unexpected ${r.op}`);
  });
}

function show(api: RepoApi, props: Partial<Parameters<typeof RepositoryScreen>[0]> = {}) {
  const onOpened = vi.fn();
  const onTarget = vi.fn();
  // StrictMode, as the app runs: effects mount, unmount and mount again.
  render(
    <StrictMode>
      <RepositoryScreen api={api} initialTarget="liam@hermes" initialPath={TOP} recent={[]} suggestions={[]} onOpened={onOpened} onTarget={onTarget} onClose={() => {}} {...props} />
    </StrictMode>,
  );
  return { onOpened, onTarget };
}

describe("Repository screen", () => {
  it("opens the folder used last, through the SSH target, and shows its branch and changes", async () => {
    const { api, calls } = standard();
    const { onOpened } = show(api);
    expect(await screen.findByText(TOP)).toBeTruthy();
    expect(calls[0]).toEqual({ target: "liam@hermes", request: { op: "status", repo: TOP } });
    expect(screen.getByText("feature/login")).toBeTruthy();
    expect(screen.getByText("2 ahead of origin/feature/login, as of the last fetch.")).toBeTruthy();
    expect(onOpened).toHaveBeenCalledWith(TOP);

    const staged = within(screen.getByRole("region", { name: "Staged" }));
    expect(staged.getByRole("button", { name: /auth\.ts/ })).toBeTruthy();
    expect(staged.getByText("from docs/auth.md")).toBeTruthy();
    const unstaged = within(screen.getByRole("region", { name: "Changed, not staged" }));
    expect(unstaged.getByRole("button", { name: /logo\.png/ }).textContent).toContain("binary");
    expect(within(screen.getByRole("region", { name: "Untracked" })).getByRole("button", { name: /notes\.txt/ })).toBeTruthy();
  });

  it("shows the staged and unstaged diffs of one file separately", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /auth\.ts/ }));
    const diff = await screen.findByRole("region", { name: "Diff of src/auth.ts" });
    await waitFor(() => expect(within(diff).getByText("const a = 2")).toBeTruthy());
    expect(within(diff).queryByText("three")).toBeNull();
    expect(calls.at(-1)?.request).toEqual({ op: "diff", repo: TOP, path: "src/auth.ts", side: "staged", context: 3 });

    await user.click(within(screen.getByRole("region", { name: "Changed, not staged" })).getByRole("button", { name: /auth\.ts/ }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Diff of src/auth.ts" })).getByText("three")).toBeTruthy());
    expect(screen.queryByText("const a = 2")).toBeNull();
  });

  it("asks for the context chosen", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /auth\.ts/ }));
    await screen.findByText("const a = 2");
    await user.selectOptions(screen.getByLabelText("Context"), "Whole file");
    await waitFor(() => expect(calls.at(-1)?.request).toMatchObject({ op: "diff", context: 1_000_000 }));
  });

  it("says when a file is binary, renamed, or in conflict", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /logo\.png/ }));
    expect(await screen.findByText("Binary file: Git shows no lines for it.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /login\.md/ }));
    expect(await screen.findByText("Renamed from docs/auth.md (100% similar).")).toBeTruthy();
    expect(calls.at(-1)?.request).toMatchObject({ path: "docs/login.md", origPath: "docs/auth.md", side: "staged" });
  });

  it("shows a merge in progress and a conflict's versions", async () => {
    const user = userEvent.setup();
    const conflict = statusOf({ operation: "merge", entries: [{ kind: "unmerged", x: "U", y: "U", sub: false, path: "notes.txt" }] });
    const { api } = fakeApi((_t, r) =>
      r.op === "status" ? conflict : diffOf("diff --cc notes.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +MAIN\n++=======\n+ OTHER\n++>>>>>>> other\n", { stages: [1, 2, 3] }),
    );
    show(api);
    expect(await screen.findByText(/A merge is in progress/)).toBeTruthy();
    await user.click(within(screen.getByRole("region", { name: "Conflicts" })).getByRole("button", { name: /notes\.txt/ }));
    expect(await screen.findByText(/Changed on both sides\. Git holds the common base, ours and theirs/)).toBeTruthy();
    expect(screen.getByText("<<<<<<< HEAD").closest(".files-diff-line")?.className).toContain("marker");
  });

  it("tells ssh failures apart, with what to do and what ssh said", async () => {
    const { api } = fakeApi(() => {
      throw new RepoFailure("ssh-host-key", "ssh doesn't know this server's host key yet.", "Host key verification failed.");
    });
    show(api);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ssh doesn't know this server's host key yet.");
    expect(alert.textContent).toContain("Open the Terminal");
    expect(alert.textContent).toContain("Host key verification failed.");
  });

  it("says when the folder isn't a repository", async () => {
    const { api } = fakeApi(() => {
      throw new RepoFailure("not-repo", "/home/liam isn't in a Git repository.");
    });
    show(api, { initialPath: "/home/liam" });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read /home/liam: /home/liam isn't in a Git repository.");
  });

  it("asks for an SSH target when there is none, and keeps the one given", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    const { onTarget } = show(api, { initialTarget: "" });
    expect(screen.getByText("Enter the SSH target of the Hermes server first.")).toBeTruthy();
    expect(calls).toEqual([]);
    await user.type(screen.getByLabelText("SSH target"), "liam@box");
    await user.click(screen.getByRole("button", { name: "Use this target" }));
    expect(onTarget).toHaveBeenCalledWith("liam@box");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText(TOP);
    expect(calls[0]).toEqual({ target: "liam@box", request: { op: "status", repo: TOP } });
  });

  it("offers the project's folders and recent ones when nothing is open", async () => {
    const user = userEvent.setup();
    const { api, calls } = standard();
    show(api, { initialPath: "", recent: ["/srv/old"], suggestions: [{ label: "Website", path: "/home/liam/site" }] });
    await user.click(screen.getByRole("button", { name: /Website \/home\/liam\/site/ }));
    await waitFor(() => expect(calls[0].request).toEqual({ op: "status", repo: "/home/liam/site" }));
    expect(screen.queryByRole("button", { name: /Recent \/srv\/old/ })).toBeNull();
  });

  it("ignores an answer for a folder that's no longer the one shown", async () => {
    const user = userEvent.setup();
    let release: (v: Status) => void = () => {};
    const { api } = fakeApi((_t, r) => {
      if (r.op !== "status") return diffOf("");
      if (r.repo === "/slow") return new Promise<Status>((res) => (release = res));
      return statusOf({ top: "/fast" });
    });
    show(api, { initialPath: "/slow" });
    const input = screen.getByLabelText(/Folder on the server/);
    await user.clear(input);
    await user.type(input, "/fast");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("/fast")).toBeTruthy();
    await act(async () => release(statusOf({ top: "/slow" })));
    expect(screen.queryByText("/slow")).toBeNull();
    expect(screen.getByText("/fast")).toBeTruthy();
  });

  it("drops a selected file that a refresh no longer lists", async () => {
    const user = userEvent.setup();
    let current = statusOf();
    const { api } = standard(() => current);
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    await screen.findByRole("region", { name: "Diff of notes.txt" });
    current = statusOf({ entries: [] });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No changes: the working tree matches HEAD.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Diff of notes.txt" })).toBeNull();
  });
});

// ── stage 2: staging and committing ─────────────────────────────────────────

const STAMPED = (): Status =>
  statusOf({
    entries: [
      { kind: "ordinary", x: "M", y: "M", sub: false, path: "src/auth.ts", staged: [1, 1], unstaged: [3, 0], worktree: "w-auth" },
      { kind: "renamed", x: "R", y: ".", sub: false, path: "docs/login.md", origPath: "docs/auth.md", staged: [0, 0] },
      { kind: "untracked", x: "?", y: "?", sub: false, path: "notes.txt", binary: false, worktree: "w-notes" },
    ],
  });

const TWO_HUNKS =
  "diff --git a/src/auth.ts b/src/auth.ts\nindex 1..2 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -9,2 +9,2 @@\n y\n-z\n+Z\n";

const PREVIEW = {
  head: "1e6a7627084ab1d090745282b589f5d3de623b23",
  index: "i1",
  branch: "feature/login",
  files: [
    { status: "D", path: "docs/auth.md", oldMode: "100644", newMode: "000000" },
    { status: "A", path: "docs/login.md", oldMode: "000000", newMode: "100644" },
    { status: "M", path: "src/auth.ts", oldMode: "100644", newMode: "100644" },
  ],
  renames: { "docs/login.md": { from: "docs/auth.md", score: "R100" } },
  rawSha: "raw1",
  diff: " src/auth.ts | 2 +-\n\ndiff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n",
  truncated: false,
  lossy: false,
  unmerged: false,
  operation: null,
  author: "Demo Owner <demo@example.com>",
  committer: "Demo Owner <demo@example.com>",
  hooksPath: `${TOP}/.git/hooks`,
  hooks: ["pre-commit"],
  recent: ["Add sign-in sessions"],
};

/** A fake whose writes answer with `onWrite`, and whose diffs are the stamped ones. */
function writable(onWrite: (r: RepoRequest) => unknown, diffs: Record<string, Partial<DiffReply> & { diff: string }> = {}) {
  return fakeApi((_t, r) => {
    if (r.op === "status") return STAMPED();
    if (r.op === "diff") {
      const d = diffs[`${r.side}:${r.path}`] ?? { diff: DIFFS[`${r.side}:${r.path}`] ?? "" };
      return diffOf(d.diff, { head: PREVIEW.head, index: "i1", worktree: r.side === "staged" ? null : `w-${r.path.includes("notes") ? "notes" : "auth"}`, ...d });
    }
    if (r.op === "preview") return PREVIEW;
    return onWrite(r);
  });
}

describe("Repository screen, staging", () => {
  it("stages only the ticked files, each with the stamp the list read, then reads the list again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }));
    show(api);
    await screen.findByText(TOP);
    const untracked = within(screen.getByRole("region", { name: "Untracked" }));
    expect((untracked.getByRole("button", { name: /Stage ticked/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }));
    const reads = count(calls, "status");
    await user.click(untracked.getByRole("button", { name: /Stage 1 ticked/ }));
    expect(await screen.findByText("Staged notes.txt.")).toBeTruthy();
    const w = calls.find((c) => c.request.op === "stage");
    expect(w?.request).toEqual({ op: "stage", repo: TOP, files: [{ path: "notes.txt", worktree: "w-notes" }], expect: { head: PREVIEW.head, index: "i1" } });
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });

  it("unstages a rename with its old path, so both go back", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }));
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("checkbox", { name: "Tick docs/login.md to unstage it" }));
    await user.click(within(screen.getByRole("region", { name: "Staged" })).getByRole("button", { name: /Unstage 1 ticked/ }));
    await screen.findByText("Unstaged docs/login.md.");
    expect(calls.find((c) => c.request.op === "unstage")?.request).toMatchObject({ paths: ["docs/login.md", "docs/auth.md"] });
  });

  it("stages one hunk by its position in the diff shown, against that diff's stamps", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({ head: PREVIEW.head, index: "i2" }), { "unstaged:src/auth.ts": { diff: TWO_HUNKS, sha: "d-sha", index: "i1" } });
    show(api);
    await screen.findByText(TOP);
    await user.click(within(screen.getByRole("region", { name: "Changed, not staged" })).getByRole("button", { name: /auth\.ts/ }));
    await user.click(await screen.findByRole("button", { name: "Stage hunk 2 of 2" }));
    await screen.findByText("Staged a hunk of src/auth.ts.");
    const apply = calls.find((c) => c.request.op === "apply")?.request;
    expect(apply).toEqual({
      op: "apply",
      repo: TOP,
      path: "src/auth.ts",
      hunks: [1],
      reverse: false,
      context: 3,
      diffSha: "d-sha",
      expect: { head: PREVIEW.head, index: "i1" },
    });
  });

  it("offers whole files only for a rename or an untracked file", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => ({}));
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    await screen.findByText("remember");
    expect(screen.getByRole("button", { name: /Stage file/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stage hunk/ })).toBeNull();
  });

  it("won't stage from a diff newer than the list", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({}), { "untracked:notes.txt": { diff: DIFFS["untracked:notes.txt"], worktree: "w-newer" } });
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: /notes\.txt/ }));
    expect(await screen.findByText(/This file changed after the list was read/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Stage file/ }) as HTMLButtonElement).disabled).toBe(true);
    const reads = count(calls, "status");
    await user.click(within(screen.getByRole("region", { name: "Diff of notes.txt" })).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });

  it("says why a write was refused, and reads the list again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => {
      throw new RepoFailure("stale", "notes.txt changed on the server since this screen read it. Nothing was staged.");
    });
    show(api);
    await screen.findByText(TOP);
    await user.click(screen.getByRole("checkbox", { name: "Tick notes.txt to stage it" }));
    const reads = count(calls, "status");
    await user.click(screen.getByRole("button", { name: /Stage 1 ticked/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Staging notes.txt didn't happen: notes.txt changed on the server");
    expect(alert.textContent).toContain("Another agent or tool may be working in this checkout");
    await waitFor(() => expect(count(calls, "status")).toBe(reads + 1));
  });
});

describe("Repository screen, committing", () => {
  async function review(api: RepoApi, user: ReturnType<typeof userEvent.setup>, message = "Lengthen sessions") {
    show(api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), message);
    await user.click(screen.getByRole("button", { name: "Review commit…" }));
    return screen.findByRole("dialog");
  }

  it("previews exactly what the commit holds, then commits it with the preview's stamps", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => ({
      head: "abcdef1234567890",
      subject: "Lengthen sessions",
      output: "pre-commit: 3 files checked\n[feature/login abcdef1] Lengthen sessions",
      matches: true,
      files: PREVIEW.files,
      branch: "feature/login",
    }));
    const dialog = within(await review(api, user));
    await dialog.findByText("pre-commit will run, as Git runs them. Nothing skips them.");
    expect(dialog.getByText("Demo Owner <demo@example.com>")).toBeTruthy();
    expect(dialog.getByText("docs/auth.md → docs/login.md")).toBeTruthy();
    expect(dialog.getByText("const a = 2")).toBeTruthy();
    expect(dialog.getByText("Lengthen sessions", { selector: "pre" })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/pre-commit: 3 files checked/)).toBeTruthy();
    expect(dialog.getByText("Lengthen sessions", { selector: "pre" })).toBeTruthy();
    expect(calls.find((c) => c.request.op === "commit")?.request).toEqual({
      op: "commit",
      repo: TOP,
      message: "Lengthen sessions\n",
      expect: { head: PREVIEW.head, index: "i1", rawSha: "raw1" },
    });
    await user.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.getByText("Committed abcdef1 on feature/login: Lengthen sessions")).toBeTruthy();
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a hook's refusal with its output, and keeps everything for another try", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => {
      throw new RepoFailure("hook", "A hook refused the commit (pre-commit). Its output is below. Nothing was committed.", "lint: src/auth.ts:3 shouting\n");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/The commit was refused: A hook refused the commit/)).toBeTruthy();
    expect(dialog.getAllByText(/lint: src\/auth.ts:3 shouting/).length).toBeGreaterThan(0);
    expect(dialog.getByText(/Hooks are never skipped/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says when a hook changed what was committed", async () => {
    const user = userEvent.setup();
    const { api } = writable(() => ({ head: "abcdef1234567890", subject: "x", output: "", matches: false, files: [{ status: "M", path: "src/auth.ts" }, { status: "M", path: "src/format.ts" }], branch: "main" }));
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/A hook changed what was committed/)).toBeTruthy();
    expect(dialog.getByText("src/format.ts")).toBeTruthy();
  });

  it("refuses a stale preview and offers to preview again", async () => {
    const user = userEvent.setup();
    const { api, calls } = writable(() => {
      throw new RepoFailure("stale", "Since this screen last read the repository, the staged changes changed. Nothing was changed.");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    const previews = count(calls, "preview");
    await user.click(await dialog.findByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(count(calls, "preview")).toBe(previews + 1));
  });

  it("reads HEAD again when the commit's answer is lost", async () => {
    const user = userEvent.setup();
    let committed = false;
    const { api } = fakeApi((_t, r) => {
      if (r.op === "status") return committed ? statusOf({ head: "fedcba9876543210", entries: [] }) : STAMPED();
      if (r.op === "preview") return PREVIEW;
      if (r.op === "commit") {
        committed = true;
        throw new RepoFailure("timeout", "The server didn't answer within 660 s.");
      }
      return diffOf("");
    });
    const dialog = within(await review(api, user));
    await user.click(await dialog.findByRole("button", { name: "Commit" }));
    expect(await dialog.findByText(/HEAD is now fedcba987654: a commit was made/)).toBeTruthy();
  });

  it("can't be reviewed with nothing staged, and fills in Hermes's suggestion to edit", async () => {
    const user = userEvent.setup();
    const suggest = vi.fn(async () => "```\nLengthen sessions to an hour\n```");
    const { api } = writable(() => ({}));
    show(api, { suggest });
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    await waitFor(() => expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("Lengthen sessions to an hour"));
    const [instructions, input] = suggest.mock.calls[0] as unknown as [string, string];
    expect(instructions).toMatch(/commit message/);
    expect(input).toContain("R docs/auth.md -> docs/login.md");
    expect(input).toContain("+const a = 2");
    cleanup();

    const empty = fakeApi((_t, r) => (r.op === "status" ? statusOf({ entries: [{ kind: "untracked", x: "?", y: "?", sub: false, path: "n", worktree: "w" }] }) : diffOf("")));
    show(empty.api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), "x");
    expect((screen.getByRole("button", { name: "Review commit…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Replace with a suggestion" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Repository screen, during an operation", () => {
  it("won't review a commit while a merge is in progress", async () => {
    const user = userEvent.setup();
    const merging = statusOf({ operation: "merge", entries: [{ kind: "ordinary", x: "M", y: ".", sub: false, path: "a.txt", staged: [1, 0] }] });
    const { api } = fakeApi((_t, r) => (r.op === "status" ? merging : diffOf("")));
    show(api);
    await screen.findByText(TOP);
    await user.type(screen.getByLabelText(/Commit message/), "Merge");
    const review = screen.getByRole("button", { name: "Review commit…" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(review.title).toMatch(/A merge is in progress/);
  });
});

describe("Repository screen, a late suggestion", () => {
  it("doesn't replace a message typed while Hermes was writing", async () => {
    const user = userEvent.setup();
    let answer: (m: string) => void = () => {};
    const suggest = vi.fn(() => new Promise<string>((res) => (answer = res)));
    const { api } = fakeApi((_t, r) => (r.op === "status" ? STAMPED() : r.op === "preview" ? PREVIEW : diffOf("")));
    show(api, { suggest });
    await screen.findByText(TOP);
    await user.click(screen.getByRole("button", { name: "Suggest a message" }));
    await waitFor(() => expect(suggest).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/Commit message/), "My own words");
    await act(async () => answer("Hermes's words"));
    expect((screen.getByLabelText(/Commit message/) as HTMLTextAreaElement).value).toBe("My own words");
    expect(screen.getByRole("alert").textContent).toMatch(/suggestion wasn't used/);
  });
});
