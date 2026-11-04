// @vitest-environment jsdom
// The Logs screen (Logs.tsx, ADR 0033): following and pausing a Hermes log, filters, an unreadable source, the support
// bundle, and opening it from the rail against a fake Hermes whose `GET /api/logs` answers as `bf0203a` does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { LogBuffer, note, type RemoteLog } from "../hermes/logs";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { LogsScreen } from "./Logs";

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

/** The profile's log files, as Hermes would read their tails. */
function logs() {
  const files: Record<string, string[]> = { agent: [], errors: [], gateway: [], mcp: [] };
  const write = (file: string, ...lines: string[]) => files[file].push(...lines.map((l) => l + "\n"));
  const read = vi.fn(async (file: RemoteLog, lines: number) => ({ file, lines: files[file].slice(-Math.min(lines, 500)) }));
  return { files, write, read };
}

function screenWith(l = logs(), more: Partial<Parameters<typeof LogsScreen>[0]> = {}) {
  const save = vi.fn(async (_text: string, _name: string) => "/home/me/hermes-logs.txt" as string | null);
  const app = new LogBuffer(100);
  const props = { profile: "default", connected: true, connection: "SSH tunnel", read: l.read, save, onClose: () => {}, app, pollMs: 30, ...more };
  const r = render(<LogsScreen {...props} />);
  return { ...l, save, app, props, ...r };
}

const rows = () => [...screen.getByRole("log").querySelectorAll(".log-text")].map((e) => e.textContent);

describe("Logs screen", () => {
  it("follows the agent log, keeps the reading place while paused, and follows new lines again", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one", "2026-11-04 10:00:00,001 INFO agent: two");
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: one", "2026-11-04 10:00:00,001 INFO agent: two"]));
    expect(t.read).toHaveBeenCalledWith("agent", 500);

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    t.write("agent", "2026-11-04 10:00:01,000 WARNING agent: three");
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow (1 new)" })).toBeTruthy());
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/Paused: the lines stay where they are/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Follow (1 new)" }));
    expect(rows().at(-1)).toBe("2026-11-04 10:00:01,000 WARNING agent: three");
  });

  it("pauses when the owner scrolls up or clicks in the list", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const list = screen.getByRole("log");
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy());
  });

  it("filters by level and text, and shows lines as plain text", async () => {
    const t = screenWith();
    t.write(
      "agent",
      "2026-11-04 10:00:00,000 INFO agent: started <img src=x onerror=alert(1)>",
      "2026-11-04 10:00:01,000 ERROR tools.web: request failed",
      "Traceback (most recent call last):",
      "2026-11-04 10:00:02,000 WARNING gateway: slow",
    );
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(screen.getByRole("log").querySelector("img")).toBeNull();
    expect(rows()[0]).toContain("<img src=x onerror=alert(1)>");

    await userEvent.selectOptions(screen.getByLabelText("Level"), "ERROR");
    expect(rows()).toEqual(["2026-11-04 10:00:01,000 ERROR tools.web: request failed", "Traceback (most recent call last):"]);
    await userEvent.selectOptions(screen.getByLabelText("Level"), "");
    await userEvent.type(screen.getByLabelText("Containing"), "GATEWAY");
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:02,000 WARNING gateway: slow"]));
    expect(screen.getByText(/4 lines kept, 1 shown/)).toBeTruthy();
  });

  it("says when this Hermes can't give a log, and stops asking", async () => {
    const l = logs();
    l.read.mockRejectedValue(new Error(`The dashboard answered 404: {"detail":"Not Found"}`));
    screenWith(l);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/This Hermes has no \/api\/logs route/));
    const calls = l.read.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(l.read.mock.calls.length).toBe(calls);
  });

  it("says why a read failed, and notes the gap once reading works again", async () => {
    const l = logs();
    l.write("agent", "2026-11-04 10:00:00,000 INFO agent: before");
    const t = screenWith(l);
    await waitFor(() => expect(rows()).toHaveLength(1));
    t.rerender(<LogsScreen {...t.props} connected={false} />);
    expect(screen.getByText(/Not connected to Hermes\. Reading starts again/)).toBeTruthy();
    l.write("agent", "2026-11-04 10:00:05,000 INFO agent: during");
    t.rerender(<LogsScreen {...t.props} connected />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[1]).toMatch(/^Not read from .*: the connection to Hermes was lost$/);
    expect(rows()[2]).toBe("2026-11-04 10:00:05,000 INFO agent: during");

    l.read.mockRejectedValue(new Error(`The dashboard answered 500: {"detail":"[Errno 13] Permission denied: 'agent.log'"}`));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't read the Hermes agent log: \[Errno 13\] Permission denied/));
  });

  it("shows this app's diagnostics, and a support bundle that says what it holds and what was redacted", async () => {
    const l = logs();
    l.write("agent", "2026-11-04 10:00:00,000 INFO agent: key sk-proj-AbCdEfGhIjKlMnOpQrStUv loaded");
    const t = screenWith(l);
    note("WARNING", "Connection to ssh://me@box: Offline (Cookie: session=abc123)", t.app);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "app");
    await waitFor(() => expect(rows()).toEqual(["Connection to ssh://me@box: Offline (Cookie: [redacted]"]));

    await userEvent.click(screen.getByRole("button", { name: /Support bundle/ }));
    const dialog = screen.getByRole("dialog", { name: "Support bundle" });
    expect(within(dialog).getByLabelText(/This app: 1 line/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Hermes agent \(agent\.log\): 1 line/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/Redacted: 1 cookie, 1 provider key\./);
    expect(dialog.textContent).toMatch(/can still be there: read the file before sharing it/);
    const preview = within(dialog).getByLabelText("The file's text").textContent!;
    expect(preview).not.toMatch(/abc123|AbCdEfGhIjKlMnOpQrStUv/);

    await userEvent.click(within(dialog).getByLabelText(/This app/));
    expect(within(dialog).getByLabelText("The file's text").textContent).not.toContain("===== This app =====");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    expect(t.save).toHaveBeenCalledTimes(1);
    const [text, name] = t.save.mock.calls[0];
    expect(name).toMatch(/^hermes-chat-support-\d{8}-\d{6}\.txt$/);
    expect(text).toContain("===== Hermes agent (agent.log) =====");
    expect(text).toContain("key [redacted key] loaded");
    expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUv");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the bundle to the moment it opened, while lines keep coming", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /Support bundle/ }));
    const dialog = screen.getByRole("dialog", { name: "Support bundle" });
    t.write("agent", "2026-11-04 10:00:01,000 INFO agent: two api_key=k2");
    await waitFor(() => expect(t.read.mock.calls.length).toBeGreaterThan(3));
    await new Promise((r) => setTimeout(r, 150));
    expect(within(dialog).getByLabelText(/Hermes agent \(agent\.log\): 1 line/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/Redacted: nothing recognized as a secret\./);
    await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    const [text] = t.save.mock.calls[0];
    expect(text).toContain("agent: one");
    expect(text).not.toContain("agent: two");
    expect(text).toContain(within(dialog).getByLabelText("The file's text").textContent!.split("\n")[6]);
  });

  it("exports what's shown", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: a", "2026-11-04 10:00:00,000 ERROR agent: b");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Level"), "ERROR");
    await userEvent.click(screen.getByRole("button", { name: /Export shown/ }));
    const [text, name] = t.save.mock.calls[0];
    expect(name).toMatch(/^hermes-agent-log-/);
    expect(text).toMatch(/Shown: ERROR and above\./);
    expect(text).toMatch(/\] 2026-11-04 10:00:00,000 ERROR agent: b\n$/);
    expect(text).not.toContain("INFO agent: a");
    expect(screen.getByText("Saved to /home/me/hermes-logs.txt.")).toBeTruthy();
  });
});

describe("Logs from the rail", () => {
  it("opens over the chat and reads the shown profile's agent log", async () => {
    const s = new FakeHermes();
    s.rest["GET /api/logs"] = (req) => ({ file: req.query.get("file"), lines: [`2026-11-04 10:00:00,000 INFO agent: hello from ${req.query.get("profile")}\n`] });
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    await userEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByRole("heading", { name: "Logs" })).toBeTruthy();
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: hello from default"]));
    const asked = s.restRequests.find((r) => r.path === "/api/logs")!;
    expect(Object.fromEntries(asked.query)).toEqual({ file: "agent", lines: "500", profile: "default" });
    await userEvent.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.queryByRole("heading", { name: "Logs" })).toBeNull();
  });
});
