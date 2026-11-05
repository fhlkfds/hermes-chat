// @vitest-environment jsdom
// The chat list's sections as the side panel shows them (ADR 0062): each one collapsible, remembered across a restart;
// Settings → General picking which show, never none; and clearing a read, quiet chat from the Inbox until something
// new happens in it. The list on its own first, then the whole app against a fake Hermes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { CLEARED_KEY, type Cleared } from "../hermes/snooze";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { ChatList } from "./Sidebar";
import { ChatSectionSettings } from "./ChatSectionSettings";

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

const NOW = Date.now();
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, source: "app", settled: false, updatedAt: NOW - 60_000, items: [], ...extra });

function List({ chats, cleared = {}, onClear = () => {}, selectedId = null }: { chats: Chat[]; cleared?: Cleared; onClear?: (id: string, on: boolean) => void; selectedId?: string | null }) {
  return (
    <ChatList
      profile="default"
      status="connected"
      others={{ byName: {} }}
      chats={chats}
      selectedId={selectedId}
      onOpen={() => {}}
      onSettle={() => {}}
      cleared={cleared}
      onClear={onClear}
      onArchive={() => {}}
      onDelete={() => {}}
      onRename={async () => {}}
      onRegenTitle={async () => {}}
      onListProfiles={async () => ["default"]}
      onCheckOthers={() => {}}
      onSwitchProfile={() => {}}
      onRetrySwitch={() => {}}
    />
  );
}

/** The section headers the list shows, as their text: label then count. */
const heads = () => [...document.querySelectorAll<HTMLElement>(".section-toggle")].map((b) => b.textContent);
const head = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}\\d`) });
/** The titles of the chats the list shows in `section`, in order; rows of a collapsed section are out of sight. */
const titles = (section: string) =>
  [...document.querySelectorAll(`.row[data-section="${section}"]:not([hidden]) .row-open .row-title`)].map((t) => t.textContent);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`.row-open[data-chat="${id}"]`)!;

const mix = [
  chat("new", { unread: true }),
  chat("read"),
  chat("busy", { running: true }),
  chat("quiet", { updatedAt: NOW - 3_600_000 }),
  chat("old", { settled: true }),
  chat("gone", { archived: true }),
];

describe("The side panel's sections", () => {
  it("shows the Inbox, Working, Unsettled and Settled with counts; Archived is off until Settings turns it on", () => {
    render(<List chats={mix} cleared={{ quiet: NOW - 3_600_000 }} />);
    expect(heads()).toEqual(["Inbox2", "Working1", "Unsettled1", "Settled1"]);
    expect(titles("inbox")).toEqual(["new", "read"]);
    expect(titles("working")).toEqual(["busy"]);
    // Unsettled and Settled start collapsed.
    expect(head("Unsettled").getAttribute("aria-expanded")).toBe("false");
    expect(titles("unsettled")).toEqual([]);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses and expands each section from its header, remembered across a restart", async () => {
    const user = userEvent.setup();
    const first = render(<List chats={mix} cleared={{ quiet: NOW - 3_600_000 }} />);
    await user.click(head("Inbox"));
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(titles("inbox")).toEqual([]);
    await user.click(head("Unsettled"));
    expect(titles("unsettled")).toEqual(["quiet"]);
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).chatSectionsCollapsed).toEqual(["inbox", "snoozed", "settled", "archived"]);

    // A restart: the prefs are read again from storage.
    first.unmount();
    const stored = localStorage.getItem(UI_PREFS_KEY)!;
    localStorage.clear();
    localStorage.setItem(UI_PREFS_KEY, stored);
    render(<List chats={mix} cleared={{ quiet: NOW - 3_600_000 }} />);
    expect(head("Inbox").getAttribute("aria-expanded")).toBe("false");
    expect(head("Unsettled").getAttribute("aria-expanded")).toBe("true");
    expect(titles("unsettled")).toEqual(["quiet"]);
  });

  it("marks a collapsed section that has an unread chat", async () => {
    const user = userEvent.setup();
    render(<List chats={mix} />);
    expect(head("Inbox").querySelector(".dot")).toBeNull();
    await user.click(head("Inbox"));
    expect(head("Inbox").querySelector(".dot")?.getAttribute("title")).toBe("1 unread");
  });

  it("opens the section of a chat opened from elsewhere, such as a search", () => {
    const { rerender } = render(<List chats={mix} />);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("false");
    rerender(<List chats={mix} selectedId="old" />);
    expect(head("Settled").getAttribute("aria-expanded")).toBe("true");
    expect(titles("settled")).toEqual(["old"]);
  });

  it("shows only the sections Settings picks, in the list's own order, and Archived lists archived chats", () => {
    setUIPrefs({ chatSectionsShown: ["archived", "inbox"], chatSectionsCollapsed: [] });
    render(<List chats={mix} />);
    expect(heads()).toEqual(["Inbox3", "Archived1"]);
    expect(titles("archived")).toEqual(["gone"]);
    expect(document.querySelector('.row[data-section="working"]')).toBeNull();
    expect(document.querySelector('.row[data-section="settled"]')).toBeNull();
  });

  it("says when an open section is empty", () => {
    setUIPrefs({ chatSectionsCollapsed: [] });
    render(<List chats={[chat("busy", { running: true })]} />);
    const hints = [...document.querySelectorAll(".empty-hint")].map((h) => h.textContent);
    expect(hints).toEqual(["Nothing needs you right now.", "No unsettled chats.", "No settled chats."]);
  });
});

describe("Clearing from the Inbox, in the list", () => {
  it("offers Clear only on a read, quiet chat in the Inbox, and Back to the Inbox on a cleared one", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    render(<List chats={mix} cleared={{ quiet: NOW - 3_600_000 }} onClear={(id, on) => calls.push([id, on])} />);
    const clearOf = (id: string) => within(rowOf(id).parentElement!).queryByRole("button", { name: "Clear from the Inbox" });
    expect(clearOf("new")).toBeNull();
    expect(clearOf("busy")).toBeNull();
    await user.click(clearOf("read")!);
    expect(calls).toEqual([["read", true]]);

    fireEvent.contextMenu(rowOf("read"));
    await user.click(screen.getByRole("menuitem", { name: "Clear from the Inbox" }));
    expect(calls[1]).toEqual(["read", true]);

    await user.click(head("Unsettled"));
    await user.click(within(rowOf("quiet").parentElement!).getByRole("button", { name: "Back to the Inbox" }));
    expect(calls[2]).toEqual(["quiet", false]);
    fireEvent.contextMenu(rowOf("quiet"));
    expect(screen.queryByRole("menuitem", { name: "Clear from the Inbox" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Back to the Inbox" }));
    expect(calls[3]).toEqual(["quiet", false]);
  });

  it("brings a cleared chat back to the Inbox when something new happens in it", () => {
    const cleared = { quiet: NOW - 3_600_000 };
    setUIPrefs({ chatSectionsCollapsed: [] });
    const { rerender } = render(<List chats={[chat("quiet", { updatedAt: NOW - 3_600_000 })]} cleared={cleared} />);
    expect(titles("unsettled")).toEqual(["quiet"]);
    rerender(<List chats={[chat("quiet", { updatedAt: NOW })]} cleared={cleared} />);
    expect(titles("unsettled")).toEqual([]);
    expect(titles("inbox")).toEqual(["quiet"]);
  });
});

describe("Settings → General: chat list sections", () => {
  it("turns each section on or off in any mix, but never the last one", async () => {
    const user = userEvent.setup();
    render(<ChatSectionSettings />);
    const sw = (name: string) => screen.getByRole("switch", { name });
    expect(["Inbox", "Working", "Snoozed", "Unsettled", "Settled", "Archived"].map((n) => sw(n).getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
    ]);
    await user.click(sw("Archived"));
    await user.click(sw("Working"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "snoozed", "unsettled", "settled", "archived"]);
    for (const n of ["Inbox", "Snoozed", "Unsettled", "Settled"]) await user.click(sw(n));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    // The last one on can't be turned off, and says why.
    expect(sw("Archived").getAttribute("aria-disabled")).toBe("true");
    expect(sw("Archived").getAttribute("aria-checked")).toBe("true");
    await user.click(sw("Archived"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["archived"]);
    expect(screen.getByText(/At least one section stays on/)).toBeTruthy();
    await user.click(sw("Inbox"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "archived"]);
    expect(sw("Archived").getAttribute("aria-disabled")).toBeNull();
  });

  it("won't keep a stored list with no sections, or ones it doesn't know", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, chatSectionsShown: [], chatSectionsCollapsed: ["nope", "inbox", "inbox"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "working", "snoozed", "unsettled", "settled"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["inbox"]);
    setUIPrefs({ chatSectionsShown: [] });
    expect(getUIPrefs().chatSectionsShown).toEqual(["inbox", "working", "snoozed", "unsettled", "settled"]);
  });
});

describe("Clearing from the Inbox, in the app", () => {
  async function signedIn() {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("b", 2, { pinned: true, title: "Groceries" })];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user };
  }

  it("keeps the clear on this computer, sends nothing to Hermes, and Undo or new activity brings the chat back", async () => {
    const { server, hermes, user } = await signedIn();
    const before = server.restRequests.length;
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Clear from the Inbox" }));
    expect(screen.getByRole("status").textContent).toContain("Cleared from the Inbox: Deploy notes");
    expect(titles("inbox")).toEqual(["Groceries"]);
    expect(head("Unsettled").textContent).toBe("Unsettled1");
    const stored = JSON.parse(localStorage.getItem(CLEARED_KEY)!);
    expect(Object.values(stored.scopes).map((s) => Object.keys(s as object))).toEqual([["a"]]);
    expect(server.restRequests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));

    // Cleared again; then a message from another platform makes it newer, and it is back in the Inbox.
    await user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Clear from the Inbox" }));
    expect(titles("inbox")).toEqual(["Groceries"]);
    const a = server.sessions.find((s) => s.id === "a")!;
    a.last_active = Date.now() / 1000;
    await act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));
    expect(head("Unsettled").textContent).toBe("Unsettled0");
    // The clear that activity ended is forgotten, not just passed over.
    await waitFor(() => expect(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes).toEqual({}));
  });

  it("forgets a chat's clear when the owner snoozes it, so it wakes into the Inbox", async () => {
    const { user } = await signedIn();
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await user.click(within(rowFor("Groceries")).getByRole("button", { name: "Clear from the Inbox" }));
    expect(Object.keys(Object.values(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes)[0] as object)).toEqual(["b"]);
    await user.click(head("Unsettled"));
    fireEvent.contextMenu(screen.getByRole("button", { name: /Groceries/ }));
    await user.click(screen.getByRole("menuitem", { name: "1 hour" }));
    expect(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes).toEqual({});
  });

  it("lists archived chats only while the Archived section is shown", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(row("z", 3, { archived: true, title: "Old plan" }));
    await act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
    expect(hermes.getSnapshot().archivedListed).toBe(false);
    expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
    act(() => void setUIPrefs({ chatSectionsShown: ["inbox", "archived"] }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(true));
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(head("Archived").textContent).toBe("Archived1"));
    act(() => void setUIPrefs({ chatSectionsShown: ["inbox"] }));
    await waitFor(() => expect(hermes.getSnapshot().archivedListed).toBe(false));
  });
});
