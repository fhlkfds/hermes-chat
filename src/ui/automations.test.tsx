// @vitest-environment jsdom
// The Automations screen in the app, against a fake Hermes whose `/api/webhooks*` routes behave as the reference
// `webhooks/1` implementation (and as the deployed `bf0203a` where `contract` is off). Routes and events are fixtures.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
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

function server(contract = true) {
  const s = new FakeHermes();
  s.sessions = [row("hook-chat", 0, { source: "webhook", title: "Triage issue 42" }), row("plain", 1)];
  s.webhooks.contract = contract;
  s.webhooks.add("default", "triage", { events: ["issues"], prompt: "Triage #{issue.number}", provider: "github" });
  return s;
}

async function launch(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Automations" }));
  await waitFor(() => expect(document.querySelector(".automations-screen")?.textContent).not.toMatch(/Loading the automations/));
  return { hermes, user, s };
}

const writes = (s: FakeHermes) => s.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/webhooks"));

describe("the Automations screen", () => {
  it("lists the profile's automations, and refused requests on the row", async () => {
    const s = server();
    s.webhooks.rejections = { default: { triage: { bad_signature: { count: 3, last_at: 1793721517 } } } };
    await launch(s);
    expect(screen.getByRole("heading", { name: "Automations" })).toBeTruthy();
    const r = screen.getByText("triage").closest("button")!;
    expect(within(r).getByText(/GitHub: issues/)).toBeTruthy();
    expect(within(r).getByText(/Refused: 3 bad or missing signature/)).toBeTruthy();
  });

  it("previews an example event and the rendered task, escaping its text, before creating the automation paused", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: /New automation/ }));
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "triage-bugs");
    const prompt = screen.getByRole("textbox", { name: /Prompt template/ });
    await user.clear(prompt);
    await user.type(prompt, "Look at {{issue.title} by {{issue.user.login}");
    // The example issue's title is shown as text, never as markup.
    const rendered = document.querySelector(".automation-rendered")!;
    expect(rendered.textContent).toBe("Look at [fixture] Crash when the list is empty by octo-fixture");
    expect(screen.getByText(/Hermes would start a task with this prompt/)).toBeTruthy();
    // A filter that this event fails: the preview says so.
    await user.click(screen.getByRole("button", { name: /Add a filter/ }));
    await user.type(screen.getByRole("combobox", { name: "Filter 1 field" }), "action");
    await user.type(screen.getByRole("textbox", { name: "Filter 1 value" }), "closed");
    expect(screen.getByText(/would record it as filtered out/)).toBeTruthy();
    expect(document.querySelector(".automation-rendered")).toBeNull();
    // The comment example carries markup: it stays text.
    await user.clear(screen.getByRole("textbox", { name: "Filter 1 value" }));
    await user.type(screen.getByRole("textbox", { name: "Filter 1 value" }), "created");
    await user.click(screen.getByRole("checkbox", { name: /issue_comment/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Example event" }), "issue_comment");
    await user.clear(prompt);
    await user.type(prompt, "{{comment.body}");
    expect(document.querySelector(".automation-rendered")!.innerHTML).toContain("&lt;script&gt;");
    await user.click(screen.getByRole("button", { name: "Create paused" }));
    await waitFor(() => expect(screen.getByRole("alert", { name: /new secret/ })).toBeTruthy());
    expect(writes(s)[0].body).toMatchObject({ name: "triage-bugs", enabled: false, create_only: true, events: ["issues", "issue_comment"], filters: [{ field: "action", equals: "created" }] });
    expect(s.webhooks.routes.default["triage-bugs"].enabled).toBe(false);
    // The secret is shown once, in this screen only, and nothing keeps it.
    const secret = s.webhooks.routes.default["triage-bugs"].secret as string;
    expect(screen.getByText(secret)).toBeTruthy();
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    await user.click(screen.getByRole("button", { name: /I've put it in GitHub/ }));
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("shows the delivery history with states, a link to the task's chat, and a retry that asks first", async () => {
    const s = server();
    s.webhooks.addDelivery("default", "triage", { delivery_id: "d-filtered", state: "filtered", reason: "event:push", event: "push", action: null });
    s.webhooks.addDelivery("default", "triage", { delivery_id: "d-done", state: "completed", session_id: "hook-chat", excerpt: { "repository.full_name": "example/fixture", "issue.number": 41, "issue.title": "Done one" } });
    s.webhooks.addDelivery("default", "triage", { delivery_id: "d-failed", state: "failed", outcome: "failed", session_id: "hook-chat", retryable: true, retry_needs_confirmation: true, duplicates: 2 });
    const { user } = await launch(s);
    await user.click(screen.getByText("triage").closest("button")!);
    await waitFor(() => expect(screen.getByText("d-failed")).toBeTruthy());
    expect(screen.getByText("Filtered out")).toBeTruthy();
    expect(screen.getByText(/doesn't take/)).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText(/2 more copies of it arrived/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(screen.getByRole("alertdialog", { name: /Run this event again/ })).toBeTruthy();
    expect(s.webhooks.retries).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Run it again" }));
    await waitFor(() => expect(s.webhooks.retries).toHaveLength(1));
    expect(s.webhooks.retries[0]).toMatchObject({ deliveryId: "d-failed", confirmed: true });
    await waitFor(() => expect(screen.getByText(/Hermes took the retry/)).toBeTruthy());
    // Open its chat leaves the screen for the chat.
    await user.click(screen.getAllByRole("button", { name: "Open its chat" })[0]);
    await waitFor(() => expect(document.querySelector(".automations-screen")).toBeNull());
  });

  it("an edit keeps filters it can't show as rows exactly, and drops a custom event the owner removed", async () => {
    const s = server();
    const kept = [{ field: "action", exists: false }, { field: "issue.labels", contains: { name: "bug" } }, { field: "x", in: ["foo,bar"] }, { field: "action", regex: "(?P<verb>opened)" }];
    s.webhooks.add("default", "custom", { events: ["issues", "discussion"], prompt: "p", provider: "github", filters: [...kept, { field: "action", equals: "opened" }] });
    const { user } = await launch(s);
    await user.click(screen.getByText("custom").closest("button")!);
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.clear(screen.getByRole("textbox", { name: /Other GitHub event names/ }));
    await user.type(screen.getByRole("textbox", { name: /Prompt template/ }), " more");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.webhooks.routes.default.custom.prompt).toBe("p more"));
    expect(s.webhooks.routes.default.custom.events).toEqual(["issues"]);
    expect(s.webhooks.routes.default.custom.filters).toEqual([{ field: "action", equals: "opened" }, ...kept]);
  });

  it("pauses an automation, read back from Hermes", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("triage").closest("button")!);
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(screen.getAllByText("Paused").length).toBeGreaterThan(0));
    expect(s.webhooks.routes.default.triage.enabled).toBe(false);
  });

  it("on a stock server, says what it can't do, lists the route's tasks, and asks before an edit makes a new secret", async () => {
    const s = server(false);
    const chat = `webhook:v2:${btoa(JSON.stringify(["default", "triage", "d-1"])).replace(/=+$/, "")}`;
    s.sessions = [row("hook-chat", 0, { source: "webhook", title: null, chat_id: chat, user_id: "webhook:triage", ended_at: Date.now() / 1000, message_count: 1 }), row("plain", 1)];
    const { user } = await launch(s);
    expect(screen.getByText(/keeps no record of deliveries/)).toBeTruthy();
    await user.click(screen.getByText("triage").closest("button")!);
    await waitFor(() => expect(screen.getByText("Ended without a reply")).toBeTruthy());
    expect(screen.getByText("d-1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/Confirm the new secret below/)).toBeTruthy();
    expect(writes(s)).toEqual([]);
    await user.click(screen.getByRole("checkbox", { name: /only replace an automation/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert", { name: /new secret/ })).toBeTruthy());
    expect(writes(s).map((w) => `${w.method} ${w.path}`)).toEqual(["POST /api/webhooks"]);
  });

  it("keeps the last read while disconnected and doesn't offer changes", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("triage").closest("button")!);
    await act(async () => s.drop());
    await waitFor(() => expect(screen.getByText(/Not connected to Hermes/)).toBeTruthy());
    expect((screen.getByRole("button", { name: /Pause/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
