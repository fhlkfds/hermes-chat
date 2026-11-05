// @vitest-environment jsdom
// The agent office (ADR 0077), from what a fake Hermes reports through the real transport: the desks and the list show
// the same agents in the same states with the same actions, through a reply's run, Approval, failures, completion and a
// reconnect. Also its keyboard and list-only use, reduced motion, and that it draws and moves nothing while hidden.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { inboxEntries } from "../hermes/inbox";
import { officeRooms, type Room } from "../hermes/office";
import { SUBAGENTS_MAX, onSubagentEvent, type SubagentTree } from "../hermes/subagents";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";
import { Office } from "./Office";
import { setWindowHidden } from "./windowState";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWindowHidden(false);
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const who = (subagent_id: string, goal: string, more: Record<string, unknown> = {}) => ({ goal, task_count: 1, task_index: 0, subagent_id, depth: 0, model: "claude-sonnet-4-5", ...more });

/** The office's rooms for the app's snapshot now, as App works them out. */
function roomsOf(hermes: Hermes): { rooms: Room[]; connected: boolean } {
  const s = hermes.getSnapshot();
  const connected = s.status === "connected";
  const { entries } = inboxEntries({ profile: s.profile, chats: s.chats, connected, others: s.others, live: s.live });
  return { rooms: officeRooms({ entries, shown: () => true, chats: s.chats, profile: s.profile, connected }), connected };
}

/** Every desk's label, and where pressing each one goes, in one view. */
function seen({ rooms, connected }: { rooms: Room[]; connected: boolean }, view: "desks" | "list") {
  const onOpen = vi.fn();
  const { unmount } = render(<Office rooms={rooms} view={view} onView={() => {}} server="hermes" profile="default" connected={connected} onOpen={onOpen} onClose={() => {}} />);
  const desks = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-desk]"));
  const labels = desks.map((d) => d.getAttribute("aria-label")!);
  desks.forEach((d) => fireEvent.click(d));
  const opened = onOpen.mock.calls.map(([r, d]) => `${r.chatId} ${d.agent.kind === "subagent" ? d.agent.id : "reply"}`);
  unmount();
  return { labels, opened };
}

/** Both views agree, and each desk's state as its label says it, by name. */
function states(hermes: Hermes): string[] {
  const now = roomsOf(hermes);
  const desks = seen(now, "desks");
  expect(seen(now, "list")).toEqual(desks);
  return desks.labels.map((l) => l.split(", in “")[0].replace(/, started by “[^”]*”$/, ""));
}

describe("Desks and the list", () => {
  it("show the same agents, states and actions through a run, an Approval, failures, a completion and a reconnect", async () => {
    vi.useFakeTimers();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Audit the repo");
    const runtime = server.runtimeIdOf(id)!;

    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("sa-auth", "Read the auth code", { delegation_id: "d1" }));
    server.event(runtime, "subagent.spawn_requested", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.start", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1 }));
    expect(states(hermes)).toEqual(["The chat's reply, Running", "Read the auth code, Running", "Check token expiry, Running", "Read the tests, Queued"]);
    expect(seen(roomsOf(hermes), "desks").opened).toEqual([`${id} reply`, `${id} sa-auth`, `${id} sa-expiry`, `${id} sa-tests`]);

    const asked = server.askApproval(runtime);
    await hermes.idle();
    expect(states(hermes)[0]).toBe("The chat's reply, Waiting for your approval");
    server.cancelRequest(asked.id!, "timeout");
    await hermes.idle();
    expect(states(hermes)[0]).toBe("The chat's reply, Running");

    server.event(runtime, "subagent.start", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.complete", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2, status: "failed", summary: "Rate limited." }));
    server.event(runtime, "subagent.complete", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1, status: "completed", summary: "Tokens expire in 1h." }));
    expect(states(hermes).slice(1)).toEqual(["Read the auth code, Running", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    // Dropped: everything is as last seen, nothing looks current, and a running desk shows no typing.
    server.drop();
    await hermes.idle().catch(() => {});
    expect(states(hermes)).toEqual([
      "The chat's reply, Not known yet, as last seen",
      "Read the auth code, Running, as last seen",
      "Check token expiry, Finished, as last seen",
      "Read the tests, Failed, as last seen",
    ]);
    render(<Office {...roomsOf(hermes)} view="desks" onView={() => {}} server="hermes" profile="default" onOpen={() => {}} onClose={() => {}} />);
    expect(document.querySelectorAll(".desk.is-stale")).toHaveLength(4);
    expect(document.querySelector(".desk-typing")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Office" }).textContent).toMatch(/Not connected to Hermes: every desk is as last seen\./);
    cleanup();

    // Back: Hermes's roster no longer lists the running one, so it ended unheard. That is never shown as finished.
    server.subagents[id] = [];
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(hermes.getSnapshot().status).toBe("connected");
    const back = states(hermes);
    expect(back.filter((s) => s.includes("as last seen"))).toEqual([]);
    expect(back.slice(1)).toEqual(["Read the auth code, Ended, Hermes didn't say how", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.event(server.runtimeIdOf(id)!, "message.start");
    server.event(server.runtimeIdOf(id)!, "message.complete", { status: "error", failure_reason: "provider timed out", text: "" });
    expect(states(hermes)[0]).toBe("The chat's reply, Failed");
  });

  it("show many agents the same way: ten chats of the most subagents a chat keeps", () => {
    const chats = Array.from({ length: 10 }, (_, n) => {
      let tree: SubagentTree | undefined;
      for (let i = 0; i < SUBAGENTS_MAX; i++)
        tree = onSubagentEvent(tree, i % 3 ? "subagent.complete" : "subagent.start", who(`s${i}`, `Task ${i}`, { status: "completed" }), 1_000);
      return { id: `c${n}`, title: `Chat ${n}`, source: "app" as const, settled: false, updatedAt: 1_000, items: [], running: true, subagents: tree };
    });
    const { entries } = inboxEntries({ profile: "default", chats, connected: true, others: { byName: {} } });
    const desks = seen({ rooms: officeRooms({ entries, shown: () => true, chats, profile: "default", connected: true }), connected: true }, "desks");
    expect(desks.labels).toHaveLength(10 * (SUBAGENTS_MAX + 1));
    expect(new Set(desks.opened).size).toBe(desks.opened.length);
    expect(seen({ rooms: officeRooms({ entries, shown: () => true, chats, profile: "default", connected: true }), connected: true }, "list")).toEqual(desks);
  });

  it("keeps a desk only Hermes's own completion marks finished", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const id = await hermes.newChat();
    await hermes.send(id, "Audit the repo");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("a", "One"));
    server.event(runtime, "subagent.start", who("b", "Two"));
    server.event(runtime, "subagent.complete", who("a", "One", { status: "completed" }));
    server.event(runtime, "subagent.complete", who("b", "Two", { status: "whatever" }));
    server.event(runtime, "message.complete", { status: "complete", text: "Done." });
    await hermes.idle();
    // The reply ended, but the chat is read: no inbox entry says it finished, so its desk doesn't.
    expect(states(hermes)).toEqual(["The chat's reply, Not running", "One, Finished", "Two, Ended, Hermes didn't say how"]);
    render(<Office {...roomsOf(hermes)} view="desks" onView={() => {}} server="hermes" profile="default" onOpen={() => {}} onClose={() => {}} />);
    expect(Array.from(document.querySelectorAll(".desk.state-completed")).map((d) => d.querySelector(".desk-name")!.textContent)).toEqual(["One"]);
  });
});

/** Rooms as officeRooms makes them, for the component alone: a chat in another profile, and one with two subagents. */
function sample(): Room[] {
  return [
    {
      key: "work deploy",
      profile: "work",
      chatId: "deploy",
      title: "Deploy plan",
      desks: [{ key: "work deploy reply", agent: { kind: "reply" }, name: "The chat's reply", state: "approval", doing: { text: "A command is waiting for your approval.", at: 0 } }],
    },
    {
      key: "default audit",
      profile: "default",
      chatId: "audit",
      title: "Audit",
      desks: [
        { key: "default audit reply", agent: { kind: "reply" }, name: "The chat's reply", state: "running" },
        { key: "default audit a", agent: { kind: "subagent", id: "a" as never, depth: 0 }, name: "Read the auth code", state: "running" },
        { key: "default audit b", agent: { kind: "subagent", id: "b" as never, depth: 1, parent: "a" as never }, name: "Check expiry", state: "completed" },
      ],
    },
  ];
}

function office(view: "desks" | "list", over: Partial<Parameters<typeof Office>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onView = vi.fn();
  render(<Office rooms={sample()} view={view} onView={onView} server="hermes" profile="default" connected onOpen={onOpen} onClose={onClose} {...over} />);
  const desks = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-desk]"));
  return { onOpen, onClose, onView, desks, user: userEvent.setup() };
}

describe("The office from the keyboard", () => {
  it.each(["desks", "list"] as const)("moves between every desk with the arrows, Home and End, and opens one with Enter (%s)", async (view) => {
    const { onOpen, onClose, desks, user } = office(view);
    expect(document.activeElement).toBe(desks()[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(desks()[1]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(desks()[2]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(desks()[3]);
    await user.keyboard("{ArrowUp}{Home}");
    expect(document.activeElement).toBe(desks()[0]);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toMatchObject({ agent: { kind: "subagent", id: "a" } });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("asks before a desk in another profile leaves something behind, and Escape backs out of the question first", async () => {
    const { onOpen, onClose, user } = office("list", { leaving: "Switching profiles leaves a reply running here." });
    await user.keyboard("{Enter}");
    const ask = screen.getByRole("alertdialog", { name: "Switch to work?" });
    expect(onOpen).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("data-desk")).toBe("work deploy reply");
    await user.keyboard("{Enter}");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Switch to work" }));
    expect(onOpen.mock.calls[0][0]).toMatchObject({ profile: "work", chatId: "deploy" });
    expect(ask.isConnected).toBe(false);
  });

  it("switches between desks and the list with the same agents named the same way", async () => {
    const { onView, user, desks } = office("desks");
    const labels = desks().map((d) => d.getAttribute("aria-label"));
    expect(labels[3]).toBe("Check expiry, Finished, started by “Read the auth code”, in “Audit”.");
    expect(labels[0]).toBe("The chat's reply, Waiting for your approval, in “Deploy plan”, profile work. A command is waiting for your approval.");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(onView).toHaveBeenCalledWith("list");
    cleanup();
    office("list");
    expect(Array.from(document.querySelectorAll("[data-desk]")).map((d) => d.getAttribute("aria-label"))).toEqual(labels);
  });
});

describe("Motion", () => {
  const motion = () => document.querySelector(".office-floor")!.getAttribute("data-motion");
  const prefersReduced = (reduce: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)", media: q, addEventListener() {}, removeEventListener() {} }));

  it("moves a running desk's screen only when the system doesn't ask for reduced motion", () => {
    prefersReduced(false);
    office("desks");
    expect(motion()).toBe("on");
    expect(document.querySelectorAll(".desk.state-running .desk-typing")).toHaveLength(2);
    cleanup();
    prefersReduced(true);
    office("desks");
    expect(motion()).toBe("still");
  });

  it("holds still while the window is hidden to the tray or the page can't be seen", () => {
    prefersReduced(false);
    office("desks");
    act(() => setWindowHidden(true));
    expect(motion()).toBe("still");
    act(() => setWindowHidden(false));
    expect(motion()).toBe("on");
    const was = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(motion()).toBe("still");
    if (was) Object.defineProperty(document, "visibilityState", was);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  });
});

/** Signed in, with "Audit" open, its reply running with two subagents and one under the first, and an Approval asked. */
async function auditing() {
  const server = new FakeHermes();
  server.sessions = [row("audit", 1, { pinned: true, title: "Audit" }), row("other", 2, { pinned: true, title: "Other" })];
  server.transcripts = { audit: [{ role: "user", text: "Audit the repo" }], other: [{ role: "user", text: "Hi" }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Audit/ }));
  await act(async () => void (await hermes.idle()));
  const runtime = server.runtimeIdOf("audit")!;
  server.subagents.audit = [
    { subagent_id: "sa-auth", owner: runtime, accepting_steer: true, status: "running" },
    { subagent_id: "sa-expiry", owner: runtime, accepting_steer: true, status: "running" },
  ];
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "subagent.start", who("sa-auth", "Read the auth code"));
    server.event(runtime, "subagent.start", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1 }));
    server.askApproval(runtime);
  });
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user, runtime };
}

const officeButton = () => document.querySelector<HTMLButtonElement>(".office-btn");
/** What the app asked Hermes to do, as opposed to read: answers, sends, stops and steers. */
const writes = (server: FakeHermes) => [
  ...server.responses,
  ...server.requests.filter((r) => ["prompt.submit", "session.interrupt", "subagent.steer", "subagent.interrupt"].includes(r.method)),
];

describe("The office in the app", () => {
  it("opens a subagent's desk in its chat's Subagents panel and the reply's desk at its Approval, without answering or sending anything", async () => {
    const { server, user } = await auditing();
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    const before = writes(server).length;

    await user.click(officeButton()!);
    const room = screen.getByRole("region", { name: "Audit" });
    await user.click(within(room).getByRole("button", { name: /^Check token expiry, Running, started by “Read the auth code”/ }));
    expect(screen.queryByRole("dialog", { name: "Office" })).toBeNull();
    const panel = screen.getByRole("region", { name: "Subagents" });
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Check token expiry" })));

    await user.click(officeButton()!);
    await user.click(within(screen.getByRole("region", { name: "Audit" })).getByRole("button", { name: /^The chat's reply, Waiting for your approval/ }));
    await waitFor(() => expect(document.activeElement?.closest(".approval")).toBeTruthy());
    expect(writes(server)).toHaveLength(before);
  });

  it("is off with no rail button and nothing drawn when Settings turns it off, and draws nothing while closed", async () => {
    await auditing();
    expect(officeButton()).toBeTruthy();
    expect(document.querySelector(".office")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "list" }));
    await userEvent.setup().click(officeButton()!);
    expect(document.querySelector(".office-list")).toBeTruthy();
    expect(document.querySelector(".office-floor")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "off" }));
    expect(officeButton()).toBeNull();
    expect(document.querySelector(".office")).toBeNull();
  });
});
