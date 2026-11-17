// @vitest-environment jsdom
// The Work page in the app (issue #595), against a fake Hermes whose kanban plugin routes behave as the official desktop
// app's Kanban view expects: the board, the workflow, a task with its comments, and the writes that change them.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { NoKanbanPlugin, type Board } from "../hermes/kanban";
import { RestError } from "../hermes/pipe";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { Work, type WorkApi } from "./Work";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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

function server() {
  const s = new FakeHermes();
  s.kanban.add("default", { title: "Research the API", assignee: "researcher", body: "Read the docs and write notes", priority: 2 });
  s.kanban.add("default", { title: "Wait on keys", status: "blocked", latest_summary: "No API key on the host" });
  return s;
}

async function signIn(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return hermes;
}

async function launch(s = server()) {
  await signIn(s);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "Work" })).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "Work" }));
  await waitFor(() => expect(screen.getByText("2 tasks on the current board")).toBeTruthy());
  return { user, s };
}

const column = (name: string) => screen.getByRole("region", { name });
const card = (title: string) => screen.getByText(title).closest<HTMLElement>(".work-card")!;
const dragTo = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = { setData: () => {}, getData: () => "" };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};

describe("the Work page", () => {
  it("shows one column per status, with each card's id, priority, body or block reason, and assignee", async () => {
    await launch();
    const ready = within(column("ready"));
    expect(ready.getByText("Research the API")).toBeTruthy();
    expect(ready.getByText("P2")).toBeTruthy();
    expect(ready.getByText("Read the docs and write notes")).toBeTruthy();
    expect(ready.getByText("researcher")).toBeTruthy();
    expect(within(column("blocked")).getByText("No API key on the host")).toBeTruthy();
    expect(within(column("done")).getByText("Empty")).toBeTruthy();
  });

  it("completes a dragged card only after asking what got done", async () => {
    const { user, s } = await launch();
    const id = s.kanban.boards.default.tasks[0].id;
    dragTo(card("Research the API"), column("done"));
    const dialog = await screen.findByRole("dialog", { name: "Complete Research the API" });
    expect(s.kanban.writes).toEqual([]);
    await user.type(within(dialog).getByRole("textbox", { name: "Summary" }), "Notes are in the repo");
    await user.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(within(column("done")).queryByText("Research the API")).toBeTruthy());
    expect(s.kanban.writes).toEqual([`PATCH ${id} {"status":"done","result":"Notes are in the repo","summary":"Notes are in the repo"}`]);
  });

  it("takes no drop on a column the workflow doesn't allow", async () => {
    const { s } = await launch();
    dragTo(card("Research the API"), column("running"));
    dragTo(card("Research the API"), column("triage"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.kanban.writes).toEqual([]);
    expect(within(column("ready")).getByText("Research the API")).toBeTruthy();
  });

  it("opens a task's sheet, saves only the fields changed, and posts a comment", async () => {
    const { user, s } = await launch();
    const task = s.kanban.boards.default.tasks[0];
    task.comments = [{ id: 1, author: "researcher", body: "Started reading", created_at: 1_700_000_000 }];
    await user.click(card("Research the API"));
    const sheet = await screen.findByRole("dialog", { name: "Research the API" });
    await waitFor(() => expect(within(sheet).getByText("Started reading")).toBeTruthy());
    await user.click(within(sheet).getByRole("button", { name: "Edit" }));
    const title = within(sheet).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Research the new API");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.writes).toEqual([`PATCH ${task.id} {"title":"Research the new API"}`]));
    await waitFor(() => expect(within(column("ready")).getByText("Research the new API")).toBeTruthy());
    await user.type(within(sheet).getByRole("textbox", { name: "Comment" }), "Looks good");
    await user.click(within(sheet).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(within(sheet).getByText("Looks good")).toBeTruthy());
    expect(s.kanban.writes.at(-1)).toBe(`POST ${task.id}/comments {"body":"Looks good"}`);
  });

  it("blocks from the sheet with a reason, which shows on the card", async () => {
    const { user, s } = await launch();
    await user.click(card("Research the API"));
    const sheet = await screen.findByRole("dialog", { name: "Research the API" });
    await user.click(within(sheet).getByRole("button", { name: "Block…" }));
    const ask = await screen.findByRole("dialog", { name: "Block Research the API" });
    await user.type(within(ask).getByRole("textbox", { name: "Reason" }), "Needs a login");
    await user.click(within(ask).getByRole("button", { name: "Block" }));
    await waitFor(() => expect(within(column("blocked")).getByText("Needs a login")).toBeTruthy());
    expect(s.kanban.writes.at(-1)).toMatch(/comments \{"body":"BLOCKED: Needs a login"\}$/);
  });

  it("creates a task once when Create is sent again after a lost answer", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Write the summary");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Assignee" }), "writer");
    s.kanban.failNext = "lost";
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(dialog).getByText(/It may have been created/)).toBeTruthy());
    expect(within(dialog).getByRole("textbox", { name: "Title" }).matches(":disabled")).toBe(true);
    s.kanban.createWarning = "No dispatcher is running";
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("No dispatcher is running")).toBeTruthy();
    expect(s.kanban.boards.default.tasks.filter((t) => t.title === "Write the summary")).toHaveLength(1);
    expect(new Set(s.kanban.writes.map((w) => JSON.parse(w.slice(w.indexOf("{"))).idempotency_key)).size).toBe(1);
    await waitFor(() => expect(within(column("ready")).getByText("Write the summary")).toBeTruthy());
  });

  it("shows a task's whole result in its sheet, apart from its summary", async () => {
    const s = server();
    s.kanban.add("default", { title: "Audit backups", status: "done", latest_summary: "Done", result: "UNIQUE_FINDINGS: the share is read-only" });
    const hermes = await signIn(s);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(await within(column("done")).findByText("Audit backups"));
    const sheet = await screen.findByRole("dialog", { name: "Audit backups" });
    await act(async () => void (await hermes.idle()));
    await waitFor(() => expect(within(sheet).getByText("UNIQUE_FINDINGS: the share is read-only")).toBeTruthy());
    expect(within(sheet).getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(within(sheet).getByText("Done")).toBeTruthy();
  });

  it("keeps focus in a task's sheet from the moment it opens, and closes it on Escape", async () => {
    const { user } = await launch();
    await user.click(card("Research the API"));
    await screen.findByRole("dialog", { name: "Research the API" });
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("dialog", { name: "Research the API" }).contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isn't on the rail when the dashboard has no kanban plugin", async () => {
    const s = server();
    s.kanban.missing = true;
    const hermes = await signIn(s);
    await waitFor(() => expect(hermes.capabilities.getSnapshot().caps.kanban.state).toBe("unsupported"));
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
  });
});

/** A plan: Plan (done) and Fetch (running) come before Build (todo), which an archived card also led to; Notes stands alone. */
function planned() {
  const s = new FakeHermes();
  const k = s.kanban;
  const plan = k.add("default", { title: "Plan the work", status: "done" });
  const fetch = k.add("default", { title: "Fetch the data", status: "running", assignee: "researcher" });
  const build = k.add("default", { title: "Build it", status: "todo", assignee: "writer" });
  const old = k.add("default", { title: "Old spike", status: "archived" });
  k.add("default", { title: "Notes", assignee: "researcher" });
  k.links.push({ parent: plan.id, child: build.id }, { parent: fetch.id, child: build.id }, { parent: old.id, child: build.id });
  return { s, plan, fetch, build, old };
}

async function openPlanned(p = planned()) {
  await signIn(p.s);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Work" }));
  await screen.findByText("4 tasks on the current board");
  return { user, ...p };
}

async function sheetOf(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(card(title));
  return screen.findByRole("dialog", { name: title });
}

describe("planning on the Work page (issue #604)", () => {
  it("draws the board's links as a graph, with a ghost for a card not on the board and unlinked cards apart", async () => {
    const { user, plan, fetch, build, old } = await openPlanned();
    await user.click(screen.getByRole("button", { name: "Graph" }));
    await waitFor(() => expect(document.querySelectorAll("[data-edge]")).toHaveLength(3));
    expect([...document.querySelectorAll("[data-edge]")].map((e) => e.getAttribute("data-edge")).sort()).toEqual(
      [`${plan.id} ${build.id}`, `${fetch.id} ${build.id}`, `${old.id} ${build.id}`].sort(),
    );
    const ghost = screen.getByText("Old spike").closest<HTMLElement>(".work-card")!;
    expect(ghost.classList).toContain("ghost");
    expect(within(ghost).getByText("archived, not on this board")).toBeTruthy();
    expect(within(card("Build it")).getByText("Waits on Plan the work, Fetch the data, Old spike.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Not linked" })).getByText("Notes")).toBeTruthy();
    await user.click(card("Build it"));
    expect(await screen.findByRole("dialog", { name: "Build it" })).toBeTruthy();
  });

  it("reads a linked card's links again on Refresh", async () => {
    const { user, s, build } = await openPlanned();
    await user.click(screen.getByRole("button", { name: "Graph" }));
    await waitFor(() => expect(document.querySelectorAll("[data-edge]")).toHaveLength(3));
    const reads = () => s.restRequests.filter((r) => r.path === `/api/plugins/kanban/tasks/${build.id}`).length;
    const before = reads();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("warns that removing a todo card's last open parent makes it ready, and sends nothing until confirmed", async () => {
    const { user, s, fetch, build } = await openPlanned();
    const sheet = await sheetOf(user, "Build it");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await user.click(await within(links).findByRole("button", { name: "Remove Fetch the data" }));
    const confirm = within(links).getByRole("group", { name: "Confirm the change" });
    expect(confirm.textContent).toContain("Build it stops waiting on Fetch the data.");
    expect(confirm.textContent).toContain(
      "Build it waits on nothing else after this. Hermes makes it ready at once, and the dispatcher starts it on its next tick, about a minute, if it has a bot or this server sets kanban.default_assignee.",
    );
    expect(s.kanban.writes).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(within(links).queryByText("Fetch the data")).toBeNull());
    expect(s.kanban.writes).toEqual([`DELETE links ${fetch.id} ${build.id}`]);
    await waitFor(() => expect(within(column("ready")).getByText("Build it")).toBeTruthy());
  });

  it("says a blocked card may become ready when it stops waiting, since Hermes may lift a block it made itself", async () => {
    const { user, s } = await openPlanned();
    const parked = s.kanban.add("default", { title: "Parked card", status: "blocked" });
    const gate = s.kanban.add("default", { title: "Gate", status: "todo" });
    s.kanban.links.push({ parent: gate.id, child: parked.id });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const sheet = await sheetOf(user, "Parked card");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await user.click(await within(links).findByRole("button", { name: "Remove Gate" }));
    expect(within(links).getByRole("group", { name: "Confirm the change" }).textContent).toContain(
      "It stays blocked if someone blocked it. If Hermes blocked it itself after failed runs, Hermes may make it ready at once, and the dispatcher may then start it on its next tick.",
    );
    expect(s.kanban.writes).toEqual([]);
  });

  it("sends no bot or model pick when the card's status changed after the preview", async () => {
    const { user, s, build } = await openPlanned();
    const sheet = await sheetOf(user, "Build it");
    const picks = within(sheet).getByRole("region", { name: "Bot and model" });
    const bot = within(picks).getByRole("combobox", { name: "Bot" });
    await waitFor(() => expect(within(bot).getByRole("option", { name: "researcher (claude-sonnet-5-5)" })).toBeTruthy());
    await user.selectOptions(bot, "researcher");
    s.kanban.find(build.id)!.status = "running";
    await user.click(within(picks).getByRole("button", { name: "Save" }));
    expect(await within(picks).findByText("This card changed since the sheet showed it, so nothing was sent. Here it is now.")).toBeTruthy();
    expect(s.kanban.writes).toEqual([]);
  });

  it("doesn't warn when the card still waits on another open card", async () => {
    const { user, s, build } = await openPlanned();
    const other = s.kanban.add("default", { title: "Review the API", status: "todo" });
    s.kanban.links.push({ parent: other.id, child: build.id });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const sheet = await sheetOf(user, "Build it");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await user.click(await within(links).findByRole("button", { name: "Remove Fetch the data" }));
    expect(within(links).getByRole("group", { name: "Confirm the change" }).textContent).not.toMatch(/waits on nothing else/);
  });

  it("sends nothing when another parent finished after the confirm, and shows the warning the owner didn't see", async () => {
    const { user, s, build } = await openPlanned();
    const other = s.kanban.add("default", { title: "Review the API", status: "todo" });
    s.kanban.links.push({ parent: other.id, child: build.id });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const sheet = await sheetOf(user, "Build it");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await user.click(await within(links).findByRole("button", { name: "Remove Fetch the data" }));
    expect(within(links).getByRole("group", { name: "Confirm the change" }).textContent).not.toMatch(/waits on nothing else/);
    s.kanban.find(other.id)!.status = "done";
    await user.click(within(links).getByRole("button", { name: "Remove link" }));
    const again = await within(links).findByRole("group", { name: "Confirm the change" });
    await waitFor(() => expect(again.textContent).toMatch(/waits on nothing else after this/));
    expect(again.textContent).toContain("This changed since you confirmed, so nothing was sent yet.");
    expect(s.kanban.writes).toEqual([]);
  });

  it("says a ready card goes back to todo when it's made to wait, and adds the link from the sheet", async () => {
    const { user, s, fetch } = await openPlanned();
    const notes = s.kanban.boards.default.tasks.find((t) => t.title === "Notes")!;
    const sheet = await sheetOf(user, "Notes");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await waitFor(() => expect(within(links).getByText("Nothing")).toBeTruthy());
    await user.selectOptions(within(links).getByRole("combobox", { name: "Add a card it waits on" }), fetch.id);
    const confirm = within(links).getByRole("group", { name: "Confirm the change" });
    expect(confirm.textContent).toContain("Notes is ready, so it goes back to todo until Fetch the data is done.");
    await user.click(within(confirm).getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(within(links).getByText("Fetch the data")).toBeTruthy());
    expect(s.kanban.writes).toEqual([`POST links {"parent_id":"${fetch.id}","child_id":"${notes.id}"}`]);
    expect(within(links).getByText("Notes went back to todo until Fetch the data is done.")).toBeTruthy();
  });

  it("sends nothing when the card's links changed since the sheet showed them, and shows them as they are", async () => {
    const { user, s, plan, build } = await openPlanned();
    const sheet = await sheetOf(user, "Build it");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await within(links).findByRole("button", { name: "Remove Plan the work" });
    const other = s.kanban.add("default", { title: "Ask legal", status: "todo" });
    s.kanban.links.push({ parent: other.id, child: build.id });
    await user.click(within(links).getByRole("button", { name: "Remove Plan the work" }));
    await user.click(within(links).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(within(links).getByRole("alert").textContent).toMatch(/links changed since the sheet showed them, so nothing was sent/));
    expect(within(links).getByText("Ask legal")).toBeTruthy();
    expect(s.kanban.writes).toEqual([]);
    expect(s.kanban.links.some((l) => l.parent === plan.id)).toBe(true);
  });

  it("keeps the links locked after a lost answer until a read shows the change, and Try again sends nothing twice", async () => {
    const { user, s, plan, build } = await openPlanned();
    const sheet = await sheetOf(user, "Build it");
    const links = within(sheet).getByRole("region", { name: "Links" });
    await user.click(await within(links).findByRole("button", { name: "Remove Plan the work" }));
    s.kanban.failNext = "lost";
    await user.click(within(links).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(within(links).getByRole("alert").textContent).toMatch(/It may have gone through: Refresh to check, or Try again/));
    expect((within(links).getByRole("button", { name: "Remove Fetch the data" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(links).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(links).getByText("That change is already there.")).toBeTruthy());
    expect(s.kanban.writes).toEqual([`DELETE links ${plan.id} ${build.id}`]);
    expect((within(links).getByRole("button", { name: "Remove Fetch the data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("gives a card that hasn't started a bot and a model, one PATCH each, and shows no pickers on a running card", async () => {
    const { user, s, build } = await openPlanned();
    let sheet = await sheetOf(user, "Build it");
    const picks = within(sheet).getByRole("region", { name: "Bot and model" });
    const bot = within(picks).getByRole("combobox", { name: "Bot" });
    await waitFor(() => expect(within(bot).getByRole("option", { name: "researcher (claude-sonnet-5-5)" })).toBeTruthy());
    await user.selectOptions(bot, "researcher");
    expect(within(picks).getByRole("group", { name: "Confirm the change" }).textContent).toContain("Build it goes to researcher.");
    expect(within(picks).getByRole("group", { name: "Confirm the change" }).textContent).toContain("Once it's ready, the dispatcher starts it on its next tick.");
    // Unassigning never promises that nothing runs it: a server's kanban.default_assignee takes unassigned cards.
    await user.click(within(picks).getByRole("button", { name: "Cancel" }));
    await user.selectOptions(bot, "");
    expect(within(picks).getByRole("group", { name: "Confirm the change" }).textContent).toContain("unless this server sets kanban.default_assignee");
    await user.click(within(picks).getByRole("button", { name: "Cancel" }));
    await user.selectOptions(bot, "researcher");
    await user.click(within(picks).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.find(build.id)!.assignee).toBe("researcher"));
    const model = within(picks).getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(model.matches(":disabled")).toBe(false));
    await user.selectOptions(model, within(model).getByRole("option", { name: "claude-opus-5-5" }));
    expect(within(picks).getByRole("group", { name: "Confirm the change" }).textContent).toContain("Build it runs on claude-opus-5-5 from Anthropic instead of its bot's model.");
    await user.click(within(picks).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.find(build.id)!.model_override).toBe("claude-opus-5-5"));
    await waitFor(() => expect(model.matches(":disabled")).toBe(false));
    await user.selectOptions(model, "");
    await user.click(within(picks).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.find(build.id)!.model_override).toBeNull());
    expect(s.kanban.writes).toEqual([
      `PATCH ${build.id} {"assignee":"researcher"}`,
      `PATCH ${build.id} {"model_override":"claude-opus-5-5","provider_override":"anthropic"}`,
      `PATCH ${build.id} {"clear_model_override":true}`,
    ]);
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    sheet = await sheetOf(user, "Fetch the data");
    await within(sheet).findByText("Comments");
    expect(within(sheet).queryByRole("region", { name: "Bot and model" })).toBeNull();
    expect(within(sheet).getByText("A running card can't be made to wait on another card.")).toBeTruthy();
  });

  it("offers a typed model when Hermes has no model list", async () => {
    const p = planned();
    p.s.kanban.modelOptions = [];
    const { user, s, build } = await openPlanned(p);
    const picks = within(await sheetOf(user, "Build it")).getByRole("region", { name: "Bot and model" });
    const typed = await within(picks).findByRole("textbox", { name: "Model" });
    await user.type(typed, "local/llama");
    await user.click(within(picks).getByRole("button", { name: "Use" }));
    await user.click(within(picks).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.kanban.writes).toEqual([`PATCH ${build.id} {"model_override":"local/llama"}`]));
  });

  it("calls an estimate a token guess, never a cost, and writes nothing", async () => {
    const { user, s } = await openPlanned();
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect((within(dialog).getByRole("button", { name: "Estimate" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Write it up");
    await user.click(within(dialog).getByRole("button", { name: "Estimate" }));
    const guess = await within(dialog).findByText(/^Token guess: about/);
    expect(guess.textContent).toBe("Token guess: about 5,100 tokens, size S");
    const box = guess.closest(".work-estimate")!;
    expect(box.textContent).toContain("A model's rough guess of tokens, not a cost.");
    expect(box.textContent!.replace("not a cost", "")).not.toMatch(/cost|\$|price/i);
    await user.keyboard("{Escape}");
    const sheet = await sheetOf(user, "Build it");
    s.kanban.estimateAnswer = { ok: false, reason: "auxiliary client unavailable" };
    await user.click(within(sheet).getByRole("button", { name: "Estimate" }));
    expect(await within(sheet).findByText("No token guess: auxiliary client unavailable")).toBeTruthy();
    expect(s.kanban.writes).toEqual([]);
  });

  it("says how this server dispatches, for each setting, and never that cards wait for the owner", async () => {
    for (const [settings, says] of [
      [{ auto_decompose: true, auto_promote_children: true }, ["Hermes splits triage cards into linked cards on its own.", "A split's cards that wait on no other open card are made ready at once; the rest wait until those cards are done."]],
      [{ auto_decompose: false, auto_promote_children: false }, ["Triage cards wait until someone moves them.", "A split's cards wait in todo until the dispatcher's next tick, which makes ready those that wait on no open card."]],
    ] as const) {
      const p = planned();
      p.s.kanban.orchestration = { ...settings };
      await openPlanned(p);
      const line = await screen.findByText(says[0], { exact: false });
      for (const said of says) expect(line.textContent).toContain(said);
      expect(line.textContent).toContain("A ready card with a bot starts on the dispatcher's next tick (every 60 s by default) while the server's gateway runs it.");
      expect(line.textContent).not.toMatch(/nothing runs|until you say|until the owner/i);
      expect(line.closest("[title]")!.getAttribute("title")).toMatch(/kanban\.auto_decompose.*kanban\.auto_promote_children/);
      cleanup();
      await Promise.all(running.splice(0).map((h) => h.close()));
    }
  });

  it("hides the dispatch line and the token guess on a plugin without their routes", async () => {
    const p = planned();
    p.s.kanban.without.add("orchestration").add("estimate");
    const { user } = await openPlanned(p);
    await waitFor(() => expect(screen.queryByText(/Dispatch/)).toBeNull());
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Write it up");
    // The first estimate finds the route missing; after that the button is gone.
    if (within(dialog).queryByRole("button", { name: "Estimate" })) await user.click(within(dialog).getByRole("button", { name: "Estimate" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Estimate" })).toBeNull());
  });
});

function atWork() {
  const s = new FakeHermes();
  const k = s.kanban;
  const task = k.add("default", { title: "Research the API", assignee: "researcher", status: "running" });
  k.add("default", { title: "Notes", assignee: "writer", status: "todo" });
  const run = task.current_run_id!;
  const park = `POST ${task.id}/reassign {"profile":"","reclaim_first":true,"reason":"wrong repo"}`;
  const stopped = [park, `PATCH ${task.id} {"status":"blocked","block_reason":"wrong repo"}`, `POST ${task.id}/comments {"body":"BLOCKED: wrong repo"}`, `PATCH ${task.id} {"assignee":"researcher"}`];
  return { s, k, task, run, park, stopped };
}

async function fastPage(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Work api={hermes.kanban} connected onClose={() => {}} pollMs={30} watchMs={30} />);
  await screen.findByText("Dispatch");
  return userEvent.setup();
}

async function runOf(user: ReturnType<typeof userEvent.setup>, title: string) {
  const sheet = await sheetOf(user, title);
  return { sheet, run: await within(sheet).findByRole("region", { name: "Bot run" }) };
}

async function confirmStop(user: ReturnType<typeof userEvent.setup>, run: HTMLElement) {
  await user.click(within(run).getByRole("button", { name: "Stop…" }));
  const confirm = within(run).getByRole("group", { name: "Confirm the change" });
  await user.type(within(confirm).getByRole("textbox", { name: "Why stop it?" }), "wrong repo");
  return confirm;
}

describe("a running card's bot (issue #604)", () => {
  it("shows the run and its chat's tokens growing while the sheet is open, with the board still read, and reads nothing once it closes", async () => {
    const { s, k, task, run: id } = atWork();
    const user = await fastPage(s);
    const { sheet, run } = await runOf(user, "Research the API");
    expect(within(run).getByRole("heading", { name: "Bot at work" })).toBeTruthy();
    await waitFor(() => expect(run.textContent).toContain("Tokens so far: 0 in · 0 out · 1 message"));
    expect(run.textContent).toContain(`Run ${id} · researcher · started just now · no heartbeat yet`);
    k.work(task.id, "Reading the RFC");
    await waitFor(() => expect(run.textContent).toContain("Tokens so far: 1,000 in · 50 out · 2 messages"));
    expect(run.textContent).toContain("heartbeat just now");
    k.work(task.id, "Writing the notes");
    await waitFor(() => expect(run.textContent).toContain("Tokens so far: 2,000 in · 100 out · 3 messages"));
    expect([...within(run).getByRole("list", { name: "Latest in its chat" }).children].map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Asked# Kanban task /),
      "BotReading the RFC",
      "BotWriting the notes",
    ]);
    const reads = (path: (p: string) => boolean) => s.restRequests.filter((r) => path(r.path)).length;
    const board = (p: string) => p === "/api/plugins/kanban/board";
    const watched = (p: string) => p === `/api/plugins/kanban/tasks/${task.id}` || p.startsWith("/api/sessions/local-kanban-");
    const boardReads = reads(board);
    await waitFor(() => expect(reads(board)).toBeGreaterThan(boardReads + 2));
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 150));
    const after = reads(watched);
    await new Promise((r) => setTimeout(r, 200));
    expect(reads(watched)).toBe(after);
    expect(k.writes).toEqual([]);
  });

  it("stops a bot for good only after asking why and saying what Hermes does, and leaves the card blocked with its bot", async () => {
    const { s, k, run: id, stopped } = atWork();
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    await user.click(within(run).getByRole("button", { name: "Stop…" }));
    const confirm = within(run).getByRole("group", { name: "Confirm the change" });
    expect(confirm.textContent).toContain(`researcher stops working on Research the API (run ${id}), and the card is blocked with your reason, so the dispatcher doesn't start it again.`);
    expect(confirm.textContent).toContain("The app takes the card from researcher, which stops the run, then blocks the card, then gives it back to researcher.");
    expect(confirm.textContent).toContain("This server sets no kanban.default_assignee, so nothing starts the card between those steps.");
    expect(confirm.textContent).toContain("If this run was a review, the card goes back to Review with no bot instead, and isn't blocked");
    expect((within(confirm).getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(confirm).getByRole("textbox", { name: "Why stop it?" }), "wrong repo");
    expect(k.writes).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(column("blocked")).getByText("wrong repo")).toBeTruthy());
    expect(k.writes).toEqual(stopped);
    await waitFor(() => expect(run.textContent).toContain(`Run ${id} stopped, and the card is blocked.`));
    expect(within(run).getByRole("heading", { name: "Last run" })).toBeTruthy();
    expect(run.textContent).toContain("(reclaimed)");
    expect(within(run).queryByRole("button", { name: "Stop…" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Research the API" }).contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when the dispatcher starts a run that gets past the block, and that its bot may still be working", async () => {
    const { s, k, task, stopped } = atWork();
    k.defaultAssignee = "writer";
    k.before = (w) => {
      if (w === stopped[1]) k.tick();
    };
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    const confirm = await confirmStop(user, run);
    expect(confirm.textContent).toContain("This server gives a card with no bot to writer (kanban.default_assignee), so the dispatcher can start the card between those steps.");
    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    const stray = await waitFor(() => k.find(task.id)!.runs.find((r) => r.profile === "writer")!);
    await waitFor(() =>
      expect(within(run).getByRole("alert").textContent).toBe(
        `The card is blocked, but the dispatcher started run ${stray.id} just before the block landed. Its bot works on to the end of its turn, and Hermes can't stop it now. The card stays blocked.`,
      ),
    );
    expect(run.textContent).toContain(`Run ${stray.id} · writer`);
    expect(run.textContent).toContain("Blocking a card doesn't stop its bot. This run's bot may still be working, to the end of its turn.");
    expect(k.find(task.id)).toMatchObject({ status: "blocked", assignee: "researcher" });
  });

  it("sends nothing when the run ended after the confirm showed, and says the card changed", async () => {
    const { s, k, task } = atWork();
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    await user.click(within(run).getByRole("button", { name: "Reclaim" }));
    const confirm = within(run).getByRole("group", { name: "Confirm the change" });
    expect(confirm.textContent).toContain("The card goes back to ready, or to review if this run was a review.");
    k.move(task.id, "review");
    await user.click(within(confirm).getByRole("button", { name: "Reclaim" }));
    await waitFor(() => expect(within(run).getByRole("alert").textContent).toBe("This card changed since you confirmed, so nothing was sent. Here it is now."));
    expect(k.writes).toEqual([]);
  });

  it("reclaims the run the owner saw with one write, and shows the run the dispatcher starts next", async () => {
    const { s, k, run: id } = atWork();
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    await user.click(within(run).getByRole("button", { name: "Reclaim" }));
    await user.click(within(within(run).getByRole("group", { name: "Confirm the change" })).getByRole("button", { name: "Reclaim" }));
    await waitFor(() => expect(run.textContent).toContain(`Run ${id} stopped. The card is ready, and the dispatcher starts it again on its next tick (every 60 s by default).`));
    expect(k.writes).toEqual([`POST runs/${id}/terminate {"reason":"Reclaimed from Highwing"}`]);
    k.tick();
    await waitFor(() => expect(within(run).getByRole("heading", { name: "Bot at work" })).toBeTruthy());
    expect(run.textContent).toContain(`Run ${id + 1} · researcher`);
  });

  it("gives a running card to another bot, never to none, and settles a lost answer from the next read", async () => {
    const { s, k, task } = atWork();
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    const to = within(run).getByRole("combobox", { name: "Reassign to" });
    await waitFor(() => expect(within(to).getByRole("option", { name: "writer" })).toBeTruthy());
    expect(within(to).getAllByRole("option").map((o) => o.textContent)).toEqual(["Reassign to…", "writer"]);
    await user.selectOptions(to, "writer");
    const confirm = within(run).getByRole("group", { name: "Confirm the change" });
    expect(confirm.textContent).toContain("and the card goes to writer.");
    expect(confirm.textContent).toContain("If this run was a review, the card goes back to Review with writer.");
    k.failNext = "lost";
    await user.click(within(confirm).getByRole("button", { name: "Reassign to writer" }));
    await waitFor(() => expect(run.textContent).toContain("It's writer's. The dispatcher starts it on its next tick (every 60 s by default)."));
    expect(k.writes).toEqual([`POST ${task.id}/reassign {"profile":"writer","reclaim_first":true,"reason":"Reassigned to writer from Highwing"}`]);
    expect(within(run).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("stays locked after a lost answer while the card is only parked, and Try again finishes without parking it twice", async () => {
    const { s, k, park, stopped } = atWork();
    const user = await fastPage(s);
    const { run } = await runOf(user, "Research the API");
    const confirm = await confirmStop(user, run);
    k.failNext = "lost";
    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(run).getByRole("alert").textContent).toMatch(/It may have gone through\. Try again reads the card first, and sends nothing twice\./));
    expect(k.writes).toEqual([park]);
    await waitFor(() => expect(within(column("ready")).getByText("Research the API")).toBeTruthy());
    expect(within(run).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(run).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(column("blocked")).getByText("wrong repo")).toBeTruthy());
    expect(k.writes).toEqual(stopped);
  });

  it("offers a running card no moves, in its sheet or by dragging, and keeps them for a card no bot is on", async () => {
    const { s, k } = atWork();
    const user = await fastPage(s);
    expect(card("Research the API").draggable).toBe(false);
    expect(card("Notes").draggable).toBe(true);
    dragTo(card("Research the API"), column("blocked"));
    dragTo(card("Research the API"), column("done"));
    expect(screen.queryByRole("dialog")).toBeNull();
    const { sheet } = await runOf(user, "Research the API");
    expect(within(sheet).getByText("A bot is working on this card. Stop, Reclaim or Reassign it above.")).toBeTruthy();
    expect(within(sheet).queryByRole("combobox", { name: "Move to" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Block…" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Complete" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    const notes = await sheetOf(user, "Notes");
    expect(within(notes).getByRole("combobox", { name: "Move to" })).toBeTruthy();
    expect(within(notes).queryByRole("region", { name: "Bot run" })).toBeNull();
    expect(k.writes).toEqual([]);
  });

  it("gives the footer its moves back as soon as the sheet's own read shows the bot finished, before the board is read again", async () => {
    const { s, k, task } = atWork();
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Work api={hermes.kanban} connected onClose={() => {}} pollMs={60_000} watchMs={30} />);
    await screen.findByText("Dispatch");
    const user = userEvent.setup();
    const { sheet, run } = await runOf(user, "Research the API");
    expect(within(sheet).queryByRole("combobox", { name: "Move to" })).toBeNull();
    k.move(task.id, "done");
    await waitFor(() => expect(within(run).getByRole("heading", { name: "Last run" })).toBeTruthy());
    expect(within(sheet).getByRole("combobox", { name: "Move to" })).toBeTruthy();
    expect(within(sheet).queryByText(/A bot is working on this card/)).toBeNull();
    expect(within(sheet).getByText("done", { selector: ".work-status" })).toBeTruthy();
  });

  it("completes a card its sheet already shows in Review the way Review is completed, though the board still shows it running", async () => {
    const { s, k, task } = atWork();
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Work api={hermes.kanban} connected onClose={() => {}} pollMs={60_000} watchMs={30} />);
    await screen.findByText("Dispatch");
    const user = userEvent.setup();
    const { sheet } = await runOf(user, "Research the API");
    k.move(task.id, "review");
    await waitFor(() => expect(within(sheet).getByText("review", { selector: ".work-status" })).toBeTruthy());
    expect(within(column("running")).getByText("Research the API")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(k.writes).toEqual([`PATCH ${task.id} {"status":"done"}`]));
    expect(screen.queryByRole("dialog", { name: /Complete|Summary/i })).toBeNull();
  });

  it("hides only Reclaim on a plugin without terminate, and only Stop and Reassign on one without reassign, where blocking says the bot works on", async () => {
    const { s, k } = atWork();
    k.without.add("terminate");
    await signIn(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Work" }));
    await screen.findByText("2 tasks on the current board");
    const { sheet, run } = await runOf(user, "Research the API");
    await user.click(within(run).getByRole("button", { name: "Reclaim" }));
    await user.click(within(within(run).getByRole("group", { name: "Confirm the change" })).getByRole("button", { name: "Reclaim" }));
    await waitFor(() => expect(within(run).queryByRole("button", { name: "Reclaim" })).toBeNull());
    expect(within(run).getByRole("alert")).toBeTruthy();
    expect(within(run).getByRole("button", { name: "Stop…" })).toBeTruthy();
    expect(within(run).getByRole("combobox", { name: "Reassign to" })).toBeTruthy();
    expect(within(sheet).getByText("A bot is working on this card. Stop or Reassign it above.")).toBeTruthy();

    k.without.add("reassign");
    const confirm = await confirmStop(user, run);
    await user.click(within(confirm).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(run).queryByRole("button", { name: "Stop…" })).toBeNull());
    expect(within(run).queryByRole("combobox", { name: "Reassign to" })).toBeNull();
    expect(within(run).getByRole("heading", { name: "Bot at work" })).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Block…" }));
    const ask = await screen.findByRole("dialog", { name: "Block Research the API" });
    expect(ask.textContent).toContain("Blocking doesn't stop its bot, which works on to the end of its turn. The card stays blocked when the bot finishes.");
    expect(k.writes).toEqual([]);
  });
});

describe("the Work page on its own", () => {
  const board: Board = { columns: [{ name: "ready", tasks: [{ id: "t_1", title: "Research", body: "", assignee: "", status: "ready", priority: 0, comments: 0, links: { parents: 0, children: 0 } }] }], assignees: [] };
  const workflow = { columns: [{ key: "ready", label: "Ready", dropTarget: true }], manual: {} };
  const stub = (over: Partial<WorkApi>): WorkApi => ({
    loadBoard: async () => board,
    loadWorkflow: async () => workflow,
    loadTask: async () => ({ task: board.columns[0].tasks[0], comments: [], links: { parents: [], children: [] }, linked: [], runs: [] }),
    createTask: async () => ({}),
    editTask: async () => undefined,
    addComment: async () => {},
    moveTask: async () => undefined,
    setModel: async () => undefined,
    addLink: async () => ({ gated: false }),
    removeLink: async () => true,
    assignees: async () => [],
    profiles: async () => [],
    modelOptions: async () => [],
    orchestration: async () => ({ autoDecompose: true, autoPromoteChildren: true, defaultAssignee: "" }),
    estimate: async () => ({ ok: false, reason: "no" }),
    estimateTask: async () => ({ ok: false, reason: "no" }),
    changeRun: async (order) => ({ outcome: { kind: "done" }, order }),
    runChat: async () => ({ messages: 0, latest: [], readAt: 0 }),
    ...over,
  });

  it("says the plugin is missing even when the workflow's 404 comes back first", async () => {
    const api = stub({
      loadWorkflow: () => Promise.reject(new RestError(404, `{"detail":"Not Found"}`)),
      loadBoard: () => new Promise((_, no) => setTimeout(() => no(new NoKanbanPlugin()), 20)),
    });
    render(<Work api={api} connected onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("note").textContent).toMatch(/no Kanban plugin/));
  });

  it("keeps focus in New task while it asks for a token guess, so Escape still closes it", async () => {
    const user = userEvent.setup();
    let asked = 0;
    render(<Work api={stub({ estimate: () => (asked++, new Promise(() => {})) })} connected onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Write it up");
    await user.click(within(dialog).getByRole("button", { name: "Estimate" }));
    await within(dialog).findByText(/Asking Hermes for a token guess/);
    await user.click(within(dialog).getByRole("button", { name: "Estimate" }));
    expect(asked).toBe(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("doesn't read the board while the task sheet saves an edit", async () => {
    let reads = 0;
    let finish = () => {};
    const api = stub({
      loadBoard: async () => (reads++, board),
      editTask: () => new Promise((done) => (finish = () => done(undefined))),
    });
    const user = userEvent.setup();
    render(<Work api={api} connected onClose={() => {}} pollMs={30} />);
    await user.click(await screen.findByText("Research"));
    const sheet = await screen.findByRole("dialog", { name: "Research" });
    await user.click(within(sheet).getByRole("button", { name: "Edit" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Title" }), " more");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    const during = reads;
    await new Promise((r) => setTimeout(r, 150));
    expect(reads).toBe(during);
    await act(async () => finish());
    await waitFor(() => expect(reads).toBeGreaterThan(during));
  });
});
