// @vitest-environment jsdom
// The Repository screen (ADR 0034) against a fake of Rust's `repo_git` command. Its answers have the shapes
// repo_git_helper.py gives for real repositories (src-tauri/tests/repo_git.rs).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoFailure, type DiffReply, type RepoApi, type RepoRequest, type Status } from "../hermes/repo";
import { RepositoryScreen } from "./Repository";

afterEach(cleanup);

const TOP = "/home/liam/app";

function statusOf(over: Partial<Status> = {}): Status {
  return {
    top: TOP,
    gitDir: `${TOP}/.git`,
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
    return diffOf(DIFFS[`${r.side}:${r.path}`] ?? "");
  });
}

function show(api: RepoApi, props: Partial<Parameters<typeof RepositoryScreen>[0]> = {}) {
  const onOpened = vi.fn();
  const onTarget = vi.fn();
  render(
    <RepositoryScreen api={api} initialTarget="liam@hermes" initialPath={TOP} recent={[]} suggestions={[]} onOpened={onOpened} onTarget={onTarget} onClose={() => {}} {...props} />,
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
