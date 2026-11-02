// @vitest-environment jsdom
// The transcript renders each block memoized, so a streamed delta re-renders only what it changed, and marks find
// matches in the background. These check what that must not change.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalChoice, Chat, Item } from "../hermes/model";
import { ChatPane, type FindTarget } from "./ChatPane";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;

const chatOf = (items: Item[], over: Partial<Chat> = {}): Chat => ({ id: "c", runtimeId: "rt", title: "Logs", source: "app", settled: false, updatedAt: 0, items, ...over });

/** The pane, and `show` to render it again with a changed chat, find target or answer handler, as App does. */
function pane(chat: Chat, findTarget?: FindTarget, onAnswer: Answer = () => {}) {
  const el = (c: Chat, t?: FindTarget, a: Answer = onAnswer) => (
    <ChatPane
      chat={c}
      findTarget={t}
      status="connected"
      draft=""
      onDraft={() => {}}
      undelivered={[]}
      onRetry={() => {}}
      onDismiss={() => {}}
      onAttach={async () => ({ attachments: [], refused: [] })}
      onSend={() => {}}
      onStop={() => {}}
      onAnswer={a}
    />
  );
  const r = render(el(chat, findTarget));
  return { show: (c: Chat, t?: FindTarget, a?: Answer) => act(() => r.rerender(el(c, t, a))) };
}

const item = (id: string) => document.querySelector(`[data-item="${id}"]`);
const approval: Item = {
  kind: "approval",
  id: "ap-1",
  requestId: "rq-1",
  command: "rm -rf build",
  description: "Clean the build",
  choices: ["once", "deny"],
  allowSession: true,
  allowPermanent: true,
};

describe("The transcript", () => {
  it("shows every streamed delta, with the cursor only while the reply runs", () => {
    const asked: Item[] = [{ kind: "user", id: "u-0", text: "Clean up the logs" }];
    const { show } = pane(chatOf(asked));
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing" }], { running: true }));
    expect(item("a-1")?.querySelector(".cursor")).not.toBeNull();
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing **old** logs." }], { running: true }));
    expect(item("a-1")?.textContent).toBe("Removing old logs.");
    show(chatOf([...asked, { kind: "assistant", id: "a-1", text: "Removing **old** logs." }]));
    expect(document.querySelector(".cursor")).toBeNull();
  });

  it("keeps an opened tool group open as the chat changes, and shows a tool call in it finishing", () => {
    const tools: Item[] = [
      { kind: "tool", id: "t-1", name: "terminal", status: "done" },
      { kind: "tool", id: "t-2", name: "read_file", status: "running" },
    ];
    const { show } = pane(chatOf(tools, { running: true }));
    fireEvent.click(screen.getByText("2 tool calls"));
    const group = document.querySelector(".tools")!;
    expect(group.querySelector(".spinner")).not.toBeNull();

    const done = tools.map((t) => (t.id === "t-2" ? { ...t, status: "done" as const } : t));
    show(chatOf([...done, { kind: "assistant", id: "a-3", text: "Done." }], { running: true }));
    expect(group.isConnected && group.querySelector(".tool-group-body")).toBeTruthy();
    expect(group.querySelector(".spinner")).toBeNull();
  });

  it("lands a search pick on the matched message, though earlier messages match too", () => {
    const items: Item[] = ["a-0", "a-1", "a-2"].map((id) => ({ kind: "assistant", id, text: `The lock in ${id} is stale.` }));
    pane(chatOf(items), { query: "lock", itemId: "a-2", at: 1 });
    expect(document.querySelectorAll("mark.hit")).toHaveLength(3);
    expect(document.querySelector("mark.current")?.closest("[data-item]")?.getAttribute("data-item")).toBe("a-2");
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  it("answers an Approval card through the handler App passed last", () => {
    const first = vi.fn<Answer>();
    const latest = vi.fn<Answer>();
    const chat = chatOf([approval], { running: true });
    const { show } = pane(chat, undefined, first);
    // A render that leaves the card's own props as they were.
    show({ ...chat }, undefined, latest);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(latest).toHaveBeenCalledWith("ap-1", "once", undefined);
    expect(first).not.toHaveBeenCalled();
  });

  it("still ignores a click on an Approval card just after the transcript moves", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const answered = vi.fn<Answer>();
    const items = [approval];
    const { show } = pane(chatOf(items, { running: true }), undefined, answered);
    vi.setSystemTime(Date.now() + 1000);

    show(chatOf([...items, { kind: "thinking", id: "r-1", text: "Waiting" }], { running: true }));
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(answered).toHaveBeenCalledWith("ap-1", "once", undefined);
  });
});
