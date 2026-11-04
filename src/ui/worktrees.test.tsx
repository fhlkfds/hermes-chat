// @vitest-environment jsdom
// Worktrees in the Repository screen (ADR 0042) against a fake of Rust's `repo_git` command. Its answers have the
// shapes repo_worktrees_helper.py gives for real repositories (src-tauri/tests/worktrees.rs).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoFailure, type RepoApi, type RepoRequest } from "../hermes/repo";
import type { RemovalFacts, WorktreeList, WorktreePlan, WorktreeRecord, WorktreeRow } from "../hermes/worktrees";
import { WorktreesPanel } from "./Worktrees";

afterEach(cleanup);

const TOP = "/srv/app";
const PATH = "/srv/app.worktrees/fix-login";
const SHA = "57a1fb6c0ffee57a1fb6c0ffee57a1fb6c0ffee5";

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  id: "0b5c1f3e-7a2d-4c61-9e0f-1a2b3c4d5e6f",
  path: PATH,
  branch: "fix/login",
  newBranch: true,
  base: "main",
  baseSha: SHA,
  setup: [],
  state: "ready",
  protected: false,
  chats: [],
  createdAt: 1,
  createdBy: "Hermes Chat (default via ssh://liam@hermes)",
  ...over,
});

const mainRow: WorktreeRow = { path: TOP, head: SHA, branch: "main", detached: false, locked: null, prunable: false, main: true, current: true, missing: false, record: null, changes: { staged: 0, changed: 2, untracked: 1, conflicts: 0 }, unpushed: 0 };
const managedRow = (r: WorktreeRecord, over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: r.path,
  head: SHA,
  branch: r.branch,
  detached: false,
  locked: `hermes-chat ${r.id}`,
  prunable: false,
  main: false,
  current: false,
  missing: false,
  record: r,
  changes: { staged: 0, changed: 1, untracked: 2, conflicts: 0 },
  unpushed: 3,
  ...over,
});
const REGISTRY = `${TOP}/.git/hermes-chat/worktrees.json`;
const listOf = (rows: WorktreeRow[], over: Partial<WorktreeList> = {}): WorktreeList => ({
  top: TOP,
  main: TOP,
  hasRemote: true,
  newer: false,
  worktrees: [mainRow, ...rows],
  unfinished: [],
  removed: [],
  registry: REGISTRY,
  ...over,
});

const plan = (over: Partial<WorktreePlan> = {}): WorktreePlan => ({
  repo: TOP,
  path: PATH,
  branch: "fix/login",
  newBranch: true,
  base: "main",
  baseSha: SHA,
  subject: "Add the login form",
  setup: [
    { entry: ".env", action: "copy", state: "pending", message: "" },
    { entry: "node_modules", action: "link", state: "pending", message: "" },
    { entry: "local.cfg", action: "skip", state: "skipped", message: "Git doesn't ignore it, so it's part of the source." },
  ],
  stamp: "stamp-1",
  source: { path: TOP, staged: 0, changed: 2, untracked: 1, conflicts: 0 },
  submodules: [],
  submoduleCount: 0,
  ...over,
});

const removal = (over: Partial<RemovalFacts> = {}): RemovalFacts => ({
  path: PATH,
  blockers: [],
  files: [
    { status: "changed", path: "src/login.ts" },
    { status: "untracked", path: "notes.txt" },
  ],
  fileCount: 2,
  ignored: [".env"],
  unpushed: [{ sha: SHA, subject: "Fix the timeout" }],
  hasRemote: true,
  head: SHA,
  branch: "fix/login",
  keepHead: false,
  stamp: "rm-1",
  ...over,
});

type Answer = (r: RepoRequest) => unknown | Promise<unknown>;
function fakeApi(answer: Answer) {
  const calls: RepoRequest[] = [];
  const api: RepoApi = {
    run: async (_t, request) => {
      calls.push(request);
      return answer(request);
    },
  };
  return { api, calls };
}
const ops = (calls: RepoRequest[], op: RepoRequest["op"]) => calls.filter((c) => c.op === op);

function show(api: RepoApi, props: Partial<Parameters<typeof WorktreesPanel>[0]> = {}) {
  const onOpen = vi.fn();
  const onStartChat = vi.fn();
  const chatsIn = vi.fn(async () => ({ chats: [] as { id: string; title: string; archived: boolean }[], more: false }));
  render(
    <StrictMode>
      <WorktreesPanel api={api} target="liam@hermes" top={TOP} branch="main" scope="scope-a" by="Hermes Chat (test)" chatsIn={chatsIn} onOpen={onOpen} onStartChat={onStartChat} {...props} />
    </StrictMode>,
  );
  return { onOpen, onStartChat, chatsIn };
}

const panel = () => screen.getByRole("region", { name: "Worktrees" });
const dialog = () => screen.getByRole("dialog");

describe("the list", () => {
  it("says so while reading, then lists the managed worktrees with their changes, unpushed commits and chats", async () => {
    let answer!: (v: unknown) => void;
    const r = record({ chats: [{ scope: "scope-a", chat: "s1", title: "Fix the login timeout" }, { scope: "scope-b", chat: "s9", title: "Other profile" }] });
    const { api } = fakeApi((q) => (q.op === "worktreeList" ? new Promise((res) => (answer = res)) : undefined));
    show(api);
    expect(within(panel()).getByRole("status").textContent).toContain("Reading the worktrees");
    await act(async () => answer(listOf([managedRow(r)])));
    const card = within(panel()).getByRole("group", { name: "Worktree fix/login" });
    expect(card.textContent).toContain(PATH);
    expect(card.textContent).toContain("1 changed · 2 untracked");
    expect(card.textContent).toContain("3 commits not on a remote");
    expect(card.textContent).toContain("“Fix the login timeout”");
    expect(card.textContent).toContain("“Other profile” (another connection or profile)");
    // The repository's own checkout is listed apart, and never offered for removal.
    expect(within(panel()).getByRole("list", { name: "Other worktrees" }).textContent).toContain("the repository's own checkout");
    expect(within(panel()).getAllByRole("button", { name: /^Remove the worktree/ })).toHaveLength(1);
  });

  it("says when Hermes Chat has made none", async () => {
    const { api } = fakeApi(() => listOf([]));
    show(api);
    await waitFor(() => expect(panel().textContent).toContain("No worktrees made by Hermes Chat are here."));
  });

  it("says when the server can't do it", async () => {
    const { api } = fakeApi(() => {
      throw new RepoFailure("unsupported", "This is a bare repository. Worktrees are made here from a repository with its own checkout.");
    });
    show(api);
    await waitFor(() => expect(within(panel()).getByRole("alert").textContent).toContain("Worktrees aren't available for this repository"));
    expect(within(panel()).getByRole("button", { name: /New worktree/ })).toHaveProperty("disabled", true);
  });

  it("drops an answer for an older read", async () => {
    const answers: ((v: unknown) => void)[] = [];
    const { api } = fakeApi((q) => (q.op === "worktreeList" ? new Promise((res) => answers.push(res)) : undefined));
    const user = userEvent.setup();
    show(api);
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    await act(async () => answers.at(-1)!(listOf([])));
    await user.click(within(panel()).getByRole("button", { name: "Refresh worktrees" }));
    await user.click(within(panel()).getByRole("button", { name: "Refresh worktrees" }));
    const [older, newer] = answers.slice(-2);
    await act(async () => newer(listOf([managedRow(record())])));
    await act(async () => older(listOf([])));
    expect(within(panel()).getByRole("group", { name: "Worktree fix/login" })).toBeTruthy();
  });

  it("detaches a chat only once the owner confirms, and protects", async () => {
    const r = record({ chats: [{ scope: "scope-a", chat: "s1", title: "Fix the login timeout" }] });
    const { api, calls } = fakeApi((q) => (q.op === "worktreeList" ? listOf([managedRow(r)]) : { record: r }));
    const user = userEvent.setup();
    show(api);
    await user.click(await screen.findByRole("button", { name: "Detach “Fix the login timeout”" }));
    expect(ops(calls, "worktreeDetach")).toEqual([]);
    expect(screen.getByRole("group", { name: "Detach this chat?" }).textContent).toContain("keeps working in this folder");
    await user.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(ops(calls, "worktreeDetach")).toEqual([{ op: "worktreeDetach", repo: TOP, id: r.id, scope: "scope-a", chat: "s1" }]));
    await user.click(screen.getByRole("button", { name: "Protect" }));
    await waitFor(() => expect(ops(calls, "worktreeProtect")).toEqual([{ op: "worktreeProtect", repo: TOP, id: r.id, protected: true }]));
  });

  it("starts a chat on the branch the worktree has now, not the one it was made on", async () => {
    const r = record();
    const { api } = fakeApi(() => listOf([managedRow(r, { branch: "fix/login-v2" })]));
    const user = userEvent.setup();
    const { onStartChat } = show(api);
    await user.click(await screen.findByRole("button", { name: "Start chat here" }));
    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ branch: "fix/login-v2" }));
  });

  it("offers Start chat only while Hermes is connected", async () => {
    const r = record();
    const { api } = fakeApi(() => listOf([managedRow(r)]));
    const user = userEvent.setup();
    const { onStartChat } = show(api);
    await user.click(await screen.findByRole("button", { name: "Start chat here" }));
    expect(onStartChat).toHaveBeenCalledWith({ target: "liam@hermes", repo: TOP, registry: REGISTRY, id: r.id, path: PATH, branch: "fix/login" });
    cleanup();
    show(api, { onStartChat: undefined });
    expect(await screen.findByRole("button", { name: "Start chat here" })).toHaveProperty("disabled", true);
  });
});

describe("making one", () => {
  /** A server that makes the worktree, then runs each setup step as `steps` says. */
  function making(steps: Record<number, ("done" | "failed")[]> = {}, create?: () => unknown) {
    let rec: WorktreeRecord | undefined;
    const tries: Record<number, number> = {};
    return fakeApi((q) => {
      if (q.op === "worktreeList") return listOf(rec ? [managedRow(rec)] : []);
      if (q.op === "worktreePlan") return plan();
      if (q.op === "worktreeCreate") {
        if (create) return create();
        rec = record({ id: q.id, setup: plan().setup });
        return { record: rec, output: "Preparing worktree (new branch 'fix/login')\nHEAD is now at 57a1fb6 Add the login form\n" };
      }
      if (q.op === "worktreeSetup") {
        const n = (tries[q.step] = (tries[q.step] ?? 0) + 1);
        const state = steps[q.step]?.[n - 1] ?? "done";
        rec = { ...rec!, setup: rec!.setup.map((s, i) => (i === q.step ? { ...s, state, message: state === "failed" ? "[Errno 13] Permission denied: '/srv/app/.env'" : "Copied." } : s)) };
        return { record: rec };
      }
      throw new Error(`unexpected ${q.op}`);
    });
  }

  async function fillAndPreview(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /New worktree/ }));
    await user.type(within(dialog()).getByLabelText("New branch name"), "fix/login");
    expect(within(dialog()).getByLabelText("Start from (branch, tag or commit)")).toHaveProperty("value", "main");
    await user.click(within(dialog()).getByRole("button", { name: "Preview" }));
    await within(dialog()).findByRole("button", { name: "Create worktree" });
  }

  it("previews the exact folder, branch, base and setup, says the source's changes stay, then makes it and runs setup", async () => {
    const { api, calls } = making();
    const user = userEvent.setup();
    const { onStartChat } = show(api);
    await fillAndPreview(user);
    const what = within(dialog()).getByLabelText("What will be made").textContent!;
    expect(what).toContain(PATH);
    expect(what).toContain("fix/login (new, not tracking anything)");
    expect(what).toContain("57a1fb6 Add the login form");
    expect(what).toContain("has uncommitted changes (2 changed · 1 untracked). They stay there");
    expect(what).toContain("Copy .env");
    expect(what).toContain("Skip local.cfg");
    expect(ops(calls, "worktreePlan")).toEqual([{ op: "worktreePlan", repo: TOP, branch: "fix/login", newBranch: true, base: "main" }]);

    await user.click(within(dialog()).getByRole("button", { name: "Create worktree" }));
    await within(dialog()).findByText("The worktree is ready.");
    const [create] = ops(calls, "worktreeCreate");
    expect(create).toMatchObject({ op: "worktreeCreate", repo: TOP, branch: "fix/login", newBranch: true, base: "main", stamp: "stamp-1", by: "Hermes Chat (test)" });
    // Each step that does something ran once, in order; the skipped one never.
    expect(ops(calls, "worktreeSetup").map((c) => (c as { step: number }).step)).toEqual([0, 1]);
    expect(within(dialog()).getByText(/HEAD is now at 57a1fb6/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Start chat here" }));
    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ path: PATH, branch: "fix/login", id: (create as { id: string }).id }));
  });

  it("runs a worktree's steps left as soon as Retry setup opens it", async () => {
    const r = record({ setup: [{ entry: ".env", action: "copy", state: "failed", message: "[Errno 13] Permission denied" }, { entry: "node_modules", action: "link", state: "pending", message: "" }] });
    let rec = r;
    const { api, calls } = fakeApi((q) => {
      if (q.op === "worktreeList") return listOf([managedRow(rec)]);
      if (q.op === "worktreeSetup") {
        rec = { ...rec, setup: rec.setup.map((s, i) => (i === q.step ? { ...s, state: "done", message: "Copied." } : s)) };
        return { record: rec };
      }
      throw new Error(`unexpected ${q.op}`);
    });
    const user = userEvent.setup();
    show(api);
    await user.click(await screen.findByRole("button", { name: "Retry setup" }));
    await within(dialog()).findByText("The worktree is ready.");
    expect(ops(calls, "worktreeSetup").map((c) => (c as { step: number }).step)).toEqual([0, 1]);
  });

  it("starts a chat from the setup dialog on the branch the worktree has now", async () => {
    let rec = record({ setup: [{ entry: ".env", action: "copy", state: "pending", message: "" }] });
    const { api } = fakeApi((q) => {
      if (q.op === "worktreeList") return listOf([managedRow(rec, { branch: "fix/login-v2" })]);
      if (q.op === "worktreeSetup") return { record: (rec = { ...rec, setup: [{ ...rec.setup[0], state: "done" }] }) };
      throw new Error(`unexpected ${q.op}`);
    });
    const user = userEvent.setup();
    const { onStartChat } = show(api);
    await user.click(await screen.findByRole("button", { name: "Run setup" }));
    await within(dialog()).findByText("The worktree is ready.");
    await user.click(within(dialog()).getByRole("button", { name: "Start chat here" }));
    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ branch: "fix/login-v2" }));
  });

  it("makes an edit stale: it must be previewed again", async () => {
    const { api, calls } = making();
    const user = userEvent.setup();
    show(api);
    await fillAndPreview(user);
    await user.type(within(dialog()).getByLabelText("New branch name"), "-2");
    expect(within(dialog()).queryByRole("button", { name: "Create worktree" })).toBeNull();
    expect(ops(calls, "worktreeCreate")).toEqual([]);
  });

  it("stops at a failed setup step with Retry and Open, and Retry runs only what's left", async () => {
    const { api, calls } = making({ 0: ["failed", "done"] });
    const user = userEvent.setup();
    const { onOpen } = show(api);
    await fillAndPreview(user);
    await user.click(within(dialog()).getByRole("button", { name: "Create worktree" }));
    await within(dialog()).findByText(/Setup didn't finish/);
    expect(within(dialog()).getByRole("list", { name: "Setup steps" }).textContent).toContain("Permission denied");
    // The step after the failed one waits.
    expect(ops(calls, "worktreeSetup").map((c) => (c as { step: number }).step)).toEqual([0]);
    expect(within(dialog()).getByRole("button", { name: "Open" })).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Retry" }));
    await within(dialog()).findByText("The worktree is ready.");
    expect(ops(calls, "worktreeSetup").map((c) => (c as { step: number }).step)).toEqual([0, 0, 1]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("asks the server after a lost answer, and carries on when the worktree is there", async () => {
    let made: WorktreeRecord | undefined;
    const base = making();
    const { api, calls } = fakeApi((q) => {
      if (q.op === "worktreeCreate") {
        made = record({ id: q.id, setup: [] });
        throw new RepoFailure("ssh", "ssh failed.", "Connection to hermes closed by remote host.");
      }
      if (q.op === "worktreeList") return listOf(made ? [managedRow(made)] : []);
      return base.api.run("", q);
    });
    const user = userEvent.setup();
    show(api);
    await fillAndPreview(user);
    await user.click(within(dialog()).getByRole("button", { name: "Create worktree" }));
    await within(dialog()).findByText("The worktree is ready.");
    expect(within(dialog()).getByText(/The answer was lost, but the server has the worktree/)).toBeTruthy();
    expect(ops(calls, "worktreeCreate")).toHaveLength(1);
  });

  it("after a lost answer with nothing made, Try again sends the same request with the same id", async () => {
    let n = 0;
    const base = making();
    const { api, calls } = fakeApi((q) => {
      if (q.op === "worktreeCreate" && ++n === 1) throw new RepoFailure("timeout", "The server didn't answer within 660 s.");
      return base.api.run("", q);
    });
    const user = userEvent.setup();
    show(api);
    await fillAndPreview(user);
    await user.click(within(dialog()).getByRole("button", { name: "Create worktree" }));
    await within(dialog()).findByText("Nothing was made. You can try again.");
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    await within(dialog()).findByText("The worktree is ready.");
    const [a, b] = ops(calls, "worktreeCreate") as { id: string; stamp: string }[];
    expect(b.id).toBe(a.id);
    expect(b.stamp).toBe(a.stamp);
  });

  it("goes back to the form when the server refuses a stale preview", async () => {
    const { api } = making({}, () => {
      throw new RepoFailure("stale", "Something changed since the preview. Nothing was made. Look at the preview again.");
    });
    const user = userEvent.setup();
    show(api);
    await fillAndPreview(user);
    await user.click(within(dialog()).getByRole("button", { name: "Create worktree" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("Something changed since the preview");
    expect(within(dialog()).getByRole("button", { name: "Preview" })).toBeTruthy();
  });

  it("closes with Escape and puts focus back on New worktree", async () => {
    const { api } = making();
    const user = userEvent.setup();
    show(api);
    const opener = await screen.findByRole("button", { name: /New worktree/ });
    await user.click(opener);
    expect(document.activeElement).toBe(within(dialog()).getByLabelText("New branch name"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("removing one", () => {
  function removing(facts: RemovalFacts, remove?: (q: RepoRequest) => unknown) {
    const r = record();
    return fakeApi((q) => {
      if (q.op === "worktreeList") return listOf([managedRow(r)]);
      if (q.op === "worktreeRemoval") return facts;
      if (q.op === "worktreeRemove") {
        if (remove) return remove(q);
        return { record: { ...r, state: "removed", removed: { at: 2, head: SHA, branch: "fix/login", kept: { ref: `refs/hermes-chat/recovery/${r.id}/2`, commit: "c".repeat(40) }, files: 2, unpushed: 1 } } };
      }
      throw new Error(`unexpected ${q.op}`);
    });
  }

  it("previews the files kept, the commits that stay on the branch and the ignored files deleted, then keeps and removes", async () => {
    const { api, calls } = removing(removal());
    const user = userEvent.setup();
    const { chatsIn } = show(api);
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    const d = await screen.findByRole("dialog", { name: "Remove the worktree fix/login?" });
    await within(d).findByRole("list", { name: "Changed and untracked files" });
    expect(within(d).getByRole("list", { name: "Changed and untracked files" }).textContent).toContain("src/login.ts changed");
    expect(within(d).getByRole("list", { name: "Commits not on a remote" }).textContent).toContain("Fix the timeout");
    expect(d.textContent).toContain("They stay on the branch fix/login.");
    expect(within(d).getByRole("list", { name: "Ignored files deleted with the folder" }).textContent).toBe(".env");
    expect(chatsIn).toHaveBeenCalledWith({ path: PATH, registry: REGISTRY, id: record().id });
    const asked = chatsIn.mock.calls.length;
    await user.click(within(d).getByRole("button", { name: "Keep changes and remove" }));
    await within(d).findByText(/was removed/);
    expect(d.textContent).toContain(`refs/hermes-chat/recovery/${record().id}/2`);
    expect(ops(calls, "worktreeRemove")).toEqual([{ op: "worktreeRemove", repo: TOP, id: record().id, stamp: "rm-1" }]);
    // Hermes was asked again right before removing.
    expect(chatsIn).toHaveBeenCalledTimes(asked + 1);
  });

  it("can't remove while the server or Hermes says something works there, or Hermes can't be asked", async () => {
    const user = userEvent.setup();
    const { api, calls } = removing(removal({ blockers: [{ kind: "shared", message: "1 chat uses it. Detach each one first; a quiet chat doesn't mean its worktree is done with." }] }));
    show(api);
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("a quiet chat doesn't mean its worktree is done with");
    expect(within(dialog()).getByRole("button", { name: "Keep changes and remove" })).toHaveProperty("disabled", true);
    cleanup();

    show(removing(removal()).api, { chatsIn: async () => ({ chats: [{ id: "s1", title: "Fix login", archived: false }], more: false }) });
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("Hermes has 1 chat working in this folder: “Fix login”");
    cleanup();

    show(removing(removal()).api, { chatsIn: undefined });
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("Hermes isn't connected");
    expect(ops(calls, "worktreeRemove")).toEqual([]);
  });

  it("isn't started again, or overwritten, when the app draws a new chatsIn while removing", async () => {
    let finish!: (v: unknown) => void;
    const r = record();
    const { api, calls } = fakeApi((q) => {
      if (q.op === "worktreeList") return listOf([managedRow(r)]);
      if (q.op === "worktreeRemoval") return removal();
      if (q.op === "worktreeRemove") return new Promise((res) => (finish = res));
      throw new Error(`unexpected ${q.op}`);
    });
    const user = userEvent.setup();
    const props = { api, target: "liam@hermes", top: TOP, branch: "main", scope: "scope-a", by: "t", onOpen: () => {}, onStartChat: () => {} };
    const fresh = () => async () => ({ chats: [] as { id: string; title: string; archived: boolean }[], more: false });
    const { rerender } = render(<WorktreesPanel {...props} chatsIn={fresh()} />);
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Keep changes and remove" }));
    await waitFor(() => expect(ops(calls, "worktreeRemove")).toHaveLength(1));
    const previews = ops(calls, "worktreeRemoval").length;
    // Another chat's update redraws the app, which hands over a new function.
    rerender(<WorktreesPanel {...props} chatsIn={fresh()} />);
    rerender(<WorktreesPanel {...props} chatsIn={fresh()} />);
    expect(ops(calls, "worktreeRemoval")).toHaveLength(previews);
    expect(within(dialog()).getByRole("status").textContent).toContain("Keeping the changes, then removing");
    await act(async () => finish({ record: { ...r, state: "removed", removed: { at: 2, head: SHA, branch: "fix/login", kept: null, files: 0, unpushed: 0 } } }));
    expect(within(dialog()).getByRole("status").textContent).toContain("was removed");
  });

  it("can't remove when Hermes isn't on the worktree's server", async () => {
    const user = userEvent.setup();
    show(removing(removal()).api, {
      chatsIn: async () => {
        throw new Error("Hermes can't see this worktree's record, so it may be running on another computer");
      },
    });
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("may be running on another computer");
    expect(within(dialog()).getByRole("button", { name: "Keep changes and remove" })).toHaveProperty("disabled", true);
  });

  it("stops if a chat started working there after the preview", async () => {
    const { api, calls } = removing(removal());
    let n = 0;
    const user = userEvent.setup();
    show(api, { chatsIn: async () => ({ chats: ++n > 1 ? [{ id: "s2", title: "Another task", archived: false }] : [], more: false }) });
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Keep changes and remove" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("“Another task”");
    expect(ops(calls, "worktreeRemove")).toEqual([]);
  });

  it("shows a refusal and offers Preview again; a lost answer is never sent again", async () => {
    const user = userEvent.setup();
    const { api } = removing(removal(), () => {
      throw new RepoFailure("stale", "The worktree changed since the preview. Nothing was removed. Look at the preview again.");
    });
    show(api);
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Keep changes and remove" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toContain("Nothing was removed");
    expect(within(dialog()).getByRole("button", { name: "Preview again" })).toBeTruthy();
    cleanup();

    const lost = removing(removal(), () => {
      throw new RepoFailure("timeout", "The server didn't answer within 660 s.");
    });
    show(lost.api);
    await user.click(await screen.findByRole("button", { name: "Remove the worktree fix/login…" }));
    await user.click(await within(dialog()).findByRole("button", { name: "Keep changes and remove" }));
    await within(dialog()).findByText(/Whether it was removed isn't known yet/);
    expect(within(dialog()).queryByRole("button", { name: /remove/i })).toBeNull();
    expect(ops(lost.calls, "worktreeRemove")).toHaveLength(1);
  });

  it("offers Remove again for a removal that stopped before the folder went", async () => {
    const r = record({ state: "removing" });
    const { api, calls } = fakeApi((q) => {
      if (q.op === "worktreeList") return listOf([managedRow(r)]);
      if (q.op === "worktreeRemoval") return removal();
      throw new Error(`unexpected ${q.op}`);
    });
    const user = userEvent.setup();
    show(api);
    const card = await screen.findByRole("group", { name: "Worktree fix/login" });
    expect(card.textContent).toContain("Removing it stopped before the folder went");
    await user.click(within(card).getByRole("button", { name: "Remove the worktree fix/login…" }));
    await within(dialog()).findByRole("button", { name: "Keep changes and remove" });
    expect(ops(calls, "worktreeRemoval")).not.toHaveLength(0);
  });

  it("lists removed worktrees with their kept changes, and restores", async () => {
    const r = record({ state: "removed", removed: { at: 2, head: SHA, branch: "fix/login", kept: { ref: "refs/hermes-chat/recovery/x/2", commit: "c" }, files: 2, unpushed: 0 } });
    const { api, calls } = fakeApi((q) => (q.op === "worktreeList" ? listOf([], { removed: [r] }) : { record: { ...r, state: "ready" } }));
    const user = userEvent.setup();
    show(api);
    const removed = await screen.findByRole("list", { name: "Removed worktrees" });
    expect(removed.textContent).toContain("its changes are kept in refs/hermes-chat/recovery/x/2");
    expect(removed.textContent).toContain("the branch fix/login is kept");
    await user.click(within(removed).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(ops(calls, "worktreeRestore")).toEqual([{ op: "worktreeRestore", repo: TOP, id: r.id }]));
  });
});
