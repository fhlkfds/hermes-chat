// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, readRow, row, type TranscriptMessage } from "../hermes/fakeHermes";
import { FakeTray } from "../hermes/fakeTray";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
const closeApp = async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
};
afterEach(async () => {
  await closeApp();
  localStorage.clear();
  document.title = "Highwing";
});

const RUN = "local-run-1";
const RUN_TITLE = "[fixture] Disk check · Nov 16 14:40";
const PREAMBLE = "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user.]";
const REPLY = "Disk check done. Nothing needs cleaning tonight.";
const READ_ONLY = /This chat is a run of a scheduled job, so it's read-only here\. Hermes runs only its job in it and won't take a reply\. Start a new chat to follow up\./;

const runRows = (started: number): TranscriptMessage[] => [
  { role: "user", text: `${PREAMBLE}\n\nCheck the disk usage on the server.`, row_id: 101, timestamp: started },
  {
    role: "assistant",
    text: "Checking the root filesystem first.",
    row_id: 102,
    timestamp: started + 2,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command": "df -h /"}' } }],
  },
  { role: "tool", tool_call_id: "call_1", name: "terminal", result: '{"output": "61% /", "exit_code": 0}', row_id: 103, timestamp: started + 3 },
  { role: "assistant", text: REPLY, row_id: 104, timestamp: started + 5 },
];

function server() {
  const s = new FakeHermes();
  const started = Math.floor(Date.now() / 1000) - 3600;
  s.sessions = [
    readRow("backup", 1, { pinned: true, title: "Nightly backup" }),
    readRow("hook", 2, { source: "webhook", title: "Deploy hook" }),
    row(RUN, 0, { source: "cron", title: RUN_TITLE, preview: PREAMBLE, started_at: started, last_active: started + 60, last_read_at: 0, input_tokens: 800, output_tokens: 50, api_call_count: 2 }),
  ];
  s.transcripts[RUN] = runRows(started);
  s.transcripts.backup = [{ role: "user", text: "Why did the backup fail?", row_id: 1 }, { role: "assistant", text: "The disk was full.", row_id: 2 }];
  s.cron.jobs = { default: [] };
  const job = s.cron.add("default", { name: "[fixture] Disk check", prompt: "Check the disk usage on the server.", schedule: "0 3 * * *" });
  s.cron.runs[job.id] = [{ id: RUN, source: "cron", started_at: started, ended_at: started + 60, end_reason: "cron_complete", profile: "default" }];
  return s;
}

async function launch(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  const tray = new FakeTray();
  render(<Main hermes={hermes} tray={tray} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { s, hermes, tray, user: userEvent.setup() };
}

type App = Awaited<ReturnType<typeof launch>>;
type User = App["user"];

async function openFromHistory({ user, hermes }: App) {
  await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
  await user.click(await screen.findByText("[fixture] Disk check"));
  const history = await screen.findByRole("list", { name: "Run history, newest first" });
  await user.click(within(history).getByRole("button", { name: "Open the chat" }));
  await screen.findByText(REPLY);
  await act(async () => void (await hermes.idle()));
}

const pane = () => document.querySelector<HTMLElement>(".chat")!;
const sidebar = () => document.querySelector<HTMLElement>(".sidebar")!;
const palette = () => screen.getByRole("dialog", { name: "Search chats" });
const hits = () => [...palette().querySelectorAll(".hit-name")].map((e) => e.textContent);
const resumed = (s: FakeHermes) => s.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id);
const touchedRun = (s: FakeHermes) => [
  ...s.restRequests.filter((r) => r.method !== "GET" && r.path.includes(RUN)).map((r) => `${r.method} ${r.path}`),
  ...s.requests.filter((r) => JSON.stringify(r.params).includes(RUN)).map((r) => r.method),
];

function expectReadOnly() {
  expect(within(pane()).getByRole("note").textContent).toMatch(READ_ONLY);
  expect(pane().querySelector("textarea")).toBeNull();
  for (const name of ["Edit", "Regenerate", "Branch from here"]) expect(within(pane()).queryByRole("button", { name })).toBeNull();
}

async function filterBySource(user: User, source: string) {
  if (!screen.queryByRole("dialog", { name: "Search chats" })) {
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("button", { name: "Filters" }));
  }
  await user.selectOptions(screen.getByRole("combobox", { name: /^Source/ }), source);
}

describe("A job run's chat", () => {
  it("opens from the job's history with its prompt, tool step and reply, and is read-only", async () => {
    const app = await launch();
    await openFromHistory(app);
    expect(document.querySelector(".jobs-screen")).toBeNull();
    expect(pane().querySelector(".chat-title")!.textContent).toContain(RUN_TITLE);
    expect(within(pane()).getByText(/Check the disk usage on the server\./)).toBeTruthy();
    expect(pane().textContent).toContain("You are running as a scheduled cron job");
    expect(pane().textContent).toMatch(/terminal/);
    expect(pane().textContent).toContain("df -h /");
    await app.user.click(within(pane()).getByRole("button", { name: /terminal/ }));
    expect(pane().textContent).toContain('"output": "61% /"');
    expect(within(pane()).getByText(REPLY)).toBeTruthy();
    expect(pane().textContent).toContain("A scheduled job ran this chat.");
    expect(pane().textContent).not.toMatch(/Imported from|moves it to Active/);
    expectReadOnly();

    expect(resumed(app.s)).toEqual([]);
    expect(touchedRun(app.s)).toEqual([]);
    expect(app.s.sessions.find((r) => r.id === RUN)!.last_read_at).toBe(0);
  });

  it("offers nothing that would change it: its menu exports, shares and copies its link only", async () => {
    const app = await launch();
    await openFromHistory(app);
    await app.user.click(within(pane()).getByRole("button", { name: "More" }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Export…", "Share snapshot…", "Copy chat link"]);
    expect(within(pane()).getByRole("button", { name: "Find in chat" })).toBeTruthy();
    expect(within(pane()).getByText("Job run")).toBeTruthy();
    expect(within(pane()).queryByText("Settled")).toBeNull();
    expect(within(pane()).queryByRole("button", { name: /Context/ })).toBeNull();
  });

  it("shows a reply's steps in the Run view, read from the run's stored rows", async () => {
    const app = await launch();
    await openFromHistory(app);
    await app.user.click(within(pane()).getAllByRole("button", { name: "Run" }).at(-1)!);
    const run = await screen.findByRole("dialog");
    await within(run).findByText(/terminal/);
    expect(run.textContent).not.toContain("No steps to show.");
    expect(resumed(app.s)).toEqual([]);
    expect(touchedRun(app.s)).toEqual([]);
  });

  it("opens its job from the note", async () => {
    const app = await launch();
    await openFromHistory(app);
    await app.user.click(within(pane()).getByRole("button", { name: "Open the job" }));
    expect(await screen.findByRole("heading", { name: "[fixture] Disk check" })).toBeTruthy();
    expect(document.querySelector(".jobs-screen")).toBeTruthy();
  });

  it("keeps Show the result beside Open the chat, and offers neither for a script's output", async () => {
    const app = await launch();
    const id = app.s.cron.jobs.default[0].id;
    app.s.cron.runs[id].push({ id: "cron_output:x:1", title: "OK · done", source: "cron_output", started_at: Math.floor(Date.now() / 1000) - 7200 });
    await app.user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await app.user.click(await screen.findByText("[fixture] Disk check"));
    const [agent, script] = within(await screen.findByRole("list", { name: "Run history, newest first" })).getAllByRole("listitem");
    expect(within(agent).getByRole("button", { name: "Show the result" })).toBeTruthy();
    expect(within(agent).getByRole("button", { name: "Open the chat" })).toBeTruthy();
    expect(within(script).queryByRole("button", { name: "Open the chat" })).toBeNull();
  });
});

describe("Job runs and the chat list", () => {
  const inboxRows = () => [...screen.getByRole("dialog", { name: /Inbox/ }).querySelectorAll(".inbox-open")].map((r) => r.getAttribute("aria-label"));

  it("leaves a run the server marks unread out of the list, the unread count and the Inbox, before and after it is opened", async () => {
    const app = await launch();
    await act(async () => void (await app.hermes.checkOtherProfiles()));
    const absent = () => {
      expect(within(sidebar()).queryByText(RUN_TITLE)).toBeNull();
      expect(within(sidebar()).getByText("Nightly backup")).toBeTruthy();
      expect(document.title).not.toMatch(/^\(\d+\)/);
      expect(app.tray.counts.at(-1) ?? 0).toBe(0);
    };
    absent();

    await openFromHistory(app);
    await app.user.click(within(sidebar()).getByText("Nightly backup"));
    await screen.findByText("The disk was full.");
    await act(async () => {
      await app.hermes.sync();
      await app.hermes.idle();
    });
    absent();
    act(() => app.tray.pick("inbox"));
    expect(inboxRows()).toEqual([]);
    expect(touchedRun(app.s)).toEqual([]);
    expect(app.s.sessions.find((r) => r.id === RUN)!.last_read_at).toBe(0);
  });
});

describe("Finding job runs", () => {
  it("lists them under the Scheduled jobs source only, and opens one read-only", async () => {
    const app = await launch();
    await filterBySource(app.user, "Scheduled jobs");
    await waitFor(() => expect(hits()).toEqual([RUN_TITLE]));
    expect([...palette().querySelectorAll(".hit-row .badge")].map((e) => e.textContent)).toEqual(["Job run"]);
    const asked = app.s.restRequests.filter((r) => r.path === "/api/sessions" && r.query.get("sources")).at(-1)!;
    expect(asked.query.get("sources")).toBe("cron");
    expect(asked.query.has("exclude_sources")).toBe(false);
    expect(within(palette()).getByRole("button", { name: "Remove filter Source: Scheduled jobs" })).toBeTruthy();

    await filterBySource(app.user, "Other platforms");
    await waitFor(() => expect(hits()).toEqual(["Deploy hook"]));

    await filterBySource(app.user, "Scheduled jobs");
    await waitFor(() => expect(hits()).toEqual([RUN_TITLE]));
    await app.user.click(within(palette()).getByText(RUN_TITLE));
    await screen.findByText(REPLY);
    await act(async () => void (await app.hermes.idle()));
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    expectReadOnly();
    expect(resumed(app.s)).toEqual([]);
    expect(touchedRun(app.s)).toEqual([]);
  });

  it("keeps a Saved filter on Scheduled jobs through a restart", async () => {
    const s = server();
    const first = await launch(s);
    await filterBySource(first.user, "Scheduled jobs");
    await waitFor(() => expect(hits()).toEqual([RUN_TITLE]));
    await first.user.click(screen.getByRole("button", { name: "Save filter…" }));
    await first.user.type(screen.getByRole("textbox", { name: "Name this filter" }), "Job runs{Enter}");
    expect(within(palette()).getByRole("status").textContent).toContain('Saved as "Job runs"');
    await closeApp();

    const again = await launch(s);
    await again.user.click(within(screen.getByRole("navigation", { name: "Saved filters" })).getByRole("button", { name: "Job runs" }));
    await waitFor(() => expect(hits()).toEqual([RUN_TITLE]));
    expect(within(palette()).getByRole("button", { name: "Remove filter Source: Scheduled jobs" })).toBeTruthy();
  });

  it("opens a scheduled job's session from the Usage screen read-only, not as a chat to reply in", async () => {
    const app = await launch();
    await app.user.click(screen.getByRole("button", { name: "Usage" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Read /));
    await app.user.click(screen.getByRole("button", { name: "Where it started" }));
    await app.user.click(screen.getByRole("button", { name: /^Scheduled jobs: show its 1 chats/ }));
    await app.user.click(screen.getByRole("button", { name: RUN_TITLE }));
    await waitFor(() => expect(document.querySelector(".usage-screen")).toBeNull());
    await screen.findByText(REPLY);
    await act(async () => void (await app.hermes.idle()));
    expectReadOnly();
    expect(within(pane()).getByRole("button", { name: "Open the job" })).toBeTruthy();
    expect(resumed(app.s)).toEqual([]);
    expect(touchedRun(app.s)).toEqual([]);
  });
});
