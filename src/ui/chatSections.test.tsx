// @vitest-environment jsdom
// The chat list's sections as the side panel shows them (ADR 0063): each one collapsible, remembered across a restart;
// Settings → General picking which show, never none; and clearing a read, quiet chat from the Inbox until something
// new happens in it. The list on its own first, then the whole app against a fake Hermes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { CLEARED_KEY, PINS_KEY, type Cleared, type Pins } from "../hermes/snooze";
import { UI_PREFS_KEY, getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { connect, type Hermes } from "../hermes/transport";
import { projectScope } from "../hermes/projectLinks";
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

function List({
  chats,
  cleared = {},
  onClear = () => {},
  pins,
  onPin,
  selectedId = null,
}: {
  chats: Chat[];
  cleared?: Cleared;
  onClear?: (id: string, on: boolean) => void;
  pins?: Pins;
  onPin?: (id: string, on: boolean) => void;
  selectedId?: string | null;
}) {
  return (
    <ChatList
      pins={pins}
      onPin={onPin}
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

describe("Pinned chats, in the list", () => {
  it("lists pinned chats first, in the order pinned, each with a pin, and new messages don't reorder them", () => {
    const pins = { old: NOW - 2_000, read: NOW - 1_000 };
    const { rerender } = render(<List chats={mix} pins={pins} onPin={() => {}} />);
    expect(heads()).toEqual(["Pinned2", "Inbox2", "Working1", "Unsettled0", "Settled0"]);
    expect(titles("pinned")).toEqual(["old", "read"]);
    expect(rowOf("old").querySelector('[aria-label="Pinned"]')).not.toBeNull();
    expect(rowOf("new").querySelector('[aria-label="Pinned"]')).toBeNull();
    const later = mix.map((c) => (c.id === "read" || c.id === "new" ? { ...c, updatedAt: NOW } : c));
    rerender(<List chats={later} pins={pins} onPin={() => {}} />);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["old", "read"]);
    expect(titles("inbox")).toEqual(["new", "quiet"]);
  });

  it("draws no Pinned header while nothing is pinned", () => {
    render(<List chats={mix} pins={{}} />);
    expect(heads()[0]).toBe("Inbox3");
  });

  it("pins and unpins from the row's menu, by click or by its P key", async () => {
    const user = userEvent.setup();
    const calls: [string, boolean][] = [];
    render(<List chats={mix} pins={{ read: NOW }} onPin={(id, on) => calls.push([id, on])} />);
    fireEvent.contextMenu(rowOf("new"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("read"));
    expect(screen.getByRole("menuitem", { name: /^Unpin/ }).getAttribute("aria-keyshortcuts")).toBe("P");
    await user.keyboard("p");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(calls).toEqual([
      ["new", true],
      ["read", false],
    ]);
  });
});

describe("Settings → General: chat list sections", () => {
  it("turns each section on or off in any mix, but never the last one", async () => {
    const user = userEvent.setup();
    render(<ChatSectionSettings />);
    const sw = (name: string) => screen.getByRole("switch", { name });
    expect(["Pinned", "Inbox", "Working", "Snoozed", "Unsettled", "Settled", "Archived"].map((n) => sw(n).getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
    ]);
    await user.click(sw("Archived"));
    await user.click(sw("Working"));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "snoozed", "unsettled", "settled", "archived"]);
    for (const n of ["Pinned", "Inbox", "Snoozed", "Unsettled", "Settled"]) await user.click(sw(n));
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
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "working", "snoozed", "unsettled", "settled"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["inbox"]);
    setUIPrefs({ chatSectionsShown: [] });
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "working", "snoozed", "unsettled", "settled"]);
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

  it("forgets a clear once a refresh sees the chat settled in another client, so unsettling it there brings it back", async () => {
    const { server, hermes, user } = await signedIn();
    const rowFor = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).parentElement!;
    await user.click(within(rowFor("Deploy notes")).getByRole("button", { name: "Clear from the Inbox" }));
    expect(titles("inbox")).toEqual(["Groceries"]);
    const a = server.sessions.find((s) => s.id === "a")!;
    const lastActive = a.last_active;
    const refresh = () =>
      act(async () => {
        await hermes.sync();
        await hermes.idle();
      });
    // Settled elsewhere: the pin changes, the activity time doesn't.
    a.pinned = false;
    await refresh();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(CLEARED_KEY)!).scopes).toEqual({}));
    a.pinned = true;
    await refresh();
    expect(a.last_active).toBe(lastActive);
    await waitFor(() => expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]));
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

describe("Pinning, in the app", () => {
  const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
  async function signedIn(server = new FakeHermes()) {
    if (!server.sessions.length)
      server.sessions = [
        row("a", 1, { pinned: true, title: "Deploy notes" }),
        row("b", 2, { pinned: true, title: "Groceries" }),
        row("c", 3, { pinned: true, title: "Taxes" }),
      ];
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    await act(async () => void (await hermes.idle()));
    return { server, hermes, user, view };
  }
  const refresh = (hermes: Hermes) =>
    act(async () => {
      await hermes.sync();
      await hermes.idle();
    });
  const storedPins = () => Object.values(JSON.parse(localStorage.getItem(PINS_KEY) ?? '{"scopes":{}}').scopes).map((s) => Object.keys(s as object));

  it("pins from the row menu and the header's More menu, keeps them on this computer only, and keeps them across a restart", async () => {
    const { server, hermes, user, view } = await signedIn();
    const before = server.restRequests.length;
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(screen.getByRole("status").textContent).toContain("Pinned: Groceries");
    await user.click(rowOf("a"));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);
    expect(storedPins()).toEqual([["b", "a"]]);
    // Opening a chat marks it read on Hermes; nothing else is written there.
    expect(server.restRequests.slice(before).filter((r) => r.method !== "GET").map((r) => r.body)).toEqual([expect.objectContaining({ unread: false })]);

    // A new message in an unpinned chat leaves it below the pinned ones.
    server.sessions.find((s) => s.id === "c")!.last_active = Date.now() / 1000;
    await refresh(hermes);
    expect(heads()[0]).toBe("Pinned2");
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
    expect(titles("inbox")).toEqual(["Taxes"]);

    view.unmount();
    const again = await connect(server.openPipe);
    running.push(again);
    render(<Main hermes={again} connection={connection} onSignOut={async () => {}} />);
    await screen.findByRole("button", { name: /Deploy notes/ });
    expect(titles("pinned")).toEqual(["Groceries", "Deploy notes"]);
  }, 20_000);

  it("unpins back to the chat's place in the list, and Undo puts the pin back in its old place", async () => {
    const { user } = await signedIn();
    for (const id of ["b", "c"]) {
      fireEvent.contextMenu(rowOf(id));
      await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    }
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
    fireEvent.contextMenu(rowOf("b"));
    await user.keyboard("p");
    expect(titles("pinned")).toEqual(["Taxes"]);
    expect(titles("inbox")).toEqual(["Deploy notes", "Groceries"]);
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    expect(titles("pinned")).toEqual(["Groceries", "Taxes"]);
  });

  it("keeps a pinned chat the list no longer reaches, and forgets the pin of one Hermes no longer has", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { pinned: true, title: "Deploy notes" }), row("old", 60, { title: "Last year's taxes" })];
    localStorage.setItem(PINS_KEY, JSON.stringify({ v: 1, scopes: { [projectScope(connection, "default")]: { old: NOW - 2, gone: NOW - 1 } } }));
    await signedIn(server);
    await waitFor(() => expect(titles("pinned")).toEqual(["Last year's taxes"]));
    await waitFor(() => expect(storedPins()).toEqual([["old"]]));
  });

  it("forgets a deleted chat's pin", async () => {
    const { user } = await signedIn();
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: /^Pin/ }));
    fireEvent.contextMenu(rowOf("b"));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(storedPins()).toEqual([]));
  });
});
