// @vitest-environment jsdom
// The inbox in the running app, against a fake Hermes: what it lists, where each entry takes the owner, and that
// dismissing an entry changes nothing else.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
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

let launches = 0;
const nowS = () => Date.now() / 1000;

/** Signed in to `default`, with an Unread chat there and in `work`, and a reply waiting on an Approval in `work`. */
async function launch() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup", last_read_at: nowS() }),
    row("notes", 0.01, { pinned: true, title: "Release notes", last_read_at: 0 }),
  ];
  server.otherProfiles = {
    work: [
      row("deploy", 0.02, { pinned: true, title: "Deploy plan", last_read_at: 0 }),
      row("migrate", 0, { pinned: true, title: "Migrate db", last_read_at: nowS() }),
    ],
  };
  server.liveSessions = [{ id: "rt-w", session_key: "migrate", status: "waiting", last_active: nowS() - 300 }];
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  return { server, hermes, user: userEvent.setup() };
}

const inboxButton = () => document.querySelector<HTMLButtonElement>(".inbox-btn")!;
const inbox = () => screen.getByRole("dialog", { name: /Inbox/ });
const rows = () => Array.from(inbox().querySelectorAll<HTMLButtonElement>(".inbox-open"));
const rowNames = () => rows().map((r) => r.getAttribute("aria-label")!.split(", in ")[0]);
const filter = (name: RegExp) => within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name });

describe("The inbox", () => {
  it("counts what needs the owner on the rail, and lists each entry with its profile, chat, server and time", async () => {
    const { user } = await launch();
    expect(inboxButton().getAttribute("aria-label")).toBe("Inbox, 3 need you");

    await user.click(inboxButton());
    expect(rowNames()).toEqual(["Needs approval: Migrate db", "Completed, unread: Release notes", "Completed, unread: Deploy plan"]);
    const approval = rows()[0];
    expect(approval.getAttribute("aria-label")).toMatch(/^Needs approval: Migrate db, in work on ssh:\/\/liam@hermes, 5m ago\. Hermes is waiting for your answer/);
    expect(within(approval).getByText(/ago$/).tagName).toBe("TIME");
    // Focus goes to the first entry, so the keyboard can start there.
    expect(document.activeElement).toBe(approval);
    expect(inbox().textContent).toMatch(/Checked profiles just now, running work just now\./);
  });

  it("filters by kind", async () => {
    const { user } = await launch();
    await user.click(inboxButton());
    await user.click(filter(/^Completed/));
    expect(rowNames()).toEqual(["Completed, unread: Release notes", "Completed, unread: Deploy plan"]);
    await user.click(filter(/^Running/));
    expect(rows()).toEqual([]);
    expect(inbox().textContent).toMatch(/Nothing is running\./);
  });

  it("moves between entries with the arrow keys, and Escape closes it and puts focus back on the rail", async () => {
    const { user } = await launch();
    await user.click(inboxButton());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    expect(document.activeElement).toBe(inboxButton());
  });

  it("opens an entry in another profile by switching to it, and shows the chat waiting on an Approval", async () => {
    const { server, hermes, user } = await launch();
    // Hermes still waits in work's chat, so resuming it brings back the card.
    server.openRequests.set("srq-work", {
      sid: "rt-w",
      stored: "migrate",
      method: "approval",
      params: { request_id: "apr-work", command: "psql -c 'drop table old'", description: "drop table", choices: ["once", "deny"] },
    });
    await user.click(inboxButton());
    await user.click(rows()[0]);

    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected", switching: undefined }));
    await waitFor(() => expect(server.last("session.resume")?.params).toMatchObject({ session_id: "migrate", profile: "work" }));
    // Focus lands on the card itself, never on one of its answers.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe("srq-work"));
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
    // Nothing was answered for the owner.
    expect(server.responses).toEqual([]);
  });

  it("opens the Approval card an entry is about, focusing the card and not an answer", async () => {
    const { server, hermes, user } = await launch();
    let chatId = "";
    await act(async () => {
      chatId = await hermes.newChat();
      await hermes.send(chatId, "Clean up the logs");
    });
    const { id } = server.askApproval(server.runtimeIdOf(chatId)!);
    // The owner is in another chat meanwhile.
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));

    await user.click(inboxButton());
    const entry = rows().find((r) => r.getAttribute("aria-label")!.startsWith("Needs approval: Clean up the logs"))!;
    await user.click(entry);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe(id));
    expect(document.activeElement?.classList.contains("approval")).toBe(true);
    expect(server.responses).toEqual([]);
  });

  it("asks before taking the owner to another profile while an Approval waits here", async () => {
    const { server, hermes, user } = await launch();
    await act(async () => {
      const id = await hermes.newChat();
      await hermes.send(id, "Clean up the logs");
      server.askApproval(server.runtimeIdOf(id)!);
    });
    await user.click(inboxButton());
    await user.click(rows().find((r) => r.getAttribute("aria-label")!.includes("Deploy plan"))!);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to work?" });
    expect(ask.textContent).toMatch(/An approval is waiting in default/);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(hermes.getSnapshot().profile).toBe("default");

    await user.click(rows().find((r) => r.getAttribute("aria-label")!.includes("Deploy plan"))!);
    await user.click(screen.getByRole("button", { name: "Switch to work" }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", switching: undefined }));
  });

  it("dismisses an entry only from the inbox: the chat stays Unread and where it was, and focus stays in the inbox", async () => {
    const { server, hermes, user } = await launch();
    await user.click(inboxButton());
    await user.click(screen.getByRole("button", { name: "Dismiss “Release notes” from the inbox" }));

    expect(rowNames()).toEqual(["Needs approval: Migrate db", "Completed, unread: Deploy plan"]);
    expect(document.activeElement).toBe(rows()[1]);
    expect(inboxButton().getAttribute("aria-label")).toBe("Inbox, 2 need you");
    expect(hermes.getSnapshot().chats.find((c) => c.id === "notes")).toMatchObject({ unread: true, settled: false });
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    // Still dismissed after a fresh look at the server.
    await act(async () => void (await hermes.sync()));
    expect(rowNames()).not.toContain("Completed, unread: Release notes");
  });

  it("drops a completed entry once its chat is open in another pane, without the inbox closing", async () => {
    const { hermes, user } = await launch();
    await user.click(inboxButton());
    expect(rowNames()).toContain("Completed, unread: Release notes");
    // The owner opens the chat in a second pane from its menu, with the inbox still open.
    await act(async () => void (await hermes.open("notes", "pane-other")));
    await waitFor(() => expect(rowNames()).not.toContain("Completed, unread: Release notes"));
    expect(inbox()).toBeTruthy();
  });

  it("says when Hermes can't be reached, and shows what it last saw", async () => {
    const { server, user } = await launch();
    server.refuse = "Connection refused";
    await act(async () => server.drop());
    await user.click(inboxButton());
    expect(inbox().textContent).toMatch(/Not connected to Hermes: showing what was last seen\./);
    expect(rows()[0].getAttribute("aria-label")).toMatch(/As last seen\.$/);
    expect(screen.getByRole("button", { name: "Check now" })).toHaveProperty("disabled", true);
  });
});
