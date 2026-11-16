// @vitest-environment jsdom
// The Run view on screen (issue #602, ADR 0178): Run under a reply opens its steps as a waterfall, from what the app
// heard live or from the stored rows, with every inferred figure marked and each step's arguments and result a click away.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

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
});
