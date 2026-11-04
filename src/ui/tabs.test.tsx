// @vitest-environment jsdom
// Chat tabs and splits made by dragging a chat from the list, driven the way the owner would, against a fake Hermes.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY } from "../hermes/uiPrefs";
import { Main } from "../App";
import { CHAT_DRAG, closeTabIn, navigateTabs } from "./Tabs";

const drops = vi.hoisted(() => new Set<(e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => { drops.add(cb); return () => drops.delete(cb); },
}) }));
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
  drops.clear();
  vi.restoreAllMocks();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit");
const interrupts = (server: FakeHermes) => server.requests.filter((r) => r.method === "session.interrupt");

const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
const pane = (i: number) => panes()[i];
const titleIn = (i: number) => pane(i).querySelector(".chat-title span")?.textContent;
const composerIn = (i: number) => within(pane(i)).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const activeIndex = () => panes().findIndex((p) => p.classList.contains("active"));
const rowButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const lastOpen = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").lastOpenChat?.default;

/** Signed in with three Active chats, one pane on the New chat pane. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks" }),
    row("vpn", 3, { pinned: true, title: "VPN tunnel" }),
  ];
  server.transcripts = {
    backup: [
      { role: "user", text: "Why did the backup fail?" },
      { role: "assistant", text: "The restic repo was locked." },
    ],
    nas: [{ role: "user", text: "How full is the NAS?" }],
    vpn: [{ role: "user", text: "Is the tunnel up?" }],
  };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  return { server, hermes, user };
}

const tabsIn = (i: number) => Array.from(pane(i).querySelectorAll('[role="tab"]')).map((t) => t.textContent);
const shownTab = (i: number) => pane(i).querySelector('[role="tab"][aria-selected="true"]')?.textContent;

/** Drags the chat list's row for `id` onto `target`, at `at` within it as a share of its width and height. */
function dragOnto(target: Element, id: string, at?: { x: number; y: number }) {
  const row = document.querySelector(`.row-open[data-chat="${id}"]`)!;
  expect(row.getAttribute("draggable")).toBe("true");
  const data = new Map<string, string>();
  const dataTransfer = { types: [] as string[], setData: (k: string, v: string) => (data.set(k, v), dataTransfer.types.push(k)), getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
  if (at) vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => {} });
  // jsdom has no DragEvent, so the pointer's place is put on the event by hand.
  const at_ = (e: Event) => (at && Object.defineProperties(e, { clientX: { value: at.x * 1000 }, clientY: { value: at.y * 800 } }), e);
  fireEvent.dragStart(row, { dataTransfer });
  fireEvent(target, at_(createEvent.dragOver(target, { dataTransfer })));
  fireEvent(target, at_(createEvent.drop(target, { dataTransfer })));
}

describe("tab bookkeeping", () => {
  it("switches to a chat that has a tab, else replaces the tab left", () => {
    expect(navigateTabs(["a", "b"], "a", "b")).toEqual(["a", "b"]);
    expect(navigateTabs(["a", "b"], "a", "c")).toEqual(["c", "b"]);
    expect(navigateTabs([null], null, "c")).toEqual(["c"]);
    expect(navigateTabs([], "a", null)).toEqual([null]);
  });
  it("shows the tab after a closed one, or before it at the end", () => {
    expect(closeTabIn(["a", "b", "c"], "b")).toEqual({ rest: ["a", "c"], next: "c" });
    expect(closeTabIn(["a", "b", "c"], "c")).toEqual({ rest: ["a", "b"], next: "b" });
    expect(closeTabIn(["a"], "a")).toEqual({ rest: [], next: undefined });
  });
});

describe("chat tabs", () => {
  it("opens a chat dropped on the tab strip in a new tab, and switches between tabs", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "NAS disks"]);
    expect(titleIn(0)).toBe("NAS disks");

    await user.click(within(pane(0)).getByRole("tab", { name: "Nightly backup" }));
    await settle(hermes);
    expect(titleIn(0)).toBe("Nightly backup");
    expect(lastOpen()).toBe("backup");

    // A chat opened from the list takes the place of the tab showing, as a link does in a browser tab.
    await user.click(rowButton("VPN tunnel"));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["VPN tunnel", "NAS disks"]);

    // Ctrl+Tab goes to the next tab.
    await user.keyboard("{Control>}{Tab}{/Control}");
    await settle(hermes);
    expect(shownTab(0)).toBe("NAS disks");
  });

  it("opens a chat in a new tab from its menu, and closes tabs to the one beside", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.pointer({ keys: "[MouseRight]", target: rowButton("VPN tunnel") });
    await user.click(screen.getByRole("menuitem", { name: "Open in a new tab" }));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup", "VPN tunnel"]);
    expect(titleIn(0)).toBe("VPN tunnel");

    await user.click(within(pane(0)).getByRole("button", { name: "Close the tab VPN tunnel" }));
    await settle(hermes);
    expect(tabsIn(0)).toEqual(["Nightly backup"]);
    expect(titleIn(0)).toBe("Nightly backup");

    // The plus opens the New chat pane in a tab of its own.
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    expect(tabsIn(0)).toEqual(["Nightly backup", "New chat"]);
    expect(shownTab(0)).toBe("New chat");
  });

  it("splits down for a chat dropped on a pane's bottom edge, and right for its right edge", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await settle(hermes);
    dragOnto(pane(0).querySelector(".pane-drop")!, "nas", { x: 0.5, y: 0.9 });
    await settle(hermes);
    expect(panes()).toHaveLength(2);
    expect(document.querySelector(".panes")?.classList.contains("stacked")).toBe(true);
    expect([titleIn(0), titleIn(1)]).toEqual(["Nightly backup", "NAS disks"]);
    expect(pane(1).getAttribute("aria-label")).toMatch(/^Bottom pane: NAS disks/);

    // Dropped on the right edge, the panes turn side by side and the chat gets a tab in the second one.
    dragOnto(pane(0).querySelector(".pane-drop")!, "vpn", { x: 0.95, y: 0.5 });
    await settle(hermes);
    expect(document.querySelector(".panes")?.classList.contains("stacked")).toBe(false);
    expect(tabsIn(1)).toEqual(["NAS disks", "VPN tunnel"]);
    expect(titleIn(1)).toBe("VPN tunnel");

    // Its last tab closed, the second pane closes.
    await user.click(within(pane(1)).getByRole("button", { name: "Close the tab VPN tunnel" }));
    await user.click(within(pane(1)).getByRole("button", { name: "Close the tab NAS disks" }));
    expect(panes()).toHaveLength(1);
  });

  it("drops a deleted chat's tab", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    await user.click(within(pane(0)).getByRole("tab", { name: "Nightly backup" }));
    await settle(hermes);
    const row = rowButton("NAS disks").closest(".row") as HTMLElement;
    await user.click(within(row).getByTitle("Delete"));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat" }));
    await settle(hermes);
    await waitFor(() => expect(tabsIn(0)).toEqual(["Nightly backup"]));
    expect(server.sessions.some((s) => s.id === "nas")).toBe(false);
  });

  it("moves between tabs with the arrow keys, focus following", async () => {
    const { hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    dragOnto(pane(0).querySelector(".tab-strip")!, "nas");
    await settle(hermes);
    within(pane(0)).getByRole("tab", { name: "NAS disks" }).focus();
    await user.keyboard("{ArrowLeft}");
    await settle(hermes);
    expect(shownTab(0)).toBe("Nightly backup");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Nightly backup"));
  });

  it("keeps a chat starting in its New chat tab when another tab closes meanwhile", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    const create = server.handlers["session.create"];
    let held: Parameters<typeof create>[0] | undefined;
    server.handlers["session.create"] = (r) => void (held = r);
    await user.type(composerIn(0), "Plan the migration{Enter}");
    await waitFor(() => expect(held).toBeTruthy());
    await user.click(within(pane(0)).getByRole("button", { name: "Close the tab Nightly backup" }));
    await act(async () => create(held!));
    await settle(hermes);
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    // The started chat takes the New chat tab's place, and is the one kept for the next launch.
    await waitFor(() => expect(tabsIn(0)).not.toContain("New chat"));
    expect(tabsIn(0)).toHaveLength(1);
    expect(lastOpen()).toBeTruthy();
    expect(lastOpen()).not.toBe("backup");
  });

  it("keeps a chat starting in its New chat tab when End is pressed on that tab", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(rowButton("Nightly backup"));
    await user.click(within(pane(0)).getByRole("button", { name: "New tab" }));
    const create = server.handlers["session.create"];
    let held: Parameters<typeof create>[0] | undefined;
    server.handlers["session.create"] = (r) => void (held = r);
    await user.type(composerIn(0), "Plan the migration{Enter}");
    await waitFor(() => expect(held).toBeTruthy());
    within(pane(0)).getByRole("tab", { name: "New chat" }).focus();
    await user.keyboard("{End}");
    await act(async () => create(held!));
    await settle(hermes);
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    await waitFor(() => expect(tabsIn(0)).not.toContain("New chat"));
    expect(tabsIn(0)).toHaveLength(2);
  });
});
