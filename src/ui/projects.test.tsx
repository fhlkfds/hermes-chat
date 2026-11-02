// @vitest-environment jsdom
// Projects in the app: the switcher under the profile's name, a chat's menu, and the project screen, against a fake
// Hermes that answers `projects.*`, `GET /api/fs/list` and `GET /api/git/worktrees` as the deployed server did.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { PROJECTS_KEY } from "../hermes/projectLinks";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const project = (id: string, name: string, folders: string[] = []): FakeProject => ({
  id,
  slug: id,
  name,
  primary_path: folders[0] ?? null,
  archived: false,
  created_at: 1,
  folders: folders.map((path, i) => ({ path, label: null, is_primary: i === 0, added_at: 1 })),
});

/** Three Active chats and two Settled ones, one of each unread; a project that already exists; a repo with a worktree. */
function server() {
  const s = new FakeHermes();
  s.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks", last_read_at: 0 }),
    row("login", 3, { pinned: true, title: "Login page" }),
    row("old", 5, { title: "Old notes", last_read_at: 0 }),
    row("deps", 6, { title: "Dependency bump" }),
  ];
  s.projects.default = [project("p_budget", "Budget Tracker", ["/srv/budget"])];
  s.serverDirs = new Set(["/srv", "/srv/app", "/srv/app-feature", "/srv/budget"]);
  s.serverFiles = new Set(["/srv/readme.md"]);
  s.repos = [[{ path: "/srv/app", branch: "main" }, { path: "/srv/app-feature", branch: "feature/login" }]];
  return s;
}

async function launch(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const switcher = () => document.querySelector<HTMLElement>(".project-btn")!;
const listedTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);
const activeTitles = () => [...document.querySelectorAll(".sb-scroll .row-open .row-title")].map((e) => e.textContent);
const onScreen = () => document.querySelector(".chat-title span")?.textContent;

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(switcher());
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

async function putInProject(user: ReturnType<typeof userEvent.setup>, chat: string, name: string) {
  const open = screen.getByRole("button", { name: new RegExp(chat) });
  await user.pointer({ keys: "[MouseRight]", target: open });
  await user.click(await screen.findByRole("menuitemcheckbox", { name }));
}

describe("the project switcher", () => {
  it("lists the profile's projects in Hermes, and shows every chat until one is picked", async () => {
    const s = server();
    await launch(s);
    expect(switcher().textContent).toContain("All chats");
    expect(s.requests.filter((r) => r.method === "projects.list").map((r) => r.params)).toEqual([{ profile: "default" }]);
    expect(activeTitles()).toEqual(["Nightly backup", "NAS disks", "Login page"]);
    const user = userEvent.setup();
    await user.click(switcher());
    const options = within(screen.getByRole("listbox", { name: "Projects" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All chats", "Budget Tracker"]);
    // Two unread chats in the list: one Active, one Settled.
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("narrows the list to the project's chats, keeping Active, Settled and Unread", async () => {
    const s = server();
    const { user, hermes } = await launch(s);
    await putInProject(user, "Nightly backup", "Budget Tracker");
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    await putInProject(user, "Old notes", "Budget Tracker");
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    await pick(user, "Budget Tracker");
    expect(switcher().textContent).toContain("Budget Tracker");
    expect(activeTitles()).toEqual(["Nightly backup"]);
    // The Settled drawer counts and dots only the project's Settled chats.
    const settled = screen.getByRole("button", { name: /Settled/ });
    expect(settled.textContent).toContain("1");
    expect(settled.querySelector(".dot")).not.toBeNull();
    // NAS disks is unread and not shown: the switcher says so.
    expect(switcher().querySelector(".dot")).not.toBeNull();
    expect(switcher().title).toContain("1 unread chat isn't shown");

    // Settling inside the project works as it does in the full list.
    await user.click(within(screen.getByRole("button", { name: /Nightly backup/ }).parentElement!).getByTitle("Settle"));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(activeTitles()).toEqual([]));
    await user.click(screen.getByRole("button", { name: /Settled/ }));
    expect(listedTitles()).toEqual(expect.arrayContaining(["Nightly backup", "Old notes"]));

    await pick(user, "All chats");
    expect(activeTitles()).toEqual(["NAS disks", "Login page"]);
  });

  it("makes a project in Hermes, shows it, and opens its screen", async () => {
    const s = server();
    const { user } = await launch(s);
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /New project/ }));
    await user.type(screen.getByRole("textbox", { name: "New project name" }), "Home lab{Enter}");
    await screen.findByRole("heading", { name: /Home lab/ });
    expect(s.requests.filter((r) => r.method === "projects.create").map((r) => r.params)).toEqual([{ profile: "default", name: "Home lab" }]);
    expect(s.projects.default.map((p) => p.name)).toEqual(["Budget Tracker", "Home lab"]);
    expect(switcher().textContent).toContain("Home lab");
    expect(activeTitles()).toEqual([]);
  });

  it("is kept across a restart, with which chats are in each project", async () => {
    const s = server();
    const first = await launch(s);
    await putInProject(first.user, "Login page", "Budget Tracker");
    await pick(first.user, "Budget Tracker");
    cleanup();
    await Promise.all(running.splice(0).map((h) => h.close()));
    expect(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).v).toBe(1);

    await launch(s);
    expect(switcher().textContent).toContain("Budget Tracker");
    expect(activeTitles()).toEqual(["Login page"]);
  });
});

describe("a chat's menu", () => {
  it("puts a chat in a project and takes it out, on this computer only, with Undo", async () => {
    const s = server();
    const { user } = await launch(s);
    const writes = () => s.restRequests.filter((r) => r.method !== "GET").length;
    const before = writes();
    await putInProject(user, "NAS disks", "Budget Tracker");
    expect(screen.getByRole("status").textContent).toContain("Put in Budget Tracker: NAS disks");
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getByRole("menuitemcheckbox", { name: "Budget Tracker" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getByRole("menuitemcheckbox", { name: "Budget Tracker" }).getAttribute("aria-checked")).toBe("false");
    expect(writes()).toBe(before);
  });

  it("offers no projects when the profile has none", async () => {
    const s = server();
    s.projects.default = [];
    const { user } = await launch(s);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /NAS disks/ }) });
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Rename…", "Regenerate title"]);
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  });
});

describe("a chat started while a project is shown", () => {
  it("uses the project selected at Send when creation finishes after switching projects", async () => {
    const s = server();
    s.projects.default.push(project("p_lab", "Lab"));
    const create = s.handlers["session.create"];
    let finish!: () => void;
    s.handlers["session.create"] = (r) => { finish = () => create(r); };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Plan the budget{Enter}");
    await waitFor(() => expect(finish).toBeDefined());
    await pick(user, "Lab");
    await act(async () => finish());
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    expect(scopes[0].chats.p_budget).toHaveLength(1);
    expect(scopes[0].chats.p_lab).toBeUndefined();
  });

  it("goes in the project and stays in the list", async () => {
    const s = server();
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    expect(document.querySelector(".chat-title")?.textContent).toContain("Budget Tracker");
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Plan the budget{Enter}");
    await waitFor(() => expect(onScreen()).not.toBe("New chat"));
    await act(async () => void (await hermes.idle()));
    const before = new Set(["backup", "nas", "login", "old", "deps"]);
    const id = hermes.getSnapshot().chats.find((c) => !before.has(c.id))!.id;
    expect(activeTitles().length).toBe(1);
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    expect(scopes.map((sc) => sc.chats.p_budget)).toEqual([[id]]);
  });
});

describe("the project screen", () => {
  it("keeps one request queue when switching away from a profile and back during a folder write", async () => {
    const s = server();
    s.otherProfiles = { work: [] };
    const { user, hermes } = await launch(s);
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    const checkFolder = hermes.projects.checkFolder;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checking = vi.spyOn(hermes.projects, "checkFolder").mockImplementation(async (profile, path) => {
      if (path === "/srv/app") await gate;
      return checkFolder(profile, path);
    });
    await user.type(screen.getByRole("textbox", { name: "Add a folder on the server" }), "/srv/app{Enter}");
    expect(checking).toHaveBeenCalledWith("default", "/srv/app");
    await act(async () => { await hermes.switchProfile("work"); });
    await act(async () => { await hermes.switchProfile("default"); });
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /New project/ }));
    await user.type(screen.getByRole("textbox", { name: "New project name" }), "New lab{Enter}");
    // A new store would create now and its links could later be erased by the old folder write.
    expect(s.requests.filter((r) => r.method === "projects.create")).toHaveLength(0);
    await act(async () => release());
    await screen.findByRole("heading", { name: /New lab/ });
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await pick(user, "All chats");
    await putInProject(user, "NAS disks", "New lab");
    await pick(user, "New lab");
    expect(activeTitles()).toEqual(["NAS disks"]);
    expect(s.projects.default.find((p) => p.id === "p_budget")!.folders.map((f) => f.path)).toContain("/srv/app");
    await user.click(switcher());
    await act(async () => { await hermes.idle(); });
    const scopes = Object.values(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes as Record<string, { chats: Record<string, string[]> }>);
    const newProject = s.projects.default.find((p) => p.name === "New lab")!;
    expect(scopes.some((scope) => scope.chats[newProject.id]?.includes("nas"))).toBe(true);
    checking.mockRestore();
  });

  it.each(["deleted", "archived"])("resumes tracking the visible chat when the project is %s elsewhere", async (change) => {
    const s = server();
    const { user, hermes } = await launch(s);
    await user.click(screen.getByRole("button", { name: /NAS disks/ }));
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    await pick(user, "Budget Tracker");
    await user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await screen.findByRole("heading", { name: /Budget Tracker/ });
    const open = vi.spyOn(hermes, "open");
    if (change === "deleted") s.projects.default = [];
    else s.projects.default[0].archived = true;
    await user.click(switcher());
    await waitFor(() => expect(onScreen()).toBe("NAS disks"));
    await waitFor(() => expect(open).toHaveBeenCalledWith("nas"));
    open.mockRestore();
  });

  async function openScreen(s = server()) {
    const app = await launch(s);
    await pick(app.user, "Budget Tracker");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    await screen.findByRole("heading", { name: /Budget Tracker/ });
    return { s, ...app };
  }

  it("shows each folder's connection and path on the server", async () => {
    await openScreen();
    const folder = screen.getByText("/srv/budget").closest("li")!;
    expect(within(folder).getByText("ssh://liam@hermes")).toBeTruthy();
    expect(within(folder).getByText("Main folder")).toBeTruthy();
  });

  it("adds a folder only once the server has it, and says why it refused one", async () => {
    const { s, user } = await openScreen();
    const input = screen.getByRole("textbox", { name: "Add a folder on the server" });
    await user.type(input, "/srv/missing{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("There's no folder at /srv/missing on the server.");
    await user.clear(input);
    await user.type(input, "/srv/readme.md{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("/srv/readme.md is a file on the server, not a folder."));
    await user.clear(input);
    await user.type(input, "srv/app{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("starting with /"));
    expect(s.requests.filter((r) => r.method === "projects.add_folder")).toEqual([]);

    await user.clear(input);
    await user.type(input, "/srv/app{Enter}");
    await screen.findByText("/srv/app");
    expect(s.projects.default[0].folders.map((f) => f.path)).toEqual(["/srv/budget", "/srv/app"]);
    // A git folder shows its branch, and the repository's other worktree is offered, not made.
    await screen.findByText(/main · the repository's main worktree/);
    await user.click(await screen.findByRole("button", { name: "Add the worktree /srv/app-feature" }));
    await screen.findByText(/feature\/login · a worktree of \/srv\/app/);
    expect(s.projects.default[0].folders.map((f) => f.path)).toEqual(["/srv/budget", "/srv/app", "/srv/app-feature"]);
    expect(s.restRequests.filter((r) => /worktree\/(add|remove)|fs\/mkdir/.test(r.path) || r.method !== "GET")).toEqual([]);
  });

  it("takes a folder out of the project and leaves it on the server", async () => {
    const { s, user } = await openScreen();
    await user.click(screen.getByRole("button", { name: "Remove /srv/budget from the project" }));
    await screen.findByText("No folders yet.");
    expect(s.projects.default[0].folders).toEqual([]);
    expect(s.serverDirs.has("/srv/budget")).toBe(true);
  });

  it("renames the project in Hermes", async () => {
    const { s, user } = await openScreen();
    await user.click(screen.getByTitle(/Rename this project/));
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Budget{Enter}");
    await screen.findByRole("heading", { name: /^Budget$/ });
    expect(s.projects.default[0].name).toBe("Budget");
    expect(switcher().textContent).toContain("Budget");
  });

  it("deletes the project after asking, and keeps its chats and folders", async () => {
    const s = server();
    const app = await launch(s);
    await putInProject(app.user, "NAS disks", "Budget Tracker");
    await pick(app.user, "Budget Tracker");
    await app.user.click(screen.getByTitle("Project settings for Budget Tracker"));
    const sessionWrites = () => s.restRequests.filter((r) => r.method !== "GET");
    await app.user.click(screen.getByRole("button", { name: /Delete project/ }));
    expect(screen.getByText(/Its 1 chat stay in Hermes/)).toBeTruthy();
    await app.user.click(screen.getAllByRole("button", { name: /Delete project/ }).find((b) => b.classList.contains("danger"))!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Deleted the project Budget Tracker. Its chats and folders are kept."));
    expect(s.projects.default).toEqual([]);
    expect(sessionWrites()).toEqual([]);
    expect(s.serverDirs.has("/srv/budget")).toBe(true);
    expect(switcher().textContent).toContain("All chats");
    expect(activeTitles()).toEqual(["Nightly backup", "NAS disks", "Login page"]);
    expect(onScreen()).toBe("New chat");
  });
});
