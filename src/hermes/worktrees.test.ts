// @vitest-environment jsdom
// Starting a chat in a worktree, and asking Hermes which chats work in a folder (ADR 0043).
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { RepoFailure, type RepoApi, type RepoRequest } from "./repo";
import { inside, newWorktreeId, startInWorktree, worktreeChats, type WorktreeStart } from "./worktrees";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const W: WorktreeStart = { target: "liam@hermes", repo: "/srv/app", id: "0123456789abcdef", path: "/srv/app-feature", branch: "feature/login", scope: "s" };

function api(refuse: Partial<Record<RepoRequest["op"], RepoFailure>> = {}) {
  const calls: RepoRequest[] = [];
  const a: RepoApi = {
    run: async (_t, r) => {
      calls.push(r);
      if (refuse[r.op]) throw refuse[r.op];
      return {};
    },
  };
  return { a, calls };
}

describe("startInWorktree", () => {
  it("holds the place, starts the chat, then confirms it with the chat's id and the same token", async () => {
    const { a, calls } = api();
    const order: string[] = [];
    const started = await startInWorktree(a, W, { profile: "default", connection: "liam@hermes" }, async () => {
      order.push(`start after ${calls.map((c) => c.op).join(",")}`);
      return "20261104_chat";
    });
    expect(order).toEqual(["start after worktreeAttach"]);
    expect(calls.map((c) => c.op)).toEqual(["worktreeAttach", "worktreeAttachConfirm"]);
    const [attach, confirm] = calls as [Extract<RepoRequest, { op: "worktreeAttach" }>, Extract<RepoRequest, { op: "worktreeAttachConfirm" }>];
    expect(attach.token).toMatch(/^[0-9a-f]{16}$/);
    expect(confirm).toEqual({ op: "worktreeAttachConfirm", repo: "/srv/app", id: W.id, token: attach.token, chat: "20261104_chat" });
    expect(started).toEqual({ chatId: "20261104_chat", token: attach.token });
  });

  it("starts nothing when the place can't be held", async () => {
    const { a } = api({ worktreeAttach: new RepoFailure("busy", "Another worktree change in this repository is still running.") });
    let asked = false;
    await expect(
      startInWorktree(a, W, { profile: "p", connection: "c" }, async () => {
        asked = true;
        return "x";
      }),
    ).rejects.toThrow("still running");
    expect(asked).toBe(false);
  });

  it("lets the place go when Hermes doesn't start the chat there", async () => {
    const { a, calls } = api();
    await expect(
      startInWorktree(a, W, { profile: "p", connection: "c" }, async () => {
        throw new Error("Hermes didn't start it in /srv/app-feature. Nothing was sent.");
      }),
    ).rejects.toThrow("Nothing was sent");
    await new Promise((r) => setTimeout(r));
    expect(calls.map((c) => c.op)).toEqual(["worktreeAttach", "worktreeDetach"]);
    expect((calls[1] as { token: string }).token).toBe((calls[0] as { token: string }).token);
  });

  it("keeps the place held, and says so, when the chat started but the confirm failed", async () => {
    const { a, calls } = api({ worktreeAttachConfirm: new RepoFailure("ssh", "ssh failed.") });
    const started = await startInWorktree(a, W, { profile: "p", connection: "c" }, async () => "20261104_chat");
    expect(started.chatId).toBe("20261104_chat");
    expect(started.warning).toContain("can't be removed until you detach it");
    expect(calls.some((c) => c.op === "worktreeDetach")).toBe(false);
  });
});

describe("this computer's copy of which chat runs in which worktree", () => {
  it("is kept for each connection and profile, and forgotten by token once detached", () => {
    const chat = { target: W.target, repo: W.repo, id: W.id, path: W.path, branch: W.branch, token: "aaaaaaaaaaaaaaaa" };
    worktreeChats.set("scope-a", "c1", chat);
    expect(worktreeChats.get("scope-a", "c1")).toEqual(chat);
    expect(worktreeChats.get("scope-b", "c1")).toBeUndefined();
    worktreeChats.forgetToken("aaaaaaaaaaaaaaaa");
    expect(worktreeChats.get("scope-a", "c1")).toBeUndefined();
  });

  it("reads an unreadable copy as none", () => {
    localStorage.setItem("hermes-chat.worktree-chats", "{not json");
    expect(worktreeChats.get("s", "c")).toBeUndefined();
  });
});

describe("chats Hermes has working in a folder", () => {
  it("are asked of every profile, and only those inside the folder count, never a sibling sharing its prefix", async () => {
    const s = new FakeHermes();
    s.sessions = [
      row("in", 1, { title: "In the worktree", cwd: "/srv/app-feature", is_active: true }),
      row("deeper", 2, { title: "In a subfolder", cwd: "/srv/app-feature/src" }),
      row("sibling", 3, { title: "Sibling", cwd: "/srv/app-feature-2" }),
      row("elsewhere", 4, { title: "Elsewhere", cwd: "/srv/app" }),
      row("archived", 5, { title: "Archived here", cwd: "/srv/app-feature", archived: true }),
    ];
    s.otherProfiles = { work: [row("w1", 1, { title: "Work chat", cwd: "/srv/app-feature/docs" })] };
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    const found = await hermes.chatsWorkingIn("/srv/app-feature/");
    expect(found.map((c) => `${c.profile}/${c.id}/${c.active}`).sort()).toEqual(["default/archived/false", "default/deeper/false", "default/in/true", "work/w1/false"]);
    expect(s.restRequests.filter((r) => r.path === "/api/sessions" && r.query.get("cwd_prefix") === "/srv/app-feature").map((r) => r.query.get("profile")).sort()).toEqual(["default", "work"]);
  });

  it("reads every page, so an active chat older than the first hundred still counts", async () => {
    const s = new FakeHermes();
    s.sessions = Array.from({ length: 150 }, (_, i) =>
      row(`c${i}`, i + 1, { title: `Chat ${i}`, cwd: "/srv/app-feature", is_active: i === 149, pinned: i < 3 }),
    );
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    const found = await hermes.chatsWorkingIn("/srv/app-feature");
    expect(found).toHaveLength(150);
    expect(found.find((c) => c.id === "c149")?.active).toBe(true);
  });

  it("rejects, rather than answering for some profiles, when one can't be asked", async () => {
    const s = new FakeHermes();
    s.otherProfiles = { work: [] };
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    // `work` is listed, but its sessions can't be read (as a profile whose store is unreadable answers).
    const store = (s as unknown as { store: (p?: string | null) => unknown }).store.bind(s);
    (s as unknown as { store: (p?: string | null) => unknown }).store = (p) => (p === "work" ? undefined : store(p));
    await expect(hermes.chatsWorkingIn("/srv/x")).rejects.toThrow(/404/);
  });
});

describe("helpers", () => {
  it("tells a folder's inside from a sibling with the same prefix", () => {
    expect(inside("/srv/app-feature", "/srv/app-feature")).toBe(true);
    expect(inside("/srv/app-feature/src", "/srv/app-feature/")).toBe(true);
    expect(inside("/srv/app-feature-2", "/srv/app-feature")).toBe(false);
  });

  it("makes ids the helper accepts", () => {
    for (let i = 0; i < 20; i++) expect(newWorktreeId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
