// @vitest-environment jsdom
// Reopening the last chat at launch (uiPrefs `reopenLastChat`, `lastOpenChat`), driven the way the owner would drive the
// app against a fake Hermes. A restart unmounts the app, closes its connection and loads its modules afresh, so only
// what localStorage and the chat cache kept carries over.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type RestRequest } from "../hermes/fakeHermes";
import { memoryCache, type MemoryCache } from "../hermes/memoryCache";
import { UI_PREFS_KEY } from "../hermes/uiPrefs";
import type { Hermes } from "../hermes/transport";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

let running: Hermes | undefined;
afterEach(async () => {
  cleanup();
  await running?.close();
  running = undefined;
  localStorage.clear();
});

const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };

/** The title in the chat pane's header: a chat's, or "New chat". */
const onScreen = () => document.querySelector(".chat-title span")?.textContent;
/** What the stored ui-prefs document says each profile had on screen last. */
const lastOpen = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").lastOpenChat;
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  s.otherProfiles = { work: [row("q4", 1, { pinned: true, title: "Q4 plan" })] };
  s.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "How full is the NAS?" }] };
  return s;
}

/**
 * Starts the app as a cold launch does: fresh modules, a new connection, the first sign-in. `cache` stands in for the
 * chat lists kept on this computer, and its `profile` for the profile shown last.
 */
async function launch(s: FakeHermes, cache: MemoryCache, { wait = true, reopenLast = true } = {}) {
  if (running) {
    cleanup();
    await running.close();
  }
  vi.resetModules();
  const { Main } = await import("../App");
  const { connect } = await import("../hermes/transport");
  const hermes = await connect(s.openPipe, undefined, cache);
  running = hermes;
  render(<Main hermes={hermes} connection={connection} reopenLast={reopenLast} onSignOut={async () => {}} />);
  if (wait) await settle(hermes);
  return { hermes, user: userEvent.setup() };
}

async function openRow(user: ReturnType<typeof userEvent.setup>, hermes: Hermes, title: string) {
  await user.click(await screen.findByRole("button", { name: new RegExp(title) }));
  await settle(hermes);
  expect(onScreen()).toBe(title);
}

describe("Reopen last chat on launch", () => {
  it("reopens the chat that was on screen when the app closed", async () => {
    const s = server();
    const cache = memoryCache();
    const first = await launch(s, cache);
    expect(onScreen()).toBe("New chat");
    await openRow(first.user, first.hermes, "NAS disks");
    expect(lastOpen()).toEqual({ default: "nas" });

    await launch(s, cache);
    expect(onScreen()).toBe("NAS disks");
    expect(await screen.findByText("How full is the NAS?")).toBeTruthy();
  });

  it("keeps every move between chats, so a New chat pane at close starts fresh", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "NAS disks");
    await openRow(user, hermes, "Nightly backup");
    expect(lastOpen()).toEqual({ default: "backup" });
    await user.keyboard("{Control>}n{/Control}");
    expect(onScreen()).toBe("New chat");
    expect(lastOpen()).toEqual({});

    await launch(s, cache);
    expect(onScreen()).toBe("New chat");
  });

  it("starts on a new chat when the setting is off, and still keeps track", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "NAS disks");
    await user.click(screen.getByTitle("Settings"));
    const toggle = screen.getByRole("switch", { name: "Reopen last chat on launch" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Moves made while it is off are kept too.
    await openRow(user, hermes, "Nightly backup");
    expect(lastOpen()).toEqual({ default: "backup" });

    const second = await launch(s, cache);
    expect(onScreen()).toBe("New chat");
    // What is on screen now is the New chat pane, so turning it back on and closing reopens nothing.
    expect(lastOpen()).toEqual({});
    await second.user.click(screen.getByTitle("Settings"));
    await second.user.click(screen.getByRole("switch", { name: "Reopen last chat on launch" }));
    await launch(s, cache);
    expect(onScreen()).toBe("New chat");
  });

  it("starts fresh after Sign out, and that is what reopens next", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "NAS disks");

    // Signing in again in the same run: not a launch.
    await launch(s, cache, { reopenLast: false });
    expect(onScreen()).toBe("New chat");
    expect(lastOpen()).toEqual({});
    await launch(s, cache);
    expect(onScreen()).toBe("New chat");
  });

  it("keeps each profile's last chat apart", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "Nightly backup");
    await user.click(screen.getByRole("button", { name: /default/ }));
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await settle(hermes);
    // Switching lands on a new chat, as before; the profile left keeps its last chat.
    expect(onScreen()).toBe("New chat");
    await openRow(user, hermes, "Q4 plan");
    expect(lastOpen()).toEqual({ default: "backup", work: "q4" });

    // The app opens in the profile shown last, with that profile's chat.
    expect(cache.profile).toBe("work");
    await launch(s, cache);
    expect(onScreen()).toBe("Q4 plan");

    // Launched in the other profile, its own chat opens, never the work profile's.
    cache.profile = "default";
    await launch(s, cache);
    expect(onScreen()).toBe("Nightly backup");
  });

  it("falls back to a new chat and forgets a chat Hermes no longer lists", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "NAS disks");

    // Deleted in another Hermes client while the app was closed; the list kept on this computer still has it.
    s.sessions = s.sessions.filter((r) => r.id !== "nas");
    expect(cache.saved.default.map((c) => c.id)).toContain("nas");
    await launch(s, cache);
    await waitFor(() => expect(onScreen()).toBe("New chat"));
    expect(screen.queryByRole("button", { name: /NAS disks/ })).toBeNull();
    expect(lastOpen()).toEqual({});
  });

  it("falls back for a chat Hermes no longer lists even once it has been resumed here", async () => {
    const s = server();
    const cache = memoryCache();
    const { hermes, user } = await launch(s, cache);
    await openRow(user, hermes, "NAS disks");

    // Archived in another Hermes client while the app was closed. The list is held back until the chat, opened from the
    // saved list, has been resumed on the new connection.
    s.sessions = s.sessions.map((r) => (r.id === "nas" ? { ...r, archived: true } : r));
    const list = s.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    s.rest["GET /api/sessions"] = (req: RestRequest) => new Promise((resolve) => held.push(() => resolve(list(req))));
    const second = await launch(s, cache, { wait: false });
    expect(onScreen()).toBe("NAS disks");
    await screen.findByText("How full is the NAS?");
    await waitFor(() => expect(held).not.toHaveLength(0));
    expect(second.hermes.getSnapshot().chats.find((c) => c.id === "nas")?.runtimeId).toBeTruthy();

    s.rest["GET /api/sessions"] = list;
    act(() => held.splice(0).forEach((release) => release()));
    await settle(second.hermes);
    expect(onScreen()).toBe("New chat");
    expect(lastOpen()).toEqual({});
  });

  it("falls back at once for a chat neither list has", async () => {
    const s = server();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, lastOpenChat: { default: "gone", work: "q4" } }));
    await launch(s, memoryCache());
    expect(onScreen()).toBe("New chat");
    expect(lastOpen()).toEqual({ work: "q4" });
  });

  it("keeps the owner on the New chat pane once they start typing there", async () => {
    const s = server();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, lastOpenChat: { default: "nas" } }));
    const list = s.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    s.rest["GET /api/sessions"] = (req: RestRequest) => new Promise((resolve) => held.push(() => resolve(list(req))));
    const { hermes, user } = await launch(s, memoryCache(), { wait: false });
    await waitFor(() => expect(held).not.toHaveLength(0));

    await user.type(screen.getByPlaceholderText("Message Hermes"), "Is the UPS on battery?");
    s.rest["GET /api/sessions"] = list;
    act(() => held.splice(0).forEach((release) => release()));
    await settle(hermes);
    await screen.findByRole("button", { name: /NAS disks/ });
    expect(onScreen()).toBe("New chat");
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes").value).toBe("Is the UPS on battery?");
  });

  it("lets wherever the owner goes before the list arrives win", async () => {
    const s = server();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, lastOpenChat: { default: "nas" } }));
    // Hold the list back, so the chat to reopen isn't known to be there yet.
    const list = s.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    s.rest["GET /api/sessions"] = (req: RestRequest) => new Promise((resolve) => held.push(() => resolve(list(req))));
    const { hermes, user } = await launch(s, memoryCache(), { wait: false });
    await waitFor(() => expect(held).not.toHaveLength(0));
    expect(onScreen()).toBe("New chat");

    await user.keyboard("{Control>}n{/Control}");
    s.rest["GET /api/sessions"] = list;
    act(() => held.splice(0).forEach((release) => release()));
    await settle(hermes);
    await screen.findByRole("button", { name: /NAS disks/ });
    expect(onScreen()).toBe("New chat");
    expect(lastOpen()).toEqual({});
  });
});
