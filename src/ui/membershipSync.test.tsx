// @vitest-environment jsdom
// Which chats are in each project, between computers (ADR 0023), in the app: the switcher's line, the sync screen's
// preview, waiting changes and conflicts, and a chat menu's markers. The fake Hermes answers ADR 0023's proposed
// `projects.chats.*` when set up with it, and answers as the deployed `bf0203a` does otherwise.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type FakeProject } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { PROJECTS_KEY, projectScope } from "../hermes/projectLinks";
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

const CONNECTION = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const SCOPE = projectScope(CONNECTION, "default");
const project = (id: string, name: string): FakeProject => ({ id, slug: id, name, primary_path: null, archived: false, created_at: 1, folders: [] });

function server(keeps: boolean) {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { title: "Nightly backup" }), row("nas", 2, { title: "NAS disks" }), row("login", 3, { title: "Login page" })];
  s.projects.default = [project("p_home", "Home lab"), project("p_work", "Work")];
  if (keeps) s.membership = {};
  return s;
}

/** This computer's stored projects document for the default profile. */
function stored(scope: Record<string, unknown>) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify({ v: 1, scopes: { [SCOPE]: { known: [], chats: {}, ...scope } } }));
}

async function launch(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={CONNECTION} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const switcher = () => document.querySelector<HTMLElement>(".project-btn")!;
const onServer = (s: FakeHermes) =>
  [...(s.membership?.default?.links.values() ?? [])].filter((l) => l.member).map((l) => `${l.project}:${l.chat}`).sort();

async function menuFor(user: ReturnType<typeof userEvent.setup>, chat: string) {
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: new RegExp(chat) }) });
  return screen.findByRole("menu");
}

describe("on a Hermes that doesn't keep membership", () => {
  it("says it is kept on this computer and what Hermes would need, and sends nothing", async () => {
    const s = server(false);
    stored({ selected: "p_home", chats: { p_home: ["backup"] } });
    const { user } = await launch(s);
    await user.click(screen.getByRole("button", { name: /Project settings for Home lab/ }));
    expect(screen.getByText(/Which chats are in it is kept on this computer/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Between computers…" }));
    expect(await screen.findByText(/This Hermes server doesn't keep it/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What Hermes needs" })).toBeTruthy();
    expect(s.requests.some((r) => r.method.startsWith("projects.chats"))).toBe(false);
  });
});

describe("on a Hermes that keeps membership", () => {
  it("offers to copy this computer's, previews it, and copies only when asked", async () => {
    const s = server(true);
    s.membership!.default = { revision: 1, links: new Map([["p_home\nnas", { project: "p_home", chat: "nas", member: true, rev: 1 }]]), ops: new Map() };
    stored({ chats: { p_home: ["backup", "nas"], p_work: ["login"] } });
    const { user } = await launch(s);
    await user.click(switcher());
    await user.click(await screen.findByRole("button", { name: /Hermes can keep these on every computer/ }));
    const preview = await screen.findByRole("region", { name: /Copy this computer's to Hermes/ });
    expect(preview.textContent).toMatch(/2 chats will be added to their projects in Hermes/);
    expect(preview.textContent).toMatch(/Home lab: 1 chat/);
    expect(preview.textContent).toMatch(/Work: 1 chat/);
    expect(preview.textContent).toMatch(/1 chat is already there, and won't be added twice/);
    expect(s.requests.some((r) => r.method === "projects.chats.apply")).toBe(false);
    await user.click(within(preview).getByRole("button", { name: /Copy to Hermes/ }));
    await waitFor(() => expect(onServer(s)).toEqual(["p_home:backup", "p_home:nas", "p_work:login"]));
    expect(await screen.findByText(/Read from Hermes just now/)).toBeTruthy();
    expect(screen.getByText(/Kept from .*, when it was copied to Hermes/)).toBeTruthy();
  });

  it("shows a change Hermes hasn't confirmed as waiting, in the chat's menu and the switcher, until it syncs", async () => {
    const s = server(true);
    stored({ synced: { at: 1, links: {}, pending: [] } });
    const { user } = await launch(s);
    s.membershipApplyLeft = 0;
    within(await menuFor(user, "Login page"));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    const menu = await menuFor(user, "Login page");
    const item = within(menu).getByRole("menuitemcheckbox", { name: /Work/ });
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(item.textContent).toMatch(/Waiting/);
    await user.keyboard("{Escape}");
    await user.click(switcher());
    await user.click(await screen.findByRole("button", { name: /1 change waiting to sync/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/Couldn't sync with Hermes: database is locked/));
    expect(screen.getByRole("region", { name: "Waiting to sync" }).textContent).toMatch(/Put Login page in Work/);
    s.membershipApplyLeft = undefined;
    await user.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting to sync" })).toBeNull());
    expect(onServer(s)).toEqual(["p_work:login"]);
  });

  it("holds a change another computer contradicted for the owner, and sends it when kept", async () => {
    const s = server(true);
    // Hermes: Nightly backup in Home lab, put back at revision 3. This computer took it out over revision 1, offline.
    s.membership!.default = {
      revision: 3,
      links: new Map([["p_home\nbackup", { project: "p_home", chat: "backup", member: true, rev: 3 }]]),
      ops: new Map(),
    };
    stored({
      synced: {
        at: 1,
        links: { p_home: { backup: { member: true, rev: 1 } } },
        pending: [{ id: "m_offline", project: "p_home", chat: "backup", member: false, base: 1, at: Date.now() - 60_000 }],
      },
    });
    const { user } = await launch(s);
    await waitFor(() => expect(switcher().querySelector(".warn-text")).toBeTruthy());
    await user.click(switcher());
    await user.click(await screen.findByRole("button", { name: /A change needs your decision/ }));
    const conflicts = await screen.findByRole("region", { name: /A change needs your decision/ });
    expect(conflicts.textContent).toMatch(/Nightly backup in Home lab: this computer took it out .*; in Hermes it is now in/);
    expect(onServer(s)).toEqual(["p_home:backup"]);
    await user.click(within(conflicts).getByRole("button", { name: "Take it out" }));
    await waitFor(() => expect(onServer(s)).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("region", { name: /needs your decision/ })).toBeNull());
  });
});
