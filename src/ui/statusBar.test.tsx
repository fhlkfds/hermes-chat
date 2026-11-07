// @vitest-environment jsdom
// The status bar: what it shows is kept, and the context meter reads Hermes's own usage frames. Driven against a fake
// Hermes speaking the deployed wire shapes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { UI_PREFS_KEY, getUIPrefs } from "../hermes/uiPrefs";
import { StatusBar, StatusBarSetting } from "./StatusBar";

const ALL = ["context", "model", "status"];
const kept = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY)!);

/** A `session.usage` event payload as the deployed `_start_usage_ticker` sends it (`server._get_usage`). */
const USAGE_TICK = {
  usage: {
    model: "claude-opus-5-5",
    input: 41_000,
    output: 1_200,
    total: 42_200,
    calls: 3,
    context_used: 46_000,
    context_max: 200_000,
    context_percent: 23,
    context_source: "provider_usage",
    context_estimated: false,
  },
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A new chat started on a fake Hermes, its bar on screen and kept up to date. */
async function barFor(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const bar = () => (
    <StatusBar
      chat={chat()}
      status={hermes.getSnapshot().status}
      context={{ inspect: () => hermes.inspectContext(id), history: () => hermes.compactionHistory(id), compact: () => hermes.compact(id), cannotCompact: () => hermes.cannotCompact() }}
    />
  );
  const view = render(bar());
  hermes.subscribe(() => view.rerender(bar()));
  return { server, hermes, id, runtime: server.runtimeIdOf(id)!, chat };
}

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

describe("What the status bar shows", () => {
  it("keeps the items picked from its right-click menu in the display preferences, beside the others", async () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, theme: "dark" }));
    await barFor();
    expect(screen.getByText("Connected")).toBeTruthy();

    fireEvent.contextMenu(screen.getByRole("contentinfo", { name: "Status bar" }));
    const connection = screen.getByRole("menuitemcheckbox", { name: "Connection" });
    expect(connection.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(connection);

    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: "Connection" }).getAttribute("aria-checked")).toBe("false");
    expect(kept()).toMatchObject({ theme: "dark", statusBar: ["context", "model"] });
    // Ticking it again puts it back in its place.
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Connection" }));
    expect(kept().statusBar).toEqual(ALL);
  });

  it("hides the whole bar from its menu, and Settings shows it again with every item", async () => {
    await barFor();
    fireEvent.contextMenu(screen.getByRole("contentinfo", { name: "Status bar" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide bar" }));
    expect(screen.queryByRole("contentinfo", { name: "Status bar" })).toBeNull();
    expect(kept().statusBar).toEqual([]);

    render(<StatusBarSetting />);
    const setting = screen.getByRole("switch", { name: "Status bar" });
    expect(setting.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(setting);
    expect(screen.getByRole("contentinfo", { name: "Status bar" })).toBeTruthy();
    expect(getUIPrefs().statusBar).toEqual(ALL);
  });

  it("shows every item until the owner picks, and skips ids it doesn't know", async () => {
    expect(getUIPrefs().statusBar).toEqual(ALL);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, statusBar: ["weather", "status"] }));
    await barFor();
    fireEvent.contextMenu(screen.getByRole("contentinfo", { name: "Status bar" }));
    expect(screen.getAllByRole("menuitemcheckbox").filter((i) => i.getAttribute("aria-checked") === "true").map((i) => i.textContent)).toEqual(["Connection"]);
  });

  it("has no YOLO item since the approval mode moved to the composer, and a bar saved with one still shows (ADR 0091)", async () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, statusBar: ["context", "yolo", "status"] }));
    await barFor();
    expect(screen.getByText("Context not measured")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText(/YOLO/)).toBeNull();
    fireEvent.contextMenu(screen.getByRole("contentinfo", { name: "Status bar" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((i) => i.textContent)).toEqual(["Context", "Model", "Connection"]);
  });
});

describe("Context meter", () => {
  it("shows how full the context is once Hermes measures it, and the model", async () => {
    const { server, runtime, chat } = await barFor();
    // Before the first API call Hermes has no measure, and the bar makes none up: it says so, and still opens the inspector.
    expect(screen.queryByText(/% full/)).toBeNull();
    expect(screen.getByRole("button", { name: "Context not measured" })).toBeTruthy();

    act(() => server.event(runtime, "session.usage", USAGE_TICK));
    expect(chat().live?.context).toEqual({ used: 46_000, max: 200_000, percent: 23, estimated: false });
    expect(screen.getByText("23% full")).toBeTruthy();
    act(() => server.event(runtime, "session.info", { model: "claude-opus-5-5", provider: "anthropic" }));
    expect(screen.getByText("claude-opus-5-5")).toBeTruthy();
    // session.info without usage leaves the meter as it was.
    expect(screen.getByText("23% full")).toBeTruthy();

    // The turn's last word on usage replaces the ticks.
    act(() => server.event(runtime, "message.complete", { text: "Done", usage: { ...USAGE_TICK.usage, context_used: 182_000, context_percent: 91, context_estimated: true } }));
    expect(screen.getByText("91% full").closest("button")!.className).toContain("full");
    // A usage frame without a measure clears it rather than keeping an old number.
    act(() => server.event(runtime, "session.usage", { usage: { model: "claude-opus-5-5", calls: 0 } }));
    expect(screen.queryByText(/% full/)).toBeNull();
  });

  it("opens the context inspector, which asks Hermes for the breakdown (contextInspector.test.tsx)", async () => {
    const { server, hermes, runtime } = await barFor();
    act(() => server.event(runtime, "session.usage", USAGE_TICK));
    await userEvent.click(screen.getByText("23% full"));
    await settle(hermes);
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeTruthy();
    expect(server.last("session.context_breakdown")!.params).toEqual({ session_id: runtime });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("A chat's live session", () => {
  it("comes from session.resume when a chat is reopened, and is forgotten when the connection drops", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 1)];
    server.sessionInfo = { model: "m", yolo: true, approval_mode: "manual", usage: USAGE_TICK.usage };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    await hermes.open("nas");
    const nas = () => hermes.getSnapshot().chats.find((c) => c.id === "nas")!;
    expect(nas().live).toEqual({ approvals: { mode: "manual", yolo: true }, context: { used: 46_000, max: 200_000, percent: 23, estimated: false } });
    expect(nas().model?.model).toBe("m");

    server.drop();
    expect(nas().live).toBeUndefined();
  });
});
