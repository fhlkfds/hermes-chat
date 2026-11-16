// @vitest-environment jsdom
// The Run view on screen (issue #602, ADR 0178): Run under a reply opens its steps as a waterfall, from what the app
// heard live or from the stored rows, with every inferred figure marked and each step's arguments and result a click away.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { RunDialog } from "./RunView";
import type { Run } from "../hermes/flightRecorder";

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

const T = 1_700_000_000;

async function launch(more?: (s: FakeHermes) => void) {
  const s = new FakeHermes();
  s.sessions = [row("c1", 0.1, { pinned: true, title: "Disk check", estimated_cost_usd: 0.01, cost_status: "estimated", input_tokens: 0, output_tokens: 0, api_call_count: 0 })];
  s.storeMessage("c1", { role: "user", text: "How full is the NAS?", timestamp: T });
  s.storeMessage("c1", {
    role: "assistant",
    text: "",
    timestamp: T + 2,
    tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: '{"command":"df -h"}' } }],
  });
  s.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", result: '{"output":"","exit_code":1,"error":"df: permission denied"}', timestamp: T + 5 });
  s.storeMessage("c1", { role: "assistant", text: "I couldn't read the disk.", timestamp: T + 6.5 });
  more?.(s);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Disk check/ }));
  await screen.findByText("I couldn't read the disk.");
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user };
}

const lastRun = () => screen.getAllByRole("button", { name: "Run" }).at(-1)!;
const rows = (dialog: HTMLElement) => within(within(dialog).getByRole("list", { name: "Steps" })).getAllByRole("button");
const rowText = (r: HTMLElement) => r.textContent?.trim();

describe("The Run view", () => {
  it("draws a reply this app didn't watch from its stored rows, every length inferred", async () => {
    const { user } = await launch();
    await user.click(lastRun());
    const dialog = await screen.findByRole("dialog", { name: "Run of this reply" });
    await within(dialog).findByText(/Hermes's stored history/);
    expect(rows(dialog).map(rowText)).toEqual(["Model≈2.0 s (inferred)", "terminal≈3.0 s (inferred)", "Model≈1.5 s (inferred)"]);
    expect(dialog.textContent).toContain("Hermes keeps cost per chat, not per step or turn, so a stored run has none.");
    expect(dialog.textContent).toContain("a failed one is judged from its result");

    await user.click(rows(dialog)[1]);
    expect(rows(dialog)[1].getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("Failed, judged from its result: df: permission denied");
    expect(dialog.textContent).toContain('"command": "df -h"');
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws a reply it watched from what it heard, with Hermes's measured tool lengths and the turn's inferred cost", async () => {
    const { s, hermes, user } = await launch();
    await act(async () => void (await hermes.send("c1", "Try again with sudo")));
    await act(async () => {
      await s.toolTurn(s.runtimeIdOf("c1")!, {
        calls: [[{ name: "terminal", args: { command: "sudo df -h" }, result: { output: "92% used", exit_code: 0 }, seconds: 2.5 }]],
        reply: "It's 92% full.",
        modelSeconds: 1,
        tokens: { prompt: 800, output: 40 },
        costUsd: 0.002,
      });
      await hermes.idle();
    });
    await screen.findByText("It's 92% full.");
    await user.click(lastRun());
    const dialog = await screen.findByRole("dialog", { name: "Run of this reply" });
    await within(dialog).findByText(/What this app heard live/);
    const terminal = rows(dialog).find((r) => rowText(r)?.startsWith("terminal"))!;
    expect(rowText(terminal)).toBe("terminal2.5 s");
    expect(dialog.textContent).toContain("≈$0.0040 for the turn");
    expect(dialog.textContent).toContain("Model calls2, from Hermes's counters");
  });

  it("says when the profile's tool progress is off, so a watched run misses ordinary tool steps", async () => {
    const { s, hermes, user } = await launch((s) => (s.toolProgress = { default: "off" }));
    await act(async () => void (await hermes.send("c1", "Again")));
    await act(async () => {
      await s.toolTurn(s.runtimeIdOf("c1")!, { calls: [], reply: "Done.", modelSeconds: 1, tokens: { prompt: 10, output: 2 }, costUsd: 0 });
      await hermes.idle();
    });
    await screen.findByText("Done.");
    await user.click(lastRun());
    const dialog = await screen.findByRole("dialog", { name: "Run of this reply" });
    const note = await within(dialog).findByRole("note");
    expect(note.textContent).toContain("display.tool_progress is off, so Hermes doesn't send ordinary tool steps");
  });

  it("offers Run under the error of a turn that failed with no reply, and draws the steps it took", async () => {
    const { s, hermes, user } = await launch();
    const replyRuns = screen.getAllByRole("button", { name: "Run" }).length;
    await act(async () => void (await hermes.send("c1", "Check the other disk")));
    const runtime = s.runtimeIdOf("c1")!;
    // Every event lands on one clock reading, so the model step before the tool takes no time even on a slow runner.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await act(async () => {
      s.event(runtime, "message.start");
      s.event(runtime, "tool.start", { tool_id: "k2", name: "terminal", args: { command: "df -h /mnt/b" } });
      s.event(runtime, "tool.complete", { tool_id: "k2", name: "terminal", duration_s: 0.4, result: '{"output":"","exit_code":1}' });
      s.event(runtime, "error", { message: "Provider unavailable" });
      await hermes.idle();
    });
    clock.mockRestore();
    const error = (await screen.findByText("Provider unavailable")).closest(".msg.error") as HTMLElement;
    expect(screen.getAllByRole("button", { name: "Run" })).toHaveLength(replyRuns + 1);
    await user.click(within(error).getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog", { name: "Run of this reply" });
    await within(dialog).findByText(/What this app heard live/);
    // Hermes measured the tool; the model step before it took no time here, so it is left out.
    expect(rows(dialog).map(rowText)).toEqual(["terminal400 ms", "Error"]);
  });

  it("marks the time it heard nothing of a turn, a Question asked meanwhile and a tool whose end it never heard", async () => {
    const at = 1_000_000;
    const inferred = (ms: number) => ({ ms, measured: false });
    const run: Run = {
      source: "watched",
      start: at,
      end: at + 9000,
      outcome: "complete",
      steps: [
        { kind: "tool", id: "t0", name: "terminal", callId: "k1", start: at, end: at + 9000, length: inferred(9000), endUnheard: true },
        { kind: "gap", id: "g1", start: at + 1000, end: at + 6000, length: inferred(5000) },
        { kind: "question", id: "q2", what: "clarify", summary: "Which logs?", outcome: "The turn ended", start: at + 6000, end: at + 9000, length: inferred(3000), late: true },
      ],
    };
    const user = userEvent.setup();
    render(<RunDialog api={{ read: async () => ({ run }) }} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Run of this reply" });
    await within(dialog).findByText(/What this app heard live/);
    expect(rows(dialog).map(rowText)).toEqual(["terminal≈9.0 s (inferred)", "Not heard≈5.0 s (inferred)", "Question≈3.0 s (inferred)"]);
    expect(dialog.textContent).toContain("Steps Hermes took while this app couldn't hear it are missing.");
    await user.click(rows(dialog)[1]);
    expect(dialog.textContent).toContain("so it heard nothing of the turn until it reconnected");
    await user.click(rows(dialog)[2]);
    expect(dialog.textContent).toContain("Hermes asked it while this app couldn't hear, so it was asked before this.");
    await user.click(rows(dialog)[0]);
    expect(dialog.textContent).toContain("This app didn't hear it end, so it is drawn until the turn was next heard going on, or to the turn's end.");
  });
});
