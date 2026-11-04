// @vitest-environment jsdom
// The rail's layout and its tips (ADR 0049): the daily tools first, then the Work and Server groups, and a tip that
// shows at once, with the button's name and shortcut, on hover or keyboard focus.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "./Sidebar";

afterEach(cleanup);

const noop = () => {};

function rail(over: Partial<Parameters<typeof Rail>[0]> = {}) {
  const props: Parameters<typeof Rail>[0] = {
    status: "connected",
    unsecure: false,
    onReconnect: noop,
    onToggleList: noop,
    onNew: vi.fn(),
    onSearch: noop,
    onFiles: noop,
    onInbox: noop,
    onOutputs: noop,
    onSettings: noop,
    onJobs: noop,
    onAutomations: noop,
    onUsage: noop,
    onLogs: noop,
    onRepo: noop,
    onTerminal: noop,
    ...over,
  };
  return { ...render(<Rail {...props} />), props, user: userEvent.setup() };
}

const names = (el: HTMLElement) => within(el).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const tip = () => screen.queryByRole("tooltip", { hidden: true });

describe("the rail", () => {
  it("puts New chat, Search and Inbox first, then the Work and Server groups, with Settings at the foot", () => {
    const { container } = rail();
    const top = container.querySelector(".rail-top") as HTMLElement;
    expect(names(top)).toEqual(["Hide or show chats", "New chat (Ctrl+N)", "Search all chats (Ctrl+K)", "Inbox"]);
    expect(names(screen.getByRole("group", { name: "Work" }))).toEqual(["Server files", "Outputs", "Repository", "Terminal"]);
    expect(names(screen.getByRole("group", { name: "Server" }))).toEqual(["Scheduled jobs", "Automations", "Logs", "Usage"]);
    const bottom = container.querySelector(".rail-bottom") as HTMLElement;
    expect(names(bottom)).toEqual(["Connected", "Settings"]);
    // Import lives in Settings, not on the rail.
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });

  it("leaves out a group with none of its tools", () => {
    rail({ onJobs: undefined, onAutomations: undefined, onUsage: undefined, onLogs: undefined });
    expect(screen.queryByRole("group", { name: "Server" })).toBeNull();
    expect(screen.getByRole("group", { name: "Work" })).toBeTruthy();
  });

  it("names the shortcuts for screen readers", () => {
    rail();
    expect(screen.getByRole("button", { name: "New chat (Ctrl+N)" }).getAttribute("aria-keyshortcuts")).toBe("Control+N");
    expect(screen.getByRole("button", { name: "Search all chats (Ctrl+K)" }).getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(screen.getByRole("button", { name: "Hide or show chats" }).getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBe("Control+Comma");
  });

  it("shows a tip at once on hover, with the name and shortcut, and hides it on leaving", async () => {
    const { user } = rail();
    const btn = screen.getByRole("button", { name: "New chat (Ctrl+N)" });
    expect(tip()).toBeNull();
    await user.hover(btn);
    expect(tip()?.textContent).toBe("New chatCtrl+N");
    expect(tip()?.querySelector("kbd")?.textContent).toBe("Ctrl+N");
    await user.unhover(btn);
    expect(tip()).toBeNull();
  });

  it("shows a line about a tool without a shortcut", async () => {
    const { user } = rail();
    await user.hover(screen.getByRole("button", { name: "Automations" }));
    expect(tip()?.textContent).toBe("AutomationsTasks started by GitHub events");
    expect(tip()?.querySelector("kbd")).toBeNull();
  });

  it("shows the tip on keyboard focus, and Escape hides it", async () => {
    const { user } = rail();
    await user.tab();
    expect(tip()?.textContent).toContain("Hide or show chats");
    await user.tab();
    expect(tip()?.textContent).toContain("New chat");
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
  });

  it("keeps a tip that stays up in step with the button", async () => {
    const { user, rerender, props } = rail({ inboxCount: 0 });
    await user.hover(screen.getByRole("button", { name: "Inbox" }));
    expect(tip()?.textContent).toBe("InboxWhat needs you in any profile");
    rerender(<Rail {...props} inboxCount={3} />);
    expect(screen.getByRole("button", { name: "Inbox, 3 need you" })).toBeTruthy();
    expect(tip()?.textContent).toBe("Inbox3 need you");
  });

  it("puts the connection's full wording in its tip", async () => {
    const { user } = rail({ status: "offline", closedReason: "Server went away" });
    const conn = screen.getByRole("button", { name: /^Offline/ });
    await user.hover(conn);
    expect(tip()?.textContent).toContain("Server went away · Click to reconnect");
  });

  it("drops the native title, so no second, slower tooltip shows", () => {
    const { container } = rail();
    expect(container.querySelectorAll(".rail [title]")).toHaveLength(0);
  });
});
