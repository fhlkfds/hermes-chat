// @vitest-environment jsdom
// Tags and Saved filters in the app (ADR 0026): the tag editor, tagging from a chat's menu, the search palette's
// filters and their chips, saving a filter and reopening it from the list, and a bulk tag edit that changes nothing
// until it is confirmed.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { TAGS_KEY } from "../hermes/tags";
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

async function launch() {
  const s = new FakeHermes();
  s.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup" }),
    row("nas", 2, { pinned: true, title: "NAS disks", source: "telegram" }),
    row("old", 5, { title: "Old notes" }),
    row("deps", 6, { title: "Dependency bump" }),
  ];
  s.transcripts = { nas: [{ role: "user", text: "How full are the NAS disks?" }] };
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const stored = () => JSON.parse(localStorage.getItem(TAGS_KEY) ?? "{}");
const chatsTagged = () => Object.values(stored().scopes ?? {}).map((s) => (s as { chats: Record<string, string[]> }).chats)[0];
const palette = () => screen.getByRole("dialog", { name: "Search chats" });
const hits = () => [...palette().querySelectorAll(".hit-name")].map((e) => e.textContent);

async function menuOf(user: User, chat: string) {
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: new RegExp(chat) }) });
  return screen.getByRole("menu");
}

async function makeTag(user: User, name: string) {
  await user.click(within(await menuOf(user, "NAS disks")).getByRole("menuitem", { name: /tag/ }));
  const dialog = screen.getByRole("dialog", { name: "Tags in default" });
  await user.type(within(dialog).getByRole("textbox", { name: "New tag name" }), `${name}{Enter}`);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
}

describe("The tag editor", () => {
  it("creates, refuses a duplicate name, renames and deletes, giving focus back", async () => {
    const { user } = await launch();
    await user.click(within(await menuOf(user, "NAS disks")).getByRole("menuitem", { name: "Add a tag…" }));
    const dialog = screen.getByRole("dialog", { name: "Tags in default" });
    const box = within(dialog).getByRole("textbox", { name: "New tag name" });
    expect(document.activeElement).toBe(box);
    await user.type(box, "Infra{Enter}");
    await user.type(box, "infra{Enter}");
    expect(within(dialog).getByRole("alert").textContent).toBe('There\'s already a tag called "Infra".');

    await user.click(within(dialog).getByRole("button", { name: "Rename Infra" }));
    const rename = within(dialog).getByRole("textbox", { name: "New name for Infra" });
    await user.clear(rename);
    await user.type(rename, "🚀 Infra{Enter}");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Rename 🚀 Infra" }));
    expect(within(dialog).getByRole("list", { name: "Tags" }).textContent).toContain("🚀 Infra0 chats");

    await user.click(within(dialog).getByRole("button", { name: "Delete 🚀 Infra" }));
    // Cancel has focus, so a stray Enter keeps the tag.
    await user.keyboard("{Enter}");
    expect(within(dialog).getByRole("button", { name: "Delete 🚀 Infra" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Delete 🚀 Infra" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByText(/No tags yet/)).toBeTruthy();
    expect(document.activeElement).toBe(box);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Tags in default" })).toBeNull();
  });

  it("tags a chat from its menu, and shows which tags it has", async () => {
    const { user } = await launch();
    await makeTag(user, "Infra");
    await user.click(within(await menuOf(user, "NAS disks")).getByRole("menuitemcheckbox", { name: "Infra" }));
    expect(chatsTagged()).toEqual({ nas: [expect.any(String)] });
    expect(within(await menuOf(user, "NAS disks")).getByRole("menuitemcheckbox", { name: "Infra" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Filtering in the search palette", () => {
  it("filters by tag with no words, shows the filter as a chip that removes it, and keeps arrows and Enter", async () => {
    const { user, hermes, s } = await launch();
    await makeTag(user, "Infra");
    await user.click(within(await menuOf(user, "NAS disks")).getByRole("menuitemcheckbox", { name: "Infra" }));

    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /^Tag/ }), "Infra");
    await waitFor(() => expect(hits()).toEqual(["NAS disks"]));
    const chips = within(palette()).getByRole("group", { name: "Active filters" });
    expect(chips.textContent).toContain("In default:");
    expect(within(palette()).getByText("Infra", { selector: ".hit-tags .tag-label" })).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: /^State/ }), "Settled");
    await waitFor(() => expect(hits()).toEqual([]));
    expect(within(palette()).getByText("No chats match these filters")).toBeTruthy();
    await user.click(within(chips).getByRole("button", { name: "Remove filter State: Settled" }));
    await waitFor(() => expect(hits()).toEqual(["NAS disks"]));

    await user.click(screen.getByRole("textbox", { name: "Words to search for" }));
    await user.keyboard("{Enter}");
    await act(async () => void (await hermes.idle()));
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expect(s.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id)).toEqual(["nas"]);
  });

  it("saves a filter, lists it apart from projects, and reopens it with its chips", async () => {
    const { user } = await launch();
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /^Source/ }), "Telegram");
    await waitFor(() => expect(hits()).toEqual(["NAS disks"]));
    await user.click(screen.getByRole("button", { name: "Save filter…" }));
    await user.type(screen.getByRole("textbox", { name: "Name this filter" }), "From Telegram{Enter}");
    expect(within(palette()).getByRole("status").textContent).toContain('Saved as "From Telegram"');
    await user.keyboard("{Escape}");

    const saved = screen.getByRole("navigation", { name: "Saved filters" });
    await user.click(within(saved).getByRole("button", { name: "From Telegram" }));
    await waitFor(() => expect(hits()).toEqual(["NAS disks"]));
    expect(within(palette()).getByRole("group", { name: "Active filters" }).textContent).toContain('saved as "From Telegram"');
    expect(within(palette()).getByRole("button", { name: "Remove filter Source: Telegram" })).toBeTruthy();
    // Opening a Saved filter put no chat in a project and changed no chat.
    expect(document.querySelector(".project-btn")?.textContent ?? "").not.toContain("From Telegram");
  });

  it("previews a bulk tag edit; Cancel and Escape change nothing, and confirming changes only what it listed", async () => {
    const { user } = await launch();
    await makeTag(user, "Infra");
    await user.click(screen.getByRole("button", { name: /^Settled/ }));
    await user.click(within(await menuOf(user, "Old notes")).getByRole("menuitemcheckbox", { name: "Infra" }));
    const before = localStorage.getItem(TAGS_KEY);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /^State/ }), "Settled");
    await waitFor(() => expect(hits()).toEqual(["Old notes", "Dependency bump"]));
    await user.click(screen.getByRole("button", { name: /Tag 2 results/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const confirm = within(palette()).getByRole("group", { name: "Confirm tag change" });
    expect(confirm.textContent).toContain('Add "Infra" to 1 chat. 1 already has it and stays as it is.');
    expect(within(confirm).getByRole("list", { name: "Chats that would change" }).textContent).toBe("Dependency bump");

    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(localStorage.getItem(TAGS_KEY)).toBe(before);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Words to search for" }));
    await user.click(screen.getByRole("button", { name: /Tag 2 results/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.keyboard("{Escape}");
    expect(localStorage.getItem(TAGS_KEY)).toBe(before);
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Tag 2 results/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(screen.getByRole("button", { name: "Add to 1 chat" }));
    expect(within(palette()).getByRole("status").textContent).toBe('Added "Infra" to 1 chat.');
    expect(Object.keys(chatsTagged()).sort()).toEqual(["deps", "old"]);
  });

  it("keeps each profile's tags and Saved filters apart", async () => {
    const { user, s, hermes } = await launch();
    s.otherProfiles = { work: [row("w1", 1, { pinned: true, title: "Work chat" })] };
    await makeTag(user, "Infra");
    await act(async () => void (await hermes.switchProfile("work")));
    await waitFor(() => expect(screen.getByRole("button", { name: /Work chat/ })).toBeTruthy());
    const menu = await menuOf(user, "Work chat");
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "Infra" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Add a tag…" })).toBeTruthy();
  });
});
