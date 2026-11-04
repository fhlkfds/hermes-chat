// @vitest-environment jsdom
// Starting a chat in a worktree (ADR 0040), through the whole app: the Repository screen's worktree list, the New chat
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

const REGISTRY = `${TOP}/.git/hermes-chat/worktrees.json`;
const repoCalls: { target: string; request: RepoRequest }[] = [];
/** Set to make the server refuse to record a chat. */
let attachFails = false;
/** Set to hold the server's answer to recording a chat until it's called. */
let attachHeld: Promise<void> | undefined;
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
            registry: REGISTRY,
          };
        case "worktreeAttach":
          if (attachFails) throw { kind: "ssh-unreachable", message: "ssh couldn't reach the server.", output: "" };
          if (attachHeld) await attachHeld;
          return { record: { ...RECORD, chats: [request.chat] } };
        case "worktreeDetach":
          return { record: RECORD };
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
  attachFails = false;
  attachHeld = undefined;
});

/** A Hermes on the worktree's server: it has the folder, and can read the worktree's record. */
function server(registry: string | null = JSON.stringify({ v: 1, worktrees: { [RECORD.id]: RECORD } })) {
  const s = new FakeHermes();
  s.sessions = [row("older", 1, { pinned: true, title: "Nightly backup" })];
  s.serverDirs = new Set(["/srv", TOP, PATH]);
  if (registry !== null) s.serverFiles = { [REGISTRY]: registry };
  return s;
}

async function startFromWorktree(s: FakeHermes) {
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
  await screen.findByRole("region", { name: "What this chat starts with" });
  // Drafts live on for the app's whole run, here across tests: start from an empty composer.
  await user.clear(screen.getByPlaceholderText("Message Hermes"));
  await user.type(screen.getByPlaceholderText("Message Hermes"), "Fix the login timeout{Enter}");
  return { hermes, user, connection };
}

it("doesn't start a chat when Hermes can't see the worktree's record: it may be another computer", async () => {
  const s = server(null);
  await startFromWorktree(s);
  expect((await screen.findByRole("alert")).textContent).toMatch(/may be running on another computer/);
  expect(s.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit")).toEqual([]);
  expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("Fix the login timeout");
});

it("drops a chat whose profile changed while the worktree was recording it, and takes it off the record", async () => {
  let release!: () => void;
  attachHeld = new Promise((r) => (release = r));
  const s = server();
  s.otherProfiles = { work: [] };
  const { hermes } = await startFromWorktree(s);
  await waitFor(() => expect(repoCalls.some((c) => c.request.op === "worktreeAttach")).toBe(true));
  await act(async () => void (await hermes.switchProfile("work")));
  await act(async () => release());
  await waitFor(() => expect(repoCalls.some((c) => c.request.op === "worktreeDetach")).toBe(true));
  const chatId = (repoCalls.find((c) => c.request.op === "worktreeAttach")!.request as { chat: { chat: string } }).chat.chat;
  expect(repoCalls.find((c) => c.request.op === "worktreeDetach")!.request).toMatchObject({ op: "worktreeDetach", id: RECORD.id, chat: chatId });
  expect(s.requests.some((r) => r.method === "prompt.submit")).toBe(false);
  expect(s.requests.some((r) => r.method === "session.close")).toBe(true);
  // Nothing of the default profile's chat shows up under work.
  expect(hermes.getSnapshot().chats.some((c) => c.id === chatId)).toBe(false);
});

it("doesn't send anything when the worktree can't record the chat, and drops the session", async () => {
  attachFails = true;
  const s = server();
  await startFromWorktree(s);
  expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't record this chat.*Nothing was sent/);
  expect(s.requests.some((r) => r.method === "prompt.submit")).toBe(false);
  expect(s.requests.some((r) => r.method === "session.close")).toBe(true);
  expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("Fix the login timeout");
});

it("starts a chat working in the worktree, records it there, and shows its branch and folder", async () => {
  const s = server();
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

  await user.clear(screen.getByPlaceholderText("Message Hermes"));
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
