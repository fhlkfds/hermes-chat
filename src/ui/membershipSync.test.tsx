// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembershipDialog, MembershipStatus, membershipLine, needsOwner } from "./MembershipSync";
import type { MembershipSync, Project } from "../hermes/projects";

afterEach(cleanup);

const projects: Project[] = [
  { id: "p_home", name: "Home lab", folders: [], archived: false },
  { id: "p_docs", name: "Docs", folders: [], archived: false },
];
const titles: Record<string, string> = { backup: "Nightly backup", nas: "NAS disks" };
const base: MembershipSync = { state: "synced", moved: true, pending: [], refused: [] };

function dialog(m: MembershipSync, over: Partial<Parameters<typeof MembershipDialog>[0]> = {}) {
  const props = {
    membership: m,
    projects,
    titleOf: (id: string) => titles[id],
    connected: true,
    onMigrate: vi.fn(() => Promise.resolve()),
    onLater: vi.fn(),
    onKeepMine: vi.fn(),
    onUseHermes: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<MembershipDialog {...props} />);
  return props;
}

describe("the membership status", () => {
  it("says where membership is kept in each state", () => {
    expect(membershipLine({ ...base, state: "local", moved: false })).toMatch(/kept on this computer: this Hermes doesn't keep it/);
    expect(membershipLine({ ...base, at: Date.UTC(2026, 10, 3, 15, 4) })).toMatch(/^Hermes keeps which chats are in it, so every computer shows the same\. Synced /);
    const pending: MembershipSync = {
      ...base,
      state: "pending",
      pending: [
        { opId: "a", projectId: "p_home", chatId: "nas", member: true, base: 1, at: 1 },
        { opId: "b", projectId: "p_docs", chatId: "nas", member: true, base: 1, at: 1, conflict: { serverMember: false, rev: 4 } },
      ],
    };
    expect(membershipLine(pending)).toBe("Hermes keeps which chats are in it. 1 change waits to sync. 1 change conflicts with another computer's.");
    expect(needsOwner(pending)).toBe(true);
    expect(needsOwner(base)).toBe(false);
    expect(membershipLine({ ...base, state: "stranded" })).toMatch(/no longer answers/);
  });

  it("offers Sync now and Review, and says why it couldn't sync", async () => {
    const onSync = vi.fn();
    const onReview = vi.fn();
    render(
      <MembershipStatus
        membership={{ ...base, state: "pending", error: "Couldn't sync which chats are in each project: The connection to Hermes dropped.", pending: [{ opId: "b", projectId: "p_docs", chatId: "nas", member: true, base: 1, at: 1, conflict: { serverMember: false, rev: 4 } }] }}
        connected
        onSync={onSync}
        onReview={onReview}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/The connection to Hermes dropped/);
    await userEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await userEvent.click(screen.getByRole("button", { name: "Review…" }));
    expect(onSync).toHaveBeenCalledOnce();
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("can't sync while disconnected", () => {
    render(<MembershipStatus membership={{ ...base, state: "pending" }} connected={false} onSync={() => {}} onReview={() => {}} />);
    expect(screen.getByRole("button", { name: /Sync now/ }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the membership dialog", () => {
  const preview: MembershipSync = {
    state: "preview",
    moved: false,
    pending: [],
    refused: [],
    preview: {
      add: [{ projectId: "p_home", chatId: "backup" }],
      already: [{ projectId: "p_home", chatId: "nas" }],
      serverOnly: [{ projectId: "p_docs", chatId: "zzz" }],
      noProject: [{ projectId: "p_gone", chatId: "nas" }],
    },
  };

  it("previews the move by chat and project, and moves only when asked", async () => {
    const p = dialog(preview);
    const box = screen.getByRole("dialog", { name: "Move project chats to Hermes" });
    expect(within(box).getByRole("region", { name: "Sent to Hermes" }).textContent).toContain("Nightly backup in Home lab");
    expect(within(box).getByRole("region", { name: "Already on Hermes, left as they are" }).textContent).toContain("NAS disks in Home lab");
    expect(within(box).getByRole("region", { name: /another computer/ }).textContent).toContain("a chat not in the list (zzz) in Docs");
    expect(within(box).getByRole("region", { name: /no longer has/ }).textContent).toContain("NAS disks in a deleted project");
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Move 1 link to Hermes" }));
    expect(p.onMigrate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Move 1 link to Hermes" }));
    expect(p.onMigrate).toHaveBeenCalledOnce();
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open and says why when the move fails", async () => {
    const p = dialog(preview, { onMigrate: vi.fn(() => Promise.reject(new Error("The connection to Hermes dropped."))) });
    await userEvent.click(screen.getByRole("button", { name: "Move 1 link to Hermes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The connection to Hermes dropped.");
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it("Not now and Escape leave everything on this computer", async () => {
    const p = dialog(preview);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(p.onLater).toHaveBeenCalledOnce();
    cleanup();
    const q = dialog(preview);
    await userEvent.keyboard("{Escape}");
    expect(q.onClose).toHaveBeenCalledOnce();
    expect(q.onMigrate).not.toHaveBeenCalled();
  });

  it("shows each conflict with both versions, and settles it either way", async () => {
    const p = dialog({
      ...base,
      state: "pending",
      pending: [
        { opId: "c1", projectId: "p_docs", chatId: "backup", member: true, base: 1, at: 0, conflict: { serverMember: false, rev: 3 } },
        { opId: "w1", projectId: "p_home", chatId: "nas", member: false, base: 1, at: 0 },
      ],
      refused: [{ link: { projectId: "p_home", chatId: "gone" }, why: "no_session" }],
    });
    const conflicts = screen.getByRole("region", { name: "Conflicts" });
    expect(conflicts.textContent).toContain("You put Nightly backup in Docs. On Hermes it is out of it.");
    expect(screen.getByText(/1 change waits on this computer/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Not kept" }).textContent).toContain("Hermes no longer has the chat.");
    await userEvent.click(within(conflicts).getByRole("button", { name: "Keep mine" }));
    await userEvent.click(within(conflicts).getByRole("button", { name: "Use Hermes's" }));
    expect(p.onKeepMine).toHaveBeenCalledWith("c1");
    expect(p.onUseHermes).toHaveBeenCalledWith("c1");
  });
});
