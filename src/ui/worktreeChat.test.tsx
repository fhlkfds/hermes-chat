// @vitest-environment jsdom
// Starting a chat in a worktree (ADR 0039), through the whole app: the Repository screen's worktree list, the New chat
// pane, Hermes's `session.create` with the worktree as its folder, and the record on the server that the chat works
// there. Hermes is the repo's FakeHermes; Rust's `repo_git` command is a fake answering as the helper does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
import { REPO_PATH_KEY, type RepoRequest } from "../hermes/repo";
import type { WorktreeRecord } from "../hermes/worktrees";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const TOP = "/srv/app";
const PATH = "/srv/app.worktrees/fix-login";
const SHA = "57a1fb6c0ffee57a1fb6c0ffee57a1fb6c0ffee5";
const RECORD: WorktreeRecord = {
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
  createdBy: "Hermes Chat (test)",
};

const repoCalls: { target: string; request: RepoRequest }[] = [];
vi.mock("./tauriRepo", () => ({
  tauriRepo: {
    run: async (target: string, request: RepoRequest) => {
      repoCalls.push({ target, request });
      switch (request.op) {
        case "status":
          return { top: TOP, gitDir: `${TOP}/.git`, head: SHA, index: "i", branch: { oid: SHA, head: "main", detached: false, upstream: null, ahead: null, behind: null }, operation: null, entries: [], truncated: false };
        case "publishInfo":
          return { head: SHA, branch: "main", remotes: [], upstream: null, remote: null, remoteUrl: "", remoteBranch: "main", remoteHead: null, ahead: null, behind: null, commits: [], bases: [], github: null };
        case "worktreeList":
          return {
            top: TOP,
            main: TOP,
            hasRemote: false,
            newer: false,
            worktrees: [
              { path: TOP, head: SHA, branch: "main", detached: false, locked: null, prunable: false, main: true, current: true, missing: false, record: null, changes: { staged: 0, changed: 0, untracked: 0, conflicts: 0 }, unpushed: null },
              { path: PATH, head: SHA, branch: "fix/login", detached: false, locked: `hermes-chat ${RECORD.id}`, prunable: false, main: false, current: false, missing: false, record: RECORD, changes: { staged: 0, changed: 0, untracked: 0, conflicts: 0 }, unpushed: null },
            ],
            unfinished: [],
            removed: [],
          };
        case "worktreeAttach":
          return { record: { ...RECORD, chats: [request.chat] } };
        default:
          throw new Error(`unexpected ${request.op}`);
      }
    },
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  repoCalls.length = 0;
});

it("starts a chat working in the worktree, records it there, and shows its branch and folder", async () => {
  const s = new FakeHermes();
  s.sessions = [row("older", 1, { pinned: true, title: "Nightly backup" })];
  s.serverDirs = new Set(["/srv", TOP, PATH]);
  localStorage.setItem(REPO_PATH_KEY, TOP);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Repository" }));
  const card = await screen.findByRole("group", { name: "Worktree fix/login" });
  await user.click(within(card).getByRole("button", { name: "Start chat here" }));

  // The New chat pane says where the chat will work, and why.
  const panel = await screen.findByRole("region", { name: "What this chat starts with" });
  expect(panel.textContent).toContain(`${PATH} on ssh://liam@hermes the worktree for fix/login`);

  await user.type(screen.getByPlaceholderText("Message Hermes"), "Fix the login timeout{Enter}");
  await waitFor(() => expect(s.requests.some((r) => r.method === "prompt.submit")).toBe(true));
  await act(async () => void (await hermes.idle()));
  const create = s.requests.find((r) => r.method === "session.create")!.params;
  expect(create).toMatchObject({ cwd: PATH, cwd_explicit: true });

  // The server's record now names the chat, under this connection and profile.
  const stored = s.sessions.find((x) => x.cwd === PATH)!;
  await waitFor(() => expect(repoCalls.map((c) => c.request.op)).toContain("worktreeAttach"));
  const attach = repoCalls.find((c) => c.request.op === "worktreeAttach")!;
  expect(attach.target).toBe("liam@hermes");
  expect(attach.request).toEqual({
    op: "worktreeAttach",
    repo: TOP,
    id: RECORD.id,
    chat: { scope: projectScope(connection, "default"), chat: stored.id, title: "Fix the login timeout" },
  });
  // Hermes keeps the folder too, so a removal finds the chat even without the record.
  expect((await hermes.chatsIn(PATH)).chats.map((c) => c.id)).toEqual([stored.id]);

  // The chat shows the worktree it works in.
  const strip = await screen.findByRole("note", { name: "Worktree" });
  expect(strip.textContent).toContain(`Works in the worktree fix/login ${PATH}`);

  // A New chat afterwards is an ordinary one again: no worktree.
  await user.click(screen.getAllByRole("button", { name: /New chat/ })[0]);
  expect(screen.queryByText(/the worktree for/)).toBeNull();
});
