// @vitest-environment jsdom
// The Repository screen's Worktrees view (ADR 0041) against a fake of Rust's `repo_git` and `repo_git_stream`
// commands. Its answers have the shapes repo_worktree_helper.py gives for real repositories
// (src-tauri/tests/repo_worktree.rs, which runs the helper itself).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoFailure, type RepoApi, type RepoRequest, type Status } from "../hermes/repo";
import type { HermesChatIn, Progress, RemovalPlan, Worktree, WorktreeList, WorktreePlan, WorktreeRecord } from "../hermes/worktrees";
import { RepositoryScreen } from "./Repository";
import type { WorktreeHooks } from "./Worktrees";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const MAIN = "/srv/app";
const WT = "/srv/app-feature-login";
const ID = "0123456789abcdef";

const status = (top = MAIN): Status => ({
  top,
  gitDir: `${top}/.git`,
  head: "a".repeat(40),
  index: "i",
  branch: { oid: "a".repeat(40), head: "main", detached: false, upstream: null, ahead: null, behind: null },
  operation: null,
  entries: [],
  truncated: false,
});

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  id: ID,
  path: WT,
  branch: "feature/login",
  newBranch: true,
  base: "main",
  baseOid: "a".repeat(40),
  source: MAIN,
  createdAt: 1,
  protected: false,
  state: "ready",
  running: false,
  setup: { state: "done", entries: [], log: "Copied .env (9 bytes)" },
  chats: [],
  ...over,
});

const tree = (over: Partial<Worktree> = {}): Worktree => ({
  path: WT,
  head: "b".repeat(40),
  branch: "feature/login",
  detached: false,
  bare: false,
  locked: `hermes-chat: managed worktree ${ID}`,
  prunable: null,
  main: false,
  exists: true,
  managed: record(),
  dirty: { staged: 0, unstaged: 1, untracked: 2, conflicts: 0 },
  unpublished: 1,
  lost: 0,
  upstream: null,
  ahead: null,
  behind: null,
  submodules: 0,
  protected: [],
  ...over,
});

const mainTree = (): Worktree =>
  tree({ path: MAIN, branch: "main", main: true, locked: null, managed: null, unpublished: 0, dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, protected: [{ kind: "main", message: "This is the repository's main checkout." }] });

const listOf = (worktrees: Worktree[], over: Partial<WorktreeList> = {}): WorktreeList => ({
  top: MAIN,
  main: MAIN,
  commonDir: `${MAIN}/.git`,
  worktrees,
  missing: [],
  kept: [],
  detailLimit: 40,
  git: "2.47",
  ...over,
});

const plan = (over: Partial<WorktreePlan> = {}): WorktreePlan => ({
  repo: MAIN,
  main: MAIN,
  source: MAIN,
  base: "main",
  baseOid: "a".repeat(40),
  baseRef: "refs/heads/main",
  baseSubject: "first",
  branch: "feature/login",
  newBranch: true,
  path: WT,
  suggested: true,
  sourceDirty: { staged: 0, unstaged: 1, untracked: 1, conflicts: 0 },
  submodules: [],
  setup: [{ entry: ".env", action: "copy", size: 9 }],
  setupCommands: "unsupported",
  stamp: "plan-stamp",
  ...over,
});

const removal = (over: Partial<RemovalPlan> = {}): RemovalPlan => ({
  path: WT,
  branch: "feature/login",
  head: "b".repeat(40),
  detached: false,
  files: [
    { path: "README.md", kind: "change", xy: ".M", sub: false, size: 12 },
    { path: "notes/new.txt", kind: "untracked", xy: "??", sub: false, size: 10 },
  ],
  fileCount: 2,
  filesCut: false,
  ignored: [".env"],
  unpublished: [{ sha: "c".repeat(40), subject: "unpushed work" }],
  unpublishedCount: 1,
  lost: 0,
  submodules: [],
  processes: [],
  blockers: [],
  operation: null,
  keep: true,
  stamp: "removal-stamp",
  worktree: record(),
  ...over,
});

type Answer = (r: RepoRequest, target: string) => unknown | Promise<unknown>;

/** Records each request; `answers[op]` answers it, and `progress[op]` is streamed first when `stream` is used. */
function fakeApi(answers: Partial<Record<RepoRequest["op"], Answer>>, progress: Partial<Record<RepoRequest["op"], Progress[]>> = {}) {
  const calls: { target: string; request: RepoRequest; streamed: boolean }[] = [];
  const answer = async (target: string, request: RepoRequest) => {
    const a = answers[request.op];
    if (request.op === "status") return a ? a(request, target) : status(request.repo);
    if (request.op === "publishInfo") throw new RepoFailure("git", "no remote");
    if (!a) throw new Error(`unexpected ${request.op}`);
    return a(request, target);
  };
  const api: RepoApi = {
    run: async (target, request) => {
      calls.push({ target, request, streamed: false });
      return answer(target, request);
    },
    stream: async (target, request, onProgress) => {
      calls.push({ target, request, streamed: true });
      for (const p of progress[request.op] ?? []) onProgress(p);
      return answer(target, request);
    },
  };
  const ops = (op: RepoRequest["op"]) => calls.filter((c) => c.request.op === op).map((c) => c.request);
  return { api, calls, ops };
}

const hooksOf = (over: Partial<WorktreeHooks> = {}): WorktreeHooks => ({
  profile: "default",
  connection: "liam@hermes",
  chatTitle: (id) => ({ "20261104_a": "Fix the login page" })[id],
  hermesChatsIn: async () => [],
  onStartChat: vi.fn(),
  ...over,
});

const screenWith = (api: RepoApi, hooks: WorktreeHooks) => (
  <StrictMode>
    <RepositoryScreen api={api} initialTarget="liam@hermes" initialPath={MAIN} recent={[]} suggestions={[]} onOpened={() => {}} onTarget={() => {}} worktrees={hooks} onClose={() => {}} />
  </StrictMode>
);

async function show(api: RepoApi, hooks: WorktreeHooks = hooksOf()) {
  const user = userEvent.setup();
  const view = render(screenWith(api, hooks));
  rerenderWith = (h) => view.rerender(screenWith(api, h));
  await screen.findByRole("tab", { name: "Worktrees" });
  await user.click(screen.getByRole("tab", { name: "Worktrees" }));
  return user;
}

/** Draws the screen again with new hooks, as the app does whenever a chat streams. */
let rerenderWith: (hooks: WorktreeHooks) => void = () => {};

const rowOf = (path: string) => screen.getByText(path, { selector: ".wt-path" }).closest(".wt-row") as HTMLElement;

describe("the Worktrees view", () => {
  it("shows loading, then each worktree with its branch, changes, unpublished commits and protection", async () => {
    let answer!: (l: WorktreeList) => void;
    const { api } = fakeApi({ worktreeList: () => new Promise((r) => (answer = r)) });
    await show(api);
    expect(screen.getByText("Reading the worktrees…")).toBeTruthy();
    await act(async () => answer(listOf([mainTree(), tree()])));
    const row = rowOf(WT);
    expect(row.textContent).toContain("feature/login");
    expect(row.textContent).toContain("1 changed, 2 untracked");
    expect(row.textContent).toContain("1 commit no remote has");
    expect(row.textContent).toContain("Made here");
    const main = rowOf(MAIN);
    expect(main.textContent).toContain("Main checkout");
    expect(within(main).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(main).queryByRole("button", { name: /Start a chat here/ })).toBeNull();
  });

  it("says when there are no other worktrees yet", async () => {
    const { api } = fakeApi({ worktreeList: () => listOf([mainTree()]) });
    await show(api);
    expect(await screen.findByText(/No other worktrees yet/)).toBeTruthy();
  });

  it("says plainly when the server can't do worktrees, and the Changes view still works", async () => {
    const { api } = fakeApi({ worktreeList: () => Promise.reject(new RepoFailure("unsupported", "Worktrees here need Git 2.36 or newer on the server; it has 2.30.")) });
    const user = await show(api);
    const banner = await screen.findByText(/Worktrees aren't supported on this server/);
    expect(banner.textContent).toContain("Git 2.36");
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    expect(await screen.findByText(/No changes: the working tree matches HEAD/)).toBeTruthy();
  });

  it("shows a failure to read, with ssh's words, and reads again on Refresh", async () => {
    let fail = true;
    const { api, ops } = fakeApi({ worktreeList: () => (fail ? Promise.reject(new RepoFailure("ssh-unreachable", "ssh couldn't reach the server.", "No route to host")) : listOf([mainTree()])) });
    const user = await show(api);
    expect((await screen.findByRole("alert")).textContent).toContain("No route to host");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Read the worktrees again" }));
    await screen.findByText(/No other worktrees yet/);
    expect(ops("worktreeList").length).toBeGreaterThanOrEqual(2);
  });

  it("drops a late answer once a newer read was asked for", async () => {
    const waiting: ((l: WorktreeList) => void)[] = [];
    const { api } = fakeApi({ worktreeList: () => new Promise<WorktreeList>((r) => waiting.push(r)) });
    const user = await show(api);
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Read the worktrees again" }));
    const n = waiting.length;
    await act(async () => waiting[n - 1](listOf([mainTree(), tree()])));
    // The older read answers last, with a list that has no worktrees: it must not replace the newer one.
    await act(async () => waiting.slice(0, n - 1).forEach((r) => r(listOf([mainTree()]))));
    expect(rowOf(WT)).toBeTruthy();
    expect(screen.queryByText(/No other worktrees yet/)).toBeNull();
  });

  it("names an attached chat by its title in this profile, and only by profile in another", async () => {
    const chats = [
      { token: "aaaaaaaaaaaaaaaa", chat: "20261104_a", profile: "default", connection: "liam@hermes", state: "attached" as const, at: 1 },
      { token: "bbbbbbbbbbbbbbbb", chat: "20261104_b", profile: "work", connection: "liam@hermes", state: "attached" as const, at: 1 },
      { token: "cccccccccccccccc", chat: null, profile: "default", connection: "liam@hermes", state: "starting" as const, at: 1 },
    ];
    const { api } = fakeApi({ worktreeList: () => listOf([mainTree(), tree({ managed: record({ chats }) })]) });
    await show(api, hooksOf({ chatTitle: (id) => ({ "20261104_a": "Fix the login page", "20261104_b": "Secret work title" })[id] }));
    const list = await screen.findByRole("list", { name: `Chats working in ${WT}` });
    expect(list.textContent).toContain('"Fix the login page"');
    // Another profile's chat isn't looked up in this one's list.
    expect(list.textContent).toContain("the chat 20261104_b in the work profile");
    expect(list.textContent).not.toContain("Secret work title");
    expect(list.textContent).toContain("a chat being started (starting; not confirmed)");
    // A quiet chat still blocks removal.
    const remove = within(rowOf(WT)).getByRole("button", { name: `Remove ${WT}…` }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(rowOf(WT).textContent).toContain("Can't be removed: Chats work in it: detach them first.");
  });

  it("detaches a chat only after saying the chat keeps working in the folder", async () => {
    let chats = [{ token: "aaaaaaaaaaaaaaaa", chat: "20261104_a", profile: "default", connection: "liam@hermes", state: "attached" as const, at: 1 }];
    const { api, ops } = fakeApi({
      worktreeList: () => listOf([mainTree(), tree({ managed: record({ chats }) })]),
      worktreeDetach: () => {
        chats = [];
        return record();
      },
    });
    const user = await show(api);
    await user.click(await screen.findByRole("button", { name: `Detach "Fix the login page" from ${WT}` }));
    const confirm = screen.getByRole("group", { name: "Detach the chat" });
    expect(confirm.textContent).toContain(`The chat keeps working in ${WT}`);
    expect(ops("worktreeDetach")).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(ops("worktreeDetach")).toEqual([{ op: "worktreeDetach", repo: MAIN, id: ID, token: "aaaaaaaaaaaaaaaa" }]));
    await waitFor(() => expect((within(rowOf(WT)).getByRole("button", { name: `Remove ${WT}…` }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("protects a worktree from removal, and lists one made by hand without offering to remove it", async () => {
    const byHand = tree({ path: "/srv/byhand", branch: "byhand", locked: null, managed: null, protected: [{ kind: "unmanaged", message: "Hermes Chat didn't make this worktree, so it doesn't remove it." }] });
    let marked = false;
    const { api, ops } = fakeApi({
      worktreeList: () => listOf([mainTree(), tree({ managed: record({ protected: marked }) }), byHand]),
      worktreeProtect: (r) => {
        marked = (r as { protected: boolean }).protected;
        return record({ protected: marked });
      },
    });
    const user = await show(api);
    expect(rowOf("/srv/byhand").textContent).toContain("Not made by Hermes Chat");
    expect(within(rowOf("/srv/byhand")).queryByRole("button", { name: /Remove/ })).toBeNull();
    await user.click(within(rowOf(WT)).getByRole("button", { name: "Protect" }));
    await waitFor(() => expect(rowOf(WT).textContent).toContain("Protected"));
    expect(ops("worktreeProtect")).toEqual([{ op: "worktreeProtect", repo: MAIN, id: ID, protected: true }]);
    expect((within(rowOf(WT)).getByRole("button", { name: `Remove ${WT}…` }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("New worktree", () => {
  it("previews the folder, base and setup, creates it with progress, then starts a chat in it", async () => {
    const onStartChat = vi.fn();
    const { api, ops, calls } = fakeApi(
      {
        worktreeList: () => listOf([mainTree()]),
        worktreePlan: () => plan(),
        worktreeCreate: (r) => ({ worktree: record({ id: (r as { id: string }).id }), output: "Preparing worktree" }),
      },
      { worktreeCreate: [{ step: "create", message: `Creating ${WT} on feature/login`, at: 1 }, { step: "setup", message: "Copied .env (9 bytes)", at: 2 }] },
    );
    const user = await show(api, hooksOf({ onStartChat }));
    await user.click(await screen.findByRole("button", { name: /New worktree/ }));
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    await user.type(within(dialog).getByLabelText("New branch name"), "feature/login");
    await user.clear(within(dialog).getByLabelText(/Base/));
    await user.type(within(dialog).getByLabelText(/Base/), "main");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    const facts = await within(dialog).findByLabelText("What will be made");
    expect(facts.textContent).toContain(WT);
    expect(facts.textContent).toContain("refs/heads/main at aaaaaaaaaaaa");
    expect(facts.textContent).toContain(`${MAIN} has changes (1 changed, 1 untracked). They stay there`);
    expect(facts.textContent).toContain(".env copied (9 bytes)");
    expect(facts.textContent).toContain("Setup commands (an install script) aren't run");
    expect(ops("worktreePlan")).toEqual([{ op: "worktreePlan", repo: MAIN, base: "main", branch: "feature/login", newBranch: true, path: "", setup: true }]);

    // Changing the form makes the preview old: it must be checked again.
    await user.type(within(dialog).getByLabelText("New branch name"), "x");
    expect(within(dialog).queryByRole("button", { name: "Create worktree" })).toBeNull();
    await user.type(within(dialog).getByLabelText("New branch name"), "{Backspace}");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.click(await within(dialog).findByRole("button", { name: "Create worktree" }));

    const made = await screen.findByRole("dialog", { name: "Worktree made" });
    expect(within(made).getByRole("log", { name: "Progress" }).textContent).toContain("Copied .env (9 bytes)");
    expect(made.textContent).toContain(`Made ${WT} on feature/login, and setup ran.`);
    const create = ops("worktreeCreate")[0] as Extract<RepoRequest, { op: "worktreeCreate" }>;
    expect(create).toMatchObject({ repo: MAIN, base: "main", branch: "feature/login", newBranch: true, path: WT, setup: true, expect: "plan-stamp" });
    expect(create.id).toMatch(/^[0-9a-f]{16}$/);
    expect(calls.find((c) => c.request.op === "worktreeCreate")!.streamed).toBe(true);

    await user.click(within(made).getByRole("button", { name: /Start a chat in it/ }));
    expect(onStartChat).toHaveBeenCalledWith({ target: "liam@hermes", repo: MAIN, id: create.id, path: WT, branch: "feature/login" });
  });

  it("uses an existing branch, and shows Git's refusal beside the form", async () => {
    const { api, ops } = fakeApi({
      worktreeList: () => listOf([mainTree()]),
      worktreePlan: () => Promise.reject(new RepoFailure("checked-out", "release is already checked out in /srv/app-release. Git allows a branch in one worktree at a time.")),
    });
    const user = await show(api);
    await user.click(await screen.findByRole("button", { name: /New worktree/ }));
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    await user.click(within(dialog).getByRole("radio", { name: "Existing local branch" }));
    expect(within(dialog).queryByLabelText(/Base/)).toBeNull();
    await user.type(within(dialog).getByLabelText("Branch to check out"), "release");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already checked out in /srv/app-release");
    expect(ops("worktreePlan")[0]).toMatchObject({ base: "", branch: "release", newBranch: false });
    expect(ops("worktreeCreate")).toEqual([]);
  });

  it("keeps a worktree whose setup failed, says so, and Retry runs setup again from the list", async () => {
    let state: WorktreeRecord["state"] = "setup-failed";
    const failedSetup = () =>
      record({ state, setup: { state: state === "ready" ? "done" : "failed", entries: [], log: "Failed data/seed.db: Not a directory" } });
    const { api, ops } = fakeApi({
      worktreeList: () => listOf([mainTree(), tree({ managed: failedSetup() })]),
      worktreePlan: () => plan({ setup: [{ entry: "data/seed.db", action: "copy", size: 5 }] }),
      worktreeCreate: () => ({ worktree: failedSetup() }),
      worktreeSetup: () => {
        state = "ready";
        return { worktree: failedSetup() };
      },
    });
    const user = await show(api);
    await user.click(await screen.findByRole("button", { name: /New worktree/ }));
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    await user.type(within(dialog).getByLabelText("New branch name"), "feature/login");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.click(await within(dialog).findByRole("button", { name: "Create worktree" }));
    const made = await screen.findByRole("dialog", { name: "Worktree made" });
    expect(made.textContent).toContain("but setup failed. The worktree is kept");
    expect(made.textContent).toContain("Failed data/seed.db: Not a directory");
    // Open and Start a chat stay offered: the worktree is usable.
    expect(within(made).getByRole("button", { name: "Open" })).toBeTruthy();
    await user.click(within(made).getByRole("button", { name: "Close" }));

    const row = rowOf(WT);
    expect(row.textContent).toContain("Setup failed");
    await user.click(within(row).getByRole("button", { name: /Retry setup/ }));
    await waitFor(() => expect(ops("worktreeSetup")).toEqual([{ op: "worktreeSetup", repo: MAIN, id: ID }]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(`Setup finished in ${WT}.`));
  });

  it("after a connection drop during creation, asks the record how far it got instead of creating again", async () => {
    let listed = listOf([mainTree()]);
    const { api, ops } = fakeApi(
      {
        worktreeList: () => listed,
        worktreePlan: () => plan(),
        worktreeCreate: (r) => {
          // The server got as far as setup, then ssh dropped.
          listed = listOf([mainTree(), tree({ managed: record({ id: (r as { id: string }).id, state: "setup-interrupted", setup: { state: "running", entries: [], log: "" } }) })]);
          return Promise.reject(new RepoFailure("ssh", "ssh failed.", "Connection to hermes closed by remote host."));
        },
      },
      { worktreeCreate: [{ step: "create", message: `Creating ${WT}`, at: 1 }] },
    );
    const user = await show(api);
    await user.click(await screen.findByRole("button", { name: /New worktree/ }));
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    await user.type(within(dialog).getByLabelText("New branch name"), "feature/login");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.click(await within(dialog).findByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(dialog.textContent).toContain("The server has it: Setup was cut off."));
    expect(dialog.textContent).toContain("The connection dropped before the server answered");
    expect(ops("worktreeCreate")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    const row = rowOf(WT);
    expect(row.textContent).toContain("Setup was cut off");
    expect(within(row).getByRole("button", { name: /Retry setup/ })).toBeTruthy();
  });

  it("closes on Escape and gives focus back to New worktree", async () => {
    const { api } = fakeApi({ worktreeList: () => listOf([mainTree()]) });
    const user = await show(api);
    const opener = await screen.findByRole("button", { name: /New worktree/ });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("New branch name"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Remove", () => {
  const setup = (answers: Partial<Record<RepoRequest["op"], Answer>> = {}, hooks: Partial<WorktreeHooks> = {}) => {
    let gone = false;
    const fake = fakeApi({
      worktreeList: () => listOf(gone ? [mainTree()] : [mainTree(), tree()]),
      worktreeRemovePlan: () => removal(),
      worktreeRemove: () => {
        gone = true;
        return { removed: WT, branch: "feature/login", unpublished: 1, kept: { ref: `refs/hermes-chat/kept/${ID}-20261104120000`, commit: "d".repeat(40), files: 2 } };
      },
      ...answers,
    });
    return { ...fake, hooks: hooksOf(hooks) };
  };

  it("previews every file it keeps, the commits that stay on the branch and the ignored files it doesn't keep, then keeps and removes", async () => {
    const { api, ops, hooks } = setup();
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await within(dialog).findByLabelText("Files that will be kept");
    expect(dialog.textContent).toContain("feature/login is kept: branches are never deleted here.");
    expect(dialog.textContent).toContain("2 changed or untracked files, as a commit under refs/hermes-chat/kept/");
    expect(within(dialog).getByLabelText("Files that will be kept").textContent).toContain("notes/new.txt");
    expect(within(dialog).getByLabelText("Commits no remote has").textContent).toContain("unpushed work");
    expect(dialog.textContent).toContain("Ignored files go with the folder and aren't kept: .env");
    await user.click(within(dialog).getByRole("button", { name: "Keep changes and remove" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain(`Its changes are in refs/hermes-chat/kept/${ID}-20261104120000`));
    expect(ops("worktreeRemove")).toEqual([{ op: "worktreeRemove", repo: MAIN, id: ID, expect: "removal-stamp" }]);
  });

  it("can't remove while something blocks it, and says what", async () => {
    const { api, hooks } = setup({
      worktreeRemovePlan: () =>
        removal({
          blockers: [
            { kind: "submodule", message: "The submodule vendor/lib has changes that removing the folder would lose." },
            { kind: "processes", message: "1 process works in the folder (node 4242)." },
          ],
        }),
    });
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    const alert = await within(dialog).findByText(/It can't be removed/);
    expect(alert.closest("[role=alert]")!.textContent).toContain("vendor/lib");
    expect(alert.closest("[role=alert]")!.textContent).toContain("node 4242");
    expect((within(dialog).getByRole("button", { name: "Keep changes and remove" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is blocked while Hermes works in the folder, and asks the owner to check quiet chats from other apps", async () => {
    let chats: HermesChatIn[] = [{ id: "s1", title: "Refactor auth", profile: "work", cwd: `${WT}/src`, active: true }];
    const { api, ops, hooks } = setup({}, { hermesChatsIn: async () => chats });
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    let dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await within(dialog).findByText(/Hermes is working in it now, in "Refactor auth" \(work\)/);
    expect((within(dialog).getByRole("button", { name: "Keep changes and remove" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    chats = [{ id: "s1", title: "Refactor auth", profile: "work", cwd: `${WT}/src`, active: false }];
    await user.click(screen.getByRole("button", { name: `Remove ${WT}…` }));
    dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await within(dialog).findByText(/A quiet chat may still be needed/);
    const remove = within(dialog).getByRole("button", { name: "Keep changes and remove" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await user.click(within(dialog).getByRole("checkbox", { name: /none of them needs this folder/ }));
    expect(remove.disabled).toBe(false);
    await user.click(remove);
    await waitFor(() => expect(ops("worktreeRemove")).toHaveLength(1));
  });

  it("says Hermes couldn't be asked when it isn't connected, and needs the owner's word", async () => {
    const { api, hooks } = setup({}, { hermesChatsIn: undefined });
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await within(dialog).findByText(/Hermes isn't connected, so it couldn't be asked/);
    expect((within(dialog).getByRole("button", { name: "Keep changes and remove" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses when the files changed since the preview, and offers to check again", async () => {
    let n = 0;
    const { api, ops, hooks } = setup({
      worktreeRemovePlan: () => removal({ stamp: `stamp-${++n}` }),
      worktreeRemove: () => Promise.reject(new RepoFailure("stale", "Its files, commits or chats changed since the preview. Nothing was removed. Check the new preview.")),
    });
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await user.click(await within(dialog).findByRole("button", { name: "Keep changes and remove" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Nothing was removed");
    expect(within(dialog).queryByRole("button", { name: "Keep changes and remove" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /Check again/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Keep changes and remove" }));
    // The second try sends the stamp of the preview read again, never the refused one.
    await waitFor(() => expect(ops("worktreeRemove")).toHaveLength(2));
    const [first, second] = ops("worktreeRemove").map((r) => Number((r as { expect: string }).expect.slice(6)));
    expect(second).toBeGreaterThan(first);
  });
});

describe("kept changes and records without a worktree", () => {
  it("restores kept changes in a new worktree from their ref, and forgets a creation cut off before Git made it", async () => {
    const kept = { ref: `refs/hermes-chat/kept/${ID}-20261104120000`, commit: "d".repeat(40), at: 1_762_257_600, subject: "Kept by Hermes Chat", id: ID, path: WT, branch: "feature/login", files: 2 };
    const missing = record({ id: "fedcba9876543210", path: "/srv/app-never", branch: "never", state: "create-interrupted", exists: false });
    let listed = listOf([mainTree()], { kept: [kept], missing: [missing] });
    const { api, ops } = fakeApi({
      worktreeList: () => listed,
      worktreeForget: () => {
        listed = listOf([mainTree()], { kept: [kept] });
        return { forgotten: missing.id };
      },
      worktreePlan: () => plan({ base: kept.ref, baseRef: kept.ref, branch: "feature/login-restored" }),
    });
    const user = await show(api);
    const section = await screen.findByRole("region", { name: "Recorded, but not on disk" });
    expect(section.textContent).toContain("Making it on never was cut off before Git made it");
    await user.click(within(section).getByRole("button", { name: "Forget it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Recorded, but not on disk" })).toBeNull());
    expect(ops("worktreeForget")).toEqual([{ op: "worktreeForget", repo: MAIN, id: missing.id }]);

    const keptSection = screen.getByRole("region", { name: "Changes kept from removed worktrees" });
    await user.click(within(keptSection).getByRole("button", { name: /Restore in a new worktree/ }));
    const dialog = screen.getByRole("dialog", { name: "New worktree" });
    expect((within(dialog).getByLabelText(/Base/) as HTMLInputElement).value).toBe(kept.ref);
    expect((within(dialog).getByLabelText("New branch name") as HTMLInputElement).value).toBe("feature/login-restored");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(ops("worktreePlan")[0]).toMatchObject({ base: kept.ref, branch: "feature/login-restored", newBranch: true }));
  });
});

describe("the Changes and Worktrees views", () => {
  it("are tabs that arrow keys move between, and Open shows a worktree's changes", async () => {
    const { api, ops } = fakeApi({ worktreeList: () => listOf([mainTree(), tree()]) });
    const user = await show(api);
    const worktrees = screen.getByRole("tab", { name: "Worktrees" });
    expect(worktrees.getAttribute("aria-selected")).toBe("true");
    worktrees.focus();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowRight}");
    await user.click(within(await waitFor(() => rowOf(WT))).getByRole("button", { name: "Open" }));
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(ops("status").some((r) => r.repo === WT)).toBe(true));
  });
});

describe("the removal dialog while the app around it changes", () => {
  it("isn't reset by the app drawing again, before or during the removal", async () => {
    let finish!: (v: unknown) => void;
    const { api, ops } = fakeApi({
      worktreeList: () => listOf([mainTree(), tree()]),
      worktreeRemovePlan: () => removal(),
      worktreeRemove: () => new Promise((r) => (finish = r)),
    });
    const user = await show(api);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    await within(dialog).findByLabelText("Files that will be kept");
    const reads = ops("worktreeRemovePlan").length;
    rerenderWith(hooksOf());
    rerenderWith(hooksOf());
    expect(ops("worktreeRemovePlan")).toHaveLength(reads);
    await user.click(within(dialog).getByRole("button", { name: "Keep changes and remove" }));
    expect(within(dialog).getByRole("status").textContent).toContain("Keeping its changes, then removing it");
    rerenderWith(hooksOf());
    // Still removing: not read again, and it can't be closed while Git works.
    expect(within(dialog).getByRole("status").textContent).toContain("Keeping its changes, then removing it");
    expect(ops("worktreeRemovePlan")).toHaveLength(reads);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ removed: WT, branch: "feature/login", unpublished: 0, kept: null }));
    await within(dialog).findByText(new RegExp(`Removed ${WT}`));
  });

  it("forgets that Hermes found no chats once Hermes goes away, and asks for the owner's word", async () => {
    const { api, hooks } = { ...fakeApi({ worktreeList: () => listOf([mainTree(), tree()]), worktreeRemovePlan: () => removal() }), hooks: hooksOf() };
    const user = await show(api, hooks);
    await user.click(await screen.findByRole("button", { name: `Remove ${WT}…` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${WT}` });
    const remove = await within(dialog).findByRole("button", { name: "Keep changes and remove" });
    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(false));
    rerenderWith(hooksOf({ hermesChatsIn: undefined }));
    await within(dialog).findByText(/Hermes isn't connected, so it couldn't be asked/);
    expect((within(dialog).getByRole("button", { name: "Keep changes and remove" }) as HTMLButtonElement).disabled).toBe(true);
    // Back again: it is asked again, and finds a chat working there now.
    rerenderWith(hooksOf({ hermesChatsIn: async () => [{ id: "s9", title: "Late chat", profile: "default", cwd: WT, active: true }] }));
    await within(dialog).findByText(/Hermes is working in it now, in "Late chat"/);
  });
});
