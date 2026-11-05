// @vitest-environment jsdom
// The Export dialog (ExportChat.tsx, ADR 0076): what the owner picks and redacts is what the saved bytes hold.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Chat } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { ExportChatDialog } from "./ExportChat";

const tauri = vi.hoisted(() => ({
  saved: [] as { markdown: string; fileName: string }[],
  invoke: async (cmd: string, args?: { markdown: string; fileName: string }) => {
    if (cmd !== "chat_export") throw new Error(`${cmd} isn't available in tests`);
    tauri.saved.push(args!);
    return `/home/liam/exports/${args!.fileName}`;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
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
  tauri.saved = [];
});

const KEY = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
const preview = () => screen.getByLabelText("The file, exactly as it will be saved");

describe("Exporting from the chat's More menu", () => {
  it("opens the Export dialog, leaves out tool calls and a likely key at first, and saves exactly the preview", async () => {
    const s = new FakeHermes();
    s.sessions = [row("c1", 0.1, { pinned: true, title: "Deploy keys" })];
    s.storeMessage("c1", { role: "user", text: `The deploy fails with ${KEY}` });
    s.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
    s.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", context: "cat /srv/.env", result: "DB_HOST=10.0.0.12" });
    s.storeMessage("c1", { role: "assistant", text: "That key was revoked; make a new one." });
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Deploy keys/ }));
    await screen.findByText("That key was revoked; make a new one.");
    await act(async () => void (await hermes.idle()));

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Export as Markdown…" }));
    const dialog = screen.getByRole("dialog", { name: "Export “Deploy keys”" });
    expect((within(dialog).getByRole("checkbox", { name: /Tool calls and Approvals/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole("checkbox", { name: /Redact api key/ }) as HTMLInputElement).checked).toBe(true);
    expect(preview().textContent).not.toContain(KEY);
    expect(preview().textContent).not.toContain("DB_HOST");
    expect(preview().textContent).toContain("The deploy fails with [redacted]");

    await user.click(within(dialog).getByRole("button", { name: "Save…" }));
    expect(tauri.saved).toHaveLength(1);
    expect(tauri.saved[0].fileName).toBe("Deploy keys.md");
    expect(tauri.saved[0].markdown).not.toContain(KEY);
    expect(tauri.saved[0].markdown).not.toContain("DB_HOST");
    expect((await screen.findByRole("status")).textContent).toContain("Exported to /home/liam/exports/Deploy keys.md.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
  });
});

const chat = (more: Partial<Chat> = {}): Chat => ({
  id: "c1",
  runtimeId: "rt-1",
  title: "Moving house",
  source: "app",
  settled: false,
  updatedAt: 0,
  items: [
    { kind: "user", id: "u1", text: "Ship the boxes to 14 Larch Lane, Duluth.", attachments: ["lease.pdf"] },
    { kind: "assistant", id: "a1", text: "Booked for 14 Larch Lane. The movers' portal password: Mov3rs!2026" },
    { kind: "user", id: "u2", text: "Also, what's a good pizza place there?" },
    { kind: "tool", id: "t1", name: "web_search", args: { q: "pizza Duluth" }, status: "done", result: "Sammy's Pizza" },
  ],
  ...more,
});

function open(c = chat()) {
  const saves: [string, string][] = [];
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const props = { save: async (md: string, name: string) => (saves.push([md, name]), `/x/${name}`), onSaved, onClose };
  const view = render(<ExportChatDialog chat={c} {...props} />);
  return { saves, onSaved, onClose, rerender: (next: Chat) => view.rerender(<ExportChatDialog chat={next} {...props} />), user: userEvent.setup() };
}

/** Selects `text` in the preview, as a drag or Shift+arrows would. */
function select(text: string) {
  const walker = document.createTreeWalker(preview(), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    return;
  }
  throw new Error(`"${text}" isn't in the preview`);
}

describe("The Export dialog", () => {
  it("redacts selected text everywhere, and the saved bytes don't hold it", async () => {
    const { saves, user } = open();
    const redact = screen.getByRole("button", { name: "Redact selected text" });
    expect((redact as HTMLButtonElement).disabled).toBe(true);
    select("14 Larch Lane");
    await user.click(redact);
    expect(within(screen.getByRole("list", { name: "Text you redacted" })).getByText("2 places")).toBeTruthy();
    expect(preview().textContent).not.toContain("Larch");

    await user.click(screen.getByRole("button", { name: "Save…" }));
    const [[bytes]] = saves;
    expect(bytes).toBe(preview().textContent);
    expect(bytes).not.toContain("Larch");
    expect(bytes).not.toContain("Mov3rs!2026");
    expect(bytes).toContain("Ship the boxes to [redacted], Duluth.");
  });

  it("puts back a redaction the owner takes back, and a flagged secret the owner keeps", async () => {
    const { user } = open();
    select("Duluth");
    await user.click(screen.getByRole("button", { name: "Redact selected text" }));
    expect(preview().textContent).not.toContain("Duluth");
    await user.click(screen.getByRole("button", { name: "Keep Duluth in the file" }));
    expect(preview().textContent).toContain("Duluth");

    await user.click(screen.getByRole("checkbox", { name: /Redact password or key/ }));
    expect(preview().textContent).toContain("password: Mov3rs!2026");
  });

  it("leaves out an unticked message, and adds tool calls and attachment names only when ticked", async () => {
    const { saves, user } = open();
    expect(preview().textContent).not.toContain("Sammy's Pizza");
    expect(preview().textContent).not.toContain("lease.pdf");
    await user.click(screen.getByRole("checkbox", { name: /pizza place/ }));
    expect(screen.getByRole("group", { name: "Messages: 2 of 3" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Tool calls and Approvals/ }));
    await user.click(screen.getByRole("checkbox", { name: /Names of attached files/ }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const [[bytes]] = saves;
    expect(bytes).not.toContain("pizza place");
    expect(bytes).toContain("Sammy's Pizza");
    expect(bytes).toContain("`lease.pdf`");
  });

  it("can't save an empty file", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "None" }));
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Tool calls and Approvals/ }));
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the chat as it was when it opened", () => {
    const { rerender } = open();
    const before = preview().textContent;
    rerender(chat({ items: [...chat().items, { kind: "user", id: "u3", text: "One more thing" }] }));
    expect(preview().textContent).toBe(before);
  });

  it("stays open and says why when saving fails, and stays open when the Save dialog is cancelled", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    let fail = true;
    render(<ExportChatDialog chat={chat()} save={async () => (fail ? Promise.reject(new Error("Read-only file system")) : null)} onSaved={() => {}} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save: Read-only file system");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
