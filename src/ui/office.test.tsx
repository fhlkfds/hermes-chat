// @vitest-environment jsdom
// The agent office (ADR 0077, ADR 0089), from what a fake Hermes reports through the real transport: the building and
// the list show the same agents in the same states with the same Open chat, through a reply's run, Approval, failures,
// completion and a reconnect. Also the building's tags, "!", card and "+N more", its List fallback without WebGL, the
// keyboard, reduced motion, and that it draws nothing while hidden. jsdom has no WebGL: the building's drawing is a
// stand-in here that places each character in a row (officeEngine.test.ts tests the real one's frame budget).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { inboxEntries } from "../hermes/inbox";
import { FLOOR_MAX, officeRooms, type Room } from "../hermes/office";
import { SUBAGENTS_MAX, onSubagentEvent, type SubagentTree } from "../hermes/subagents";
import { connect, type Hermes } from "../hermes/transport";
import { setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";
import { Office } from "./Office";
import type { EngineLoad } from "./OfficeBuilding";
import type { EngineAgent, EngineOptions, OfficeEngine } from "./officeEngine";
import { setWindowHidden } from "./windowState";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

/** The drawings made, newest last, so a test can see what the building was told. */
const drawings: { agents: readonly EngineAgent[]; motion: boolean; active: boolean; theme: string; disposed: boolean }[] = [];
/** A stand-in for the three.js drawing: each character in a row, 40 px apart, drawn once per change. */
function standIn(o: EngineOptions): OfficeEngine {
  const d = { agents: [] as readonly EngineAgent[], motion: true, active: true, theme: "", disposed: false };
  drawings.push(d);
  let frames = 0;
  const draw = () => {
    frames++;
    o.onFrame?.(frames);
    const at = { x: 0, y: 0, hidden: false };
    o.onProject(d.agents.map((a, i) => ({ key: a.key, x: 40 + i * 40, y: 100, w: 20, h: 40, hidden: false })), { workroom: at, waiting: at, trouble: at, lounge: at }, at);
  };
  return {
    setAgents: (a) => void ((d.agents = a), draw()),
    setMotion: (on) => void (d.motion = on),
    setActive: (on) => void (d.active = on),
    setTheme: (mode) => void (d.theme = mode),
    resetView: draw,
    dragged: () => false,
    get frames() {
      return frames;
    },
    dispose: () => void (d.disposed = true),
  };
}
const load: EngineLoad = async () => standIn;
// The app loads the real drawing: here it gets the stand-in, on a computer that says it has WebGL.
vi.mock("./officeEngine", async (real) => ({ ...(await real<typeof import("./officeEngine")>()), createOfficeEngine: (o: EngineOptions) => standIn(o) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  HTMLCanvasElement.prototype.getContext = (() => ({ getExtension: () => null })) as never;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWindowHidden(false);
  drawings.length = 0;
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

const agentButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-desk]"));

/** Every agent's label, and where its Open chat goes, in one view, in reading order. */
async function seen({ rooms, connected }: { rooms: Room[]; connected: boolean }, view: "building" | "list") {
  const onOpen = vi.fn();
  const { unmount } = render(<Office rooms={rooms} view={view} onView={() => {}} server="hermes" profile="default" connected={connected} load={load} onOpen={onOpen} onClose={() => {}} />);
  const labels = agentButtons().map((d) => d.getAttribute("aria-label")!);
  for (const key of agentButtons().map((d) => d.dataset.desk!)) {
    fireEvent.click(document.querySelector(`[data-desk="${key}"]`)!);
    // In the building, an agent opens its card; Open chat on it goes where List goes.
    if (view === "building") fireEvent.click(within(await screen.findByRole("dialog", { name: /./ })).getByRole("button", { name: "Open chat" }));
  }
  const opened = onOpen.mock.calls.map(([r, d]) => `${r.chatId} ${d.agent.kind === "subagent" ? d.agent.id : "reply"}`);
  unmount();
  return { labels, opened };
}
/** The same agents, in whatever order each view reads them, each opening the same place. */
const asSet = (v: { labels: string[]; opened: string[] }) => v.labels.map((l, i) => `${l} -> ${v.opened[i]}`).sort();

/** Both views agree, and each agent's state as its label says it, by name, in List's order. */
async function states(hermes: Hermes): Promise<string[]> {
  const now = roomsOf(hermes);
  const list = await seen(now, "list");
  expect(asSet(await seen(now, "building"))).toEqual(asSet(list));
  return list.labels.map((l) => l.split(", in “")[0].replace(/, started by “[^”]*”$/, ""));
}

describe("The building and the list", () => {
  it("show the same agents, states and Open chat through a run, an Approval, failures, a completion and a reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    expect(await states(hermes)).toEqual(["The chat's reply, Running", "Read the auth code, Running", "Check token expiry, Running", "Read the tests, Queued"]);
    expect((await seen(roomsOf(hermes), "list")).opened).toEqual([`${id} reply`, `${id} sa-auth`, `${id} sa-expiry`, `${id} sa-tests`]);

    const asked = server.askApproval(runtime);
    await hermes.idle();
    expect((await states(hermes))[0]).toBe("The chat's reply, Waiting for your approval");
    server.cancelRequest(asked.id!, "timeout");
    await hermes.idle();
    expect((await states(hermes))[0]).toBe("The chat's reply, Running");

    server.event(runtime, "subagent.start", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2 }));
    server.event(runtime, "subagent.complete", who("sa-tests", "Read the tests", { delegation_id: "d1", task_index: 1, task_count: 2, status: "failed", summary: "Rate limited." }));
    server.event(runtime, "subagent.complete", who("sa-expiry", "Check token expiry", { parent_id: "sa-auth", depth: 1, status: "completed", summary: "Tokens expire in 1h." }));
    expect((await states(hermes)).slice(1)).toEqual(["Read the auth code, Running", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.transcripts[id] = [{ role: "user", text: "Audit the repo" }];
    server.drop();
    await hermes.idle().catch(() => {});
    expect(await states(hermes)).toEqual([
      "The chat's reply, Not known yet, as last seen",
      "Read the auth code, Running, as last seen",
      "Check token expiry, Finished, as last seen",
      "Read the tests, Failed, as last seen",
    ]);
    render(<Office {...roomsOf(hermes)} view="building" onView={() => {}} server="hermes" profile="default" load={load} onOpen={() => {}} onClose={() => {}} />);
    expect(document.querySelectorAll(".bld-agent.is-stale")).toHaveLength(4);
    expect(drawings.at(-1)!.agents.every((a) => a.stale)).toBe(true);
    expect(screen.getByRole("region", { name: "Office" }).textContent).toMatch(/Not connected to Hermes: every agent is as last seen\./);
    cleanup();

    server.subagents[id] = [];
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(hermes.getSnapshot().status).toBe("connected");
    const back = await states(hermes);
    expect(back.filter((s) => s.includes("as last seen"))).toEqual([]);
    expect(back.slice(1)).toEqual(["Read the auth code, Ended, Hermes didn't say how", "Check token expiry, Finished", "Read the tests, Failed"]);

    server.event(server.runtimeIdOf(id)!, "message.start");
    server.event(server.runtimeIdOf(id)!, "message.complete", { status: "error", failure_reason: "provider timed out", text: "" });
    expect((await states(hermes))[0]).toBe("The chat's reply, Failed");
  });

  it(`draws at most ${FLOOR_MAX} on a floor and a "+N more" sign that shows the rest in List`, async () => {
    const chats = Array.from({ length: 10 }, (_, n) => {
      let tree: SubagentTree | undefined;
      for (let i = 0; i < SUBAGENTS_MAX; i++)
        tree = onSubagentEvent(tree, i % 3 ? "subagent.complete" : "subagent.start", who(`s${i}`, `Task ${i}`, { status: "completed" }), 1_000);
      return { id: `c${n}`, title: `Chat ${n}`, source: "app" as const, settled: false, updatedAt: 1_000, items: [], running: true, subagents: tree };
    });
    const { entries } = inboxEntries({ profile: "default", chats, connected: true, others: { byName: {} } });
    const rooms = officeRooms({ entries, shown: () => true, chats, profile: "default", connected: true });
    const all = 10 * (SUBAGENTS_MAX + 1);
    render(<Office rooms={rooms} view="building" onView={() => {}} server="hermes" profile="default" connected load={load} onOpen={() => {}} onClose={() => {}} />);
    expect(agentButtons()).toHaveLength(FLOOR_MAX);
    await waitFor(() => expect(drawings.at(-1)?.agents).toHaveLength(FLOOR_MAX));
    await userEvent.setup().click(screen.getByRole("button", { name: `+${all - FLOOR_MAX} more` }));
    expect(agentButtons()).toHaveLength(all);
    expect(screen.getByRole("list", { name: "Agents" })).toBeTruthy();
  }, 20_000);

  it("keeps an agent only Hermes's own completion marks finished", async () => {
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
    // The reply ended, but the chat is read: no inbox entry says it finished, so it doesn't.
    expect(await states(hermes)).toEqual(["The chat's reply, Not running", "One, Finished", "Two, Ended, Hermes didn't say how"]);
    render(<Office {...roomsOf(hermes)} view="building" onView={() => {}} server="hermes" profile="default" load={load} onOpen={() => {}} onClose={() => {}} />);
    expect(Array.from(document.querySelectorAll(".bld-agent.state-completed")).map((d) => d.querySelector(".bld-tag-name")!.textContent)).toEqual(["One"]);
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
        { key: "default audit reply", agent: { kind: "reply" }, name: "The chat's reply", state: "running", about: { model: "claude-opus-5-5" } },
        {
          key: "default audit a",
          agent: { kind: "subagent", id: "a" as never, depth: 0 },
          name: "Read the auth code",
          state: "running",
          doing: { text: "read_file src/auth.ts", at: Date.now() },
          about: { goal: "Read the auth code", model: "claude-sonnet-4-5", startedAt: Date.now() - 125_000 },
        },
        { key: "default audit b", agent: { kind: "subagent", id: "b" as never, depth: 1, parent: "a" as never }, name: "Check expiry", state: "completed", about: { durationS: 42 } },
      ],
    },
  ];
}

function office(view: "building" | "list", over: Partial<Parameters<typeof Office>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onView = vi.fn();
  const r = render(<Office rooms={sample()} view={view} onView={onView} server="hermes" profile="default" connected load={load} onOpen={onOpen} onClose={onClose} {...over} />);
  return { onOpen, onClose, onView, desks: agentButtons, user: userEvent.setup(), rerender: r.rerender };
}

describe("The office from the keyboard", () => {
  it("moves between every agent in List with the arrows, Home and End, and opens one with Enter", async () => {
    const { onOpen, onClose, desks, user } = office("list");
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

  it("moves between the building's characters the same way; Enter opens a card, and Escape closes the card before the office", async () => {
    const { onOpen, onClose, desks, user } = office("building");
    expect(desks().map((d) => d.dataset.desk)).toEqual(["default audit reply", "default audit a", "default audit b"]);
    expect(document.activeElement).toBe(desks()[0]);
    await user.keyboard("{ArrowDown}{Enter}");
    const card = screen.getByRole("dialog", { name: "Read the auth code" });
    expect(document.activeElement).toBe(within(card).getByRole("button", { name: "Open chat" }));
    expect(onOpen).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(desks()[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(desks()[2]);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("asks before an agent in another profile leaves something behind, and Escape backs out of the question first", async () => {
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

  it("switches between the building and List, naming the floor's agents the same way in both", async () => {
    const { onView, user, desks } = office("building");
    const labels = desks().map((d) => d.getAttribute("aria-label"));
    expect(labels[2]).toBe("Check expiry, Finished, started by “Read the auth code”, in “Audit”.");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(onView).toHaveBeenCalledWith("list");
    cleanup();
    office("list");
    expect(desks().map((d) => d.getAttribute("aria-label"))).toEqual([
      "The chat's reply, Waiting for your approval, in “Deploy plan”, profile work. A command is waiting for your approval.",
      ...labels,
    ]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Building" }));
  });
});

describe("The building", () => {
  it("draws the floor shown, with each agent in its room and team, and counts the other profiles' agents", async () => {
    const { user } = office("building");
    await waitFor(() => expect(drawings.at(-1)?.agents).toHaveLength(3));
    expect(drawings.at(-1)!.agents.map((a) => [a.key, a.floorRoom, a.team])).toEqual([
      ["default audit reply", "workroom", 0],
      ["default audit a", "workroom", 0],
      ["default audit b", "lounge", 0],
    ]);
    expect(within(screen.getByRole("list", { name: "Workroom" })).getAllByRole("button")).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "Lounge" })).getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "1 in other profiles" }));
    expect(screen.getByRole("list", { name: "Agents" })).toBeTruthy();
  });

  it("puts the character's button where the drawing says, and its tag holds only the name, a state dot and \"as last seen\"", async () => {
    const rooms = sample();
    rooms[1].desks[2] = { ...rooms[1].desks[2], stale: "Not connected to Hermes: as last seen." };
    office("building", { rooms });
    const a = document.querySelector<HTMLElement>('[data-desk="default audit a"]')!;
    await waitFor(() => expect(a.hasAttribute("data-placed")).toBe(true));
    expect(a.style.transform).toBe("translate(70px, 100px)");
    expect(a.querySelector(".bld-tag")!.textContent).toBe("Read the auth code");
    expect(a.querySelector(".bld-tag .bld-dot")).toBeTruthy();
    expect(document.querySelector('[data-desk="default audit b"] .bld-tag')!.textContent).toBe("Check expiryas last seen");
  });

  it('marks every agent waiting for the owner with a "!", and no one else', () => {
    const rooms = sample();
    rooms[1].desks[1] = { ...rooms[1].desks[1], state: "approval" };
    rooms[1].desks.push({ key: "default audit c", agent: { kind: "subagent", id: "c" as never, depth: 0 }, name: "Send it?", state: "uncertain" });
    office("building", { rooms });
    expect(Array.from(document.querySelectorAll(".bld-agent:has(.bld-bang)")).map((b) => (b as HTMLElement).dataset.desk)).toEqual(["default audit a", "default audit c"]);
    expect(within(screen.getByRole("list", { name: "Waiting room" })).getAllByRole("button")).toHaveLength(2);
  });

  it("opens a card with what the app knows, keeps it current, and Open chat goes where List's row goes", async () => {
    const { user, rerender, onOpen } = office("building");
    await user.click(document.querySelector<HTMLElement>('[data-desk="default audit a"]')!);
    const card = screen.getByRole("dialog", { name: "Read the auth code" });
    const rows = () => Object.fromEntries(Array.from(card.querySelectorAll("dl > div")).map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]));
    expect(rows()).toMatchObject({ Chat: "Audit", Profile: "default", State: "Running", Goal: "Read the auth code", Model: "claude-sonnet-4-5" });
    expect(rows()["Doing now"]).toBe("read_file src/auth.ts (just now)");
    expect(rows()["Has run"]).toMatch(/^2 min \d+ s$/);
    expect(card.textContent).not.toMatch(/Approve|Stop|Steer|Send/);

    const later = sample();
    later[1].desks[1] = { ...later[1].desks[1], state: "failed", about: { ...later[1].desks[1].about, durationS: 200 } };
    rerender(<Office rooms={later} view="building" onView={() => {}} server="hermes" profile="default" connected load={load} onOpen={onOpen} onClose={() => {}} />);
    expect(rows()).toMatchObject({ State: "Failed", "Has run": "3 min 20 s" });
    expect(within(screen.getByRole("list", { name: "Trouble room" })).getByRole("button", { expanded: true })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Open chat" }));
    expect(onOpen.mock.calls[0][1]).toMatchObject({ agent: { kind: "subagent", id: "a" } });

    // An agent that leaves the office takes its card with it.
    rerender(<Office rooms={[{ ...later[1], desks: later[1].desks.slice(0, 1) }]} view="building" onView={() => {}} server="hermes" profile="default" connected load={load} onOpen={onOpen} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a character placed and clickable after its card opens and closes", async () => {
    const { user } = office("building");
    const a = () => document.querySelector<HTMLElement>('[data-desk="default audit a"]')!;
    await waitFor(() => expect(a().hasAttribute("data-placed")).toBe(true));
    await user.click(a());
    expect(a().className).toContain("is-picked");
    expect(a().hasAttribute("data-placed")).toBe(true);
    await user.click(within(screen.getByRole("dialog", { name: "Read the auth code" })).getByRole("button", { name: "Close the card" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(a().hasAttribute("data-placed")).toBe(true);
    await user.click(a());
    expect(screen.getByRole("dialog", { name: "Read the auth code" })).toBeTruthy();
  });

  it("leaves focus where the owner put it after a click on the floor, and follows an agent that moves to another room", async () => {
    const { rerender } = office("building");
    const props = { view: "building" as const, onView: () => {}, server: "hermes", profile: "default", connected: true, load, onOpen: () => {}, onClose: () => {} };
    const a = () => document.querySelector<HTMLElement>('[data-desk="default audit a"]')!;
    act(() => a().focus());
    act(() => a().blur());
    expect(document.activeElement).toBe(document.body);
    rerender(<Office rooms={sample()} {...props} />);
    expect(document.activeElement).toBe(document.body);
    // Nor once the agent it left later moves to another room.
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const failed = sample();
    failed[1].desks[1] = { ...failed[1].desks[1], state: "failed" };
    rerender(<Office rooms={failed} {...props} />);
    expect(within(screen.getByRole("list", { name: "Trouble room" })).getByRole("button")).toBe(a());
    expect(document.activeElement).toBe(document.body);
    rerender(<Office rooms={sample()} {...props} />);

    act(() => a().focus());
    const moved = sample();
    moved[1].desks[1] = { ...moved[1].desks[1], state: "failed" };
    rerender(<Office rooms={moved} {...props} />);
    expect(within(screen.getByRole("list", { name: "Trouble room" })).getByRole("button")).toBe(a());
    expect(document.activeElement).toBe(a());
  });

  it("shows List, and says why, on a computer that can't draw it", async () => {
    office("building", { load: async () => undefined });
    expect(await screen.findByText("This computer can't draw the building (no WebGL), so the office shows List.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Building" }).hasAttribute("disabled")).toBe(true);
  });

  it("stops the drawing's motion when the system asks for reduced motion, and lets it go when the office closes", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)", media: q, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = office("building");
    await waitFor(() => expect(drawings).toHaveLength(1));
    await waitFor(() => expect(drawings[0].motion).toBe(false));
    expect(drawings[0].theme).toBe("dark");
    rerender(<></>);
    expect(drawings[0].disposed).toBe(true);
  });

  it("draws nothing while the window isn't focused", async () => {
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    office("building");
    await waitFor(() => expect(drawings).toHaveLength(1));
    expect(drawings[0].active).toBe(true);
    focused = false;
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(drawings[0].active).toBe(false);
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(drawings[0].active).toBe(true);
  });

  it("counts frames for the budget, shown with F", async () => {
    const { user } = office("building");
    const building = document.querySelector<HTMLElement>(".bld")!;
    await waitFor(() => expect(building.dataset.frames).toBe("1"));
    await user.keyboard("f");
    expect(document.querySelector(".bld-frames")!.textContent).toBe("1 frames · 0 in the last second");
  });
});

describe("An agent that goes while it has focus", () => {
  it("leaves focus on the agent now in its place, where the keys still work", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const props = { view: "list" as const, onView: () => {}, server: "hermes", profile: "default", connected: true, load, onOpen: () => {}, onClose };
    const { rerender } = render(<Office rooms={sample()} {...props} />);
    expect(document.activeElement?.getAttribute("data-desk")).toBe("work deploy reply");
    rerender(<Office rooms={sample().slice(1)} {...props} />);
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit reply");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit a");
    rerender(<Office rooms={[]} {...props} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close the office" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it.each(["building", "list"] as const)("follows the agent as those before it go, so the one after it takes its place (%s)", (view) => {
    const desk = (id: string) => ({ key: `default audit ${id}`, agent: { kind: "subagent" as const, id: id as never, depth: 0 }, name: `Task ${id}`, state: "running" as const });
    const audit = (ids: string[]): Room => ({ key: "default audit", profile: "default", chatId: "audit", title: "Audit", desks: ids.map(desk) });
    const first = sample()[0];
    const props = { view, onView: () => {}, server: "hermes", profile: "default", connected: true, load, onOpen: () => {}, onClose: () => {} };
    const { rerender } = render(<Office rooms={[first, audit(["a", "b", "c", "d"])]} {...props} />);
    document.querySelector<HTMLElement>('[data-desk="default audit b"]')!.focus();
    rerender(<Office rooms={[audit(["a", "b", "c", "d"])]} {...props} />);
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit b");
    rerender(<Office rooms={[audit(["a", "c", "d"])]} {...props} />);
    expect(document.activeElement?.getAttribute("data-desk")).toBe("default audit c");
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
/** Opens a character's card in the building, and its Open chat. */
async function openFromCard(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("button", { name }));
  await user.click(within(screen.getByRole("dialog", { name: /./ })).getByRole("button", { name: "Open chat" }));
}

describe("The office in the app", () => {
  it("opens in place of the chat panes, and Escape or picking a chat goes back", async () => {
    const { user } = await auditing();
    await user.click(officeButton()!);
    expect(screen.getByRole("region", { name: "Office" })).toBeTruthy();
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);

    await user.click(officeButton()!);
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    expect(document.querySelector(".chat-head")!.textContent).toContain("Other");
  });

  it("opens a subagent in its chat's Subagents panel and the reply at its Approval, from their cards, without answering or sending anything", async () => {
    const { server, user } = await auditing();
    await user.click(screen.getByRole("button", { name: /^Other/ }));
    const before = writes(server).length;

    await user.click(officeButton()!);
    expect(within(screen.getByRole("list", { name: "Workroom" })).getAllByRole("button")).toHaveLength(2);
    await openFromCard(user, /^Check token expiry, Running, started by “Read the auth code”/);
    expect(screen.queryByRole("region", { name: "Office" })).toBeNull();
    const panel = screen.getByRole("region", { name: "Subagents" });
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Check token expiry" })));

    await user.click(officeButton()!);
    expect(within(screen.getByRole("list", { name: "Waiting room" })).getByRole("button", { name: /^The chat's reply, Waiting for your approval/ })).toBeTruthy();
    await openFromCard(user, /^The chat's reply, Waiting for your approval/);
    await waitFor(() => expect(document.activeElement?.closest(".approval")).toBeTruthy());
    expect(writes(server)).toHaveLength(before);
  });

  it("asks Hermes for nothing of its own while open: the other profiles are read every two minutes, as when it is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { hermes, user } = await auditing();
    const checks = vi.spyOn(hermes, "checkOtherProfiles");
    await user.click(officeButton()!);
    await waitFor(() => expect(drawings).toHaveLength(1));
    expect(checks).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2 * 60_000)));
    expect(document.querySelector(".office")).toBeTruthy();
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("isn't drawn while the window is hidden to the tray or minimized", async () => {
    const { hermes, user } = await auditing();
    const checks = vi.spyOn(hermes, "checkOtherProfiles");
    await user.click(officeButton()!);
    expect(document.querySelector(".office")).toBeTruthy();
    await waitFor(() => expect(drawings).toHaveLength(1));

    act(() => setWindowHidden(true));
    expect(document.querySelector(".office")).toBeNull();
    expect(drawings[0].disposed).toBe(true);
    act(() => setWindowHidden(false));
    expect(document.querySelector(".office")).toBeTruthy();

    const was = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(document.querySelector(".office")).toBeNull();
    if (was) Object.defineProperty(document, "visibilityState", was);
    else delete (document as { visibilityState?: unknown }).visibilityState;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(document.querySelector(".office")).toBeTruthy();
    expect(checks).not.toHaveBeenCalled();
  });

  it("is off with no rail button and nothing drawn when Settings turns it off, and draws nothing while closed", async () => {
    await auditing();
    expect(officeButton()).toBeTruthy();
    expect(document.querySelector(".office")).toBeNull();
    expect(drawings).toHaveLength(0);
    act(() => void setUIPrefs({ agentOffice: "list" }));
    await userEvent.setup().click(officeButton()!);
    expect(document.querySelector(".office-list")).toBeTruthy();
    expect(document.querySelector(".bld")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "building" }));
    expect(document.querySelector(".bld [data-desk]")).toBeTruthy();
    expect(document.querySelector(".office-list")).toBeNull();
    act(() => void setUIPrefs({ agentOffice: "off" }));
    expect(officeButton()).toBeNull();
    expect(document.querySelector(".office")).toBeNull();
  });
});
