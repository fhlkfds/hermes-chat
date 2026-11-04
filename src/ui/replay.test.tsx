// @vitest-environment jsdom
// Edit and Regenerate on screen (issue #63, ADR 0034): Edit opens the message's words with Save as branch and Cancel
// and says which later messages the branch leaves out; Regenerate keeps the reply and switches between the answers;
// neither is done while a reply runs; and each chat keeps its own Draft.
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

async function launch() {
  const s = new FakeHermes();
  s.sessions = [row("c1", 0.1, { pinned: true, title: "Backup plan" }), row("c2", 0.5, { pinned: true, title: "Other chat" })];
  s.storeMessage("c1", { role: "user", text: "Which folders should the backup cover?" });
  s.storeMessage("c1", { role: "assistant", text: "Cover /srv/photos and /srv/documents." });
  s.storeMessage("c1", { role: "user", text: "How long should we keep snapshots?" });
  s.storeMessage("c1", { role: "assistant", text: "Let me check the disk.", tool_calls: [{ id: "k1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
  s.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "k1", context: "df -h", result: "40%" });
  s.storeMessage("c1", { role: "assistant", text: "Keep 14 daily snapshots." });
  s.storeMessage("c1", { role: "user", text: "And for /etc?" });
  s.storeMessage("c1", { role: "assistant", text: "Keep /etc for 90 days." });
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Backup plan/ }));
  await screen.findByText("Keep /etc for 90 days.");
  await act(async () => void (await hermes.idle()));
  return { s, hermes, user };
}

const edits = () => screen.getAllByRole("button", { name: "Edit" });
const regenerates = () => screen.getAllByRole("button", { name: "Regenerate" });
const composer = () => screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement;

describe("Edit", () => {
  it("opens the words with Save as branch and Cancel, says what's left out, and keeps the Draft", async () => {
    const { s, user } = await launch();
    await user.type(composer(), "half-typed draft");
    // One Edit per message of the owner's.
    expect(edits()).toHaveLength(3);
    await user.click(edits()[1]);
    const dialog = await screen.findByRole("dialog", { name: "Edit message" });
    const words = (await within(dialog).findByRole("textbox", { name: "Your message" })) as HTMLTextAreaElement;
    expect(words.value).toBe("How long should we keep snapshots?");
    expect(dialog.textContent).toContain("The 4 later messages (1 of yours, 3 replies) aren't in the branch. They stay in Backup plan.");
    expect(dialog.textContent).toContain("1 tool call ran after this message.");
    expect(dialog.textContent).toContain("doesn't undo anything");
    const save = within(dialog).getByRole("button", { name: "Save as branch" }) as HTMLButtonElement;
    // Unchanged words aren't an edit.
    expect(save.disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.requests.some((r) => r.method === "session.branch")).toBe(false);
    expect(composer().value).toBe("half-typed draft");

    await user.click(edits()[1]);
    const again = await screen.findByRole("dialog", { name: "Edit message" });
    const box = (await within(again).findByRole("textbox", { name: "Your message" })) as HTMLTextAreaElement;
    await user.clear(box);
    await user.type(box, "How long should we keep weekly snapshots?");
    await user.click(within(again).getByRole("button", { name: "Save as branch" }));

    // The branch opens here, with the edit in place of the original and a way back.
    const note = (await screen.findByText(/Edited from/)).closest<HTMLElement>("[role=note]")!;
    expect(note.textContent).toContain("your message How long should we keep snapshots? is replaced here");
    expect(await screen.findByText("How long should we keep weekly snapshots?")).toBeTruthy();
    expect(screen.queryByText("Keep /etc for 90 days.")).toBeNull();
    expect(composer().value).toBe("");
    // The original is as it was, with its later messages, its Draft, and a link to the edit.
    expect(s.transcripts.c1).toHaveLength(8);
    await user.click(within(note).getByRole("button", { name: "Backup plan" }));
    await screen.findByText("Keep /etc for 90 days.");
    await waitFor(() => expect(composer().value).toBe("half-typed draft"));
    const editedIn = (await screen.findByText("Edited in")).closest<HTMLElement>(".edited-in")!;
    expect(within(editedIn).getByRole("button", { name: "Backup plan #2" })).toBeTruthy();
  });

  it("says why while a reply is running, and offers no way to save", async () => {
    const { s, hermes, user } = await launch();
    act(() => s.event(s.runtimeIdOf("c1")!, "message.start", {}));
    act(() => s.event(s.runtimeIdOf("c1")!, "tool.start", { tool_id: "k9", name: "terminal", context: "sleep 25" }));
    await act(async () => void (await hermes.idle()));
    expect(edits()[0].getAttribute("aria-disabled")).toBe("true");
    expect(edits()[0].title).toContain("Wait for the reply to finish");
    await user.click(edits()[0]);
    const dialog = await screen.findByRole("dialog", { name: "Edit message" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Wait for the reply to finish");
    expect(within(dialog).queryByRole("button", { name: "Save as branch" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.requests.some((r) => r.method === "session.branch")).toBe(false);
  });
});

describe("Regenerate", () => {
  it("is under the last reply of each turn, keeps the reply, and switches between the answers", async () => {
    const { s, hermes, user } = await launch();
    // "Let me check the disk." is the same turn as "Keep 14 daily snapshots.": one Regenerate for both.
    expect(regenerates()).toHaveLength(3);
    await user.click(regenerates()[1]);
    const dialog = await screen.findByRole("dialog", { name: "Regenerate reply" });
    await within(dialog).findByText(/Hermes answers your message/);
    expect(dialog.textContent).toContain("Hermes answers your message How long should we keep snapshots? again");
    // The reply being regenerated stays in this chat; only the turn after it is left out of the branch.
    expect(dialog.textContent).toContain("The 2 later messages (1 of yours, 1 reply)");
    expect(dialog.textContent).not.toContain("Hermes Keep 14 daily snapshots.");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // It stays in this chat, on the new answer, which is being written in its branch.
    const branch = s.sessions.find((r) => r.parent_session_id === "c1")!;
    expect(await screen.findByText("Answer 2 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: branch.title! })).toBeTruthy();
    s.storeMessage(branch.id, { role: "assistant", text: "Keep 30 daily snapshots." });
    act(() => s.event(s.runtimeIdOf(branch.id)!, "message.complete", { text: "Keep 30 daily snapshots.", status: "complete" }));
    await act(async () => void (await hermes.idle()));
    expect(await screen.findByText("Keep 30 daily snapshots.")).toBeTruthy();
    expect(screen.getByText(/Sent again: your message/).textContent).toContain("How long should we keep snapshots?");
    expect(screen.queryByText("Keep 14 daily snapshots.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Previous answer" }));
    expect(await screen.findByText("Answer 1 of 2")).toBeTruthy();
    expect(screen.getByText("Keep 14 daily snapshots.")).toBeTruthy();
    expect(screen.getByText(/Original answer/)).toBeTruthy();
    // The original is as it was.
    expect(s.transcripts.c1).toHaveLength(8);
  });
});
