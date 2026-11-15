// @vitest-environment jsdom
// The Run view (RunView.tsx, ADR 0177): opened from a turn's last reply, it draws the steps and shows one's details.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Item } from "../hermes/model";
import type { RunView } from "../hermes/runs";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";
import { ChatPane } from "./ChatPane";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const items: Item[] = [
  { kind: "user", id: "h-0", text: "What's in the folder?" },
  { kind: "assistant", id: "h-1", text: "Looking first." },
  { kind: "tool", id: "h-2", name: "terminal", status: "done" },
  { kind: "assistant", id: "h-3", text: "README.md and src." },
  { kind: "user", id: "h-4", text: "Thanks" },
  { kind: "assistant", id: "h-5", text: "You're welcome." },
];

const view: RunView = {
  run: {
    source: "watched",
    start: 0,
    end: 4000,
    turnIds: false,
    cost: 0.0123,
    steps: [
      { id: "s0", kind: "model", name: "Model call", start: 0, end: 1000, length: { ms: 1000, measured: false }, text: "Looking first." },
      { id: "s1", kind: "tool", name: "terminal", start: 1000, end: 3500, length: { ms: 2500, measured: true }, args: { command: "ls" }, result: "README.md\nsrc" },
      { id: "s2", kind: "tool", name: "read_file", start: 1000, end: 1200, length: { ms: 200, measured: true }, failed: "File not found: notes.md", judged: true },
      { id: "s3", kind: "model", name: "Model call", start: 3500, end: 4000, length: { ms: 500, measured: false } },
    ],
  },
  toolProgress: { mode: "off" },
};

function pane(run: (itemId: string) => Promise<RunView>, running = false) {
  render(
    <ChatPane
      chat={{ id: "c1", runtimeId: "rt", title: "Folder", source: "app", settled: false, updatedAt: 0, items, running }}
      status="connected"
      draft=""
      draftKey="draft"
      screenshots={new ScreenshotDesk(noScreenshots)}
      onDraft={() => {}}
      onDraftStep={() => undefined}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
      onQuestion={() => {}}
      run={run}
    />,
  );
}

const runButtons = () => screen.queryAllByRole("button", { name: "Run view" }).map((b) => b.closest("[data-item]")!.getAttribute("data-item"));

describe("The Run view", () => {
  it("is offered under each turn's last reply, not a reply partway through a turn", () => {
    pane(async () => view);
    expect(runButtons()).toEqual(["h-3", "h-5"]);
  });

  it("isn't offered under the reply of a turn still running", () => {
    pane(async () => view, true);
    expect(runButtons()).toEqual(["h-3"]);
  });

  it("draws the steps with what is measured and inferred, and shows a step's arguments and result", async () => {
    const run = vi.fn(async () => view);
    pane(run);
    await userEvent.click(within(document.querySelector('[data-item="h-3"]')!).getByRole("button", { name: "Run view" }));
    expect(run).toHaveBeenCalledWith("h-3");
    const dialog = await screen.findByRole("dialog", { name: /Run of this reply/ });
    const steps = within(within(dialog).getByRole("list", { name: "Steps" })).getAllByRole("button");
    expect(steps.map((s) => s.textContent)).toEqual([
      "Model call1.0 s inferred",
      "terminal2.5 s measured",
      "read_filelooks failed200 ms measured",
      "Model call500 ms inferred",
    ]);
    expect(dialog.textContent).toContain("cost $0.012");
    expect(dialog.textContent).toContain("display.tool_progress: off");
    expect(dialog.textContent).toContain("doesn't name its turns");
    await userEvent.click(steps[1]);
    const detail = within(dialog).getByRole("region", { name: "terminal: details" });
    expect(detail.textContent).toContain('"command": "ls"');
    expect(detail.textContent).toContain("README.md");
    await userEvent.click(steps[2]);
    expect(within(dialog).getByRole("region", { name: "read_file: details" }).textContent).toContain("Looks failed, judged from the result: File not found: notes.md");
  });

  it("says why when the run can't be read, and closes on Escape", async () => {
    pane(async () => Promise.reject(new Error("Hermes's stored history doesn't hold this reply's row, so its steps can't be read.")));
    await userEvent.click(within(document.querySelector('[data-item="h-5"]')!).getByRole("button", { name: "Run view" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("doesn't hold this reply's row"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
