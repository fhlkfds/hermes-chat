// @vitest-environment jsdom
// Queueing the next messages while Hermes replies (ADR 0014), driven the way the owner would, against a fake Hermes.
// Each test checks what is on screen and what reached Hermes.
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

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const prompts = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
const composerIn = (el: HTMLElement) => within(el).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const queueIn = (el: HTMLElement) => within(el).queryByRole("region", { name: "Queued messages" });
const queuedTexts = (el: HTMLElement) => Array.from(el.querySelectorAll(".queue-text")).map((t) => t.textContent);

/** Signed in, with "Nightly backup" open and a reply streaming in it. */
async function replying() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await settle(hermes);
  await user.type(composerIn(document.body), "Unlock it{Enter}");
  await waitFor(() => expect(prompts(server)).toEqual(["Unlock it"]));
  const runtime = server.runtimeIdOf("backup")!;
  act(() => {
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Unlocking" });
  });
  const finish = async (payload: Record<string, unknown> = { status: "complete" }) => {
    act(() => server.event(runtime, "message.complete", payload));
    await settle(hermes);
    await act(async () => {});
  };
  return { server, hermes, user, runtime, finish };
}

describe("While Hermes replies", () => {
  it("keeps the composer editable, says Enter queues, and queues with Enter or the Queue button beside Stop", async () => {
    const s = await replying();
    const box = composerIn(document.body);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/Enter to queue/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    await s.user.type(box, "Then prune old snapshots{Enter}");
    await s.user.type(box, "Then check the repo");
    await s.user.click(screen.getByRole("button", { name: "Queue" }));
    expect(box.value).toBe("");
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    const queue = queueIn(document.body)!;
    expect(queuedTexts(queue)).toEqual(["Then prune old snapshots", "Then check the repo"]);
    expect(within(queue).getByText("Next")).toBeTruthy();
    expect(within(queue).getByText(/goes when this reply finishes/)).toBeTruthy();
    expect(within(queue).getByText(/only while it's open and connected/)).toBeTruthy();

    // Enter still queues while messages wait, even once the reply has ended: a new one never jumps the queue.
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "Then prune old snapshots"]);
    expect(queuedTexts(queueIn(document.body)!)).toEqual(["Then check the repo"]);
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "Then prune old snapshots", "Then check the repo"]);
    expect(queueIn(document.body)).toBeNull();
    // Idle and nothing queued: Enter sends again.
    await s.finish();
    expect(screen.getByText(/Enter to send/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("edits a queued message in place, reorders it from the keyboard, and removes it", async () => {
    const s = await replying();
    const box = composerIn(document.body);
    for (const t of ["first", "second", "third"]) await s.user.type(box, `${t}{Enter}`);
    const queue = () => queueIn(document.body)!;

    await s.user.click(within(queue()).getByRole("button", { name: "Edit queued message 2" }));
    const edit = within(queue()).getByRole("textbox", { name: "Edit queued message 2" });
    expect(document.activeElement).toBe(edit);
    await s.user.clear(edit);
    await s.user.type(edit, "second, edited{Enter}");
    expect(queuedTexts(queue())).toEqual(["first", "second, edited", "third"]);
    // Focus goes back to the Edit button.
    await waitFor(() => expect(document.activeElement).toBe(within(queue()).getByRole("button", { name: "Edit queued message 2" })));

    // Alt+↑ on the third moves it up, twice, and focus follows it.
    const third = queue().querySelectorAll<HTMLElement>(".queue-item")[2];
    third.focus();
    await s.user.keyboard("{Alt>}{ArrowUp}{ArrowUp}{/Alt}");
    expect(queuedTexts(queue())).toEqual(["third", "first", "second, edited"]);
    expect((document.activeElement as HTMLElement).dataset.queued).toBe(third.dataset.queued);

    // Delete removes the focused one; focus goes to the one now in its place.
    await s.user.keyboard("{Delete}");
    expect(queuedTexts(queue())).toEqual(["first", "second, edited"]);
    expect(document.activeElement?.textContent).toContain("first");
    await s.user.click(within(queue()).getByRole("button", { name: "Remove queued message 2" }));
    await s.user.click(within(queue()).getByRole("button", { name: "Move queued message 1 down" }));

    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "first"]);
  });

  it("Escape cancels an edit, and nothing goes while one is open", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "keep me{Enter}");
    const queue = () => queueIn(document.body)!;
    await s.user.click(within(queue()).getByRole("button", { name: "Edit queued message 1" }));
    await s.user.type(within(queue()).getByRole("textbox"), " changed");
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    await s.user.keyboard("{Escape}");
    await settle(s.hermes);
    await waitFor(() => expect(prompts(s.server)).toEqual(["Unlock it", "keep me"]));
  });

  it("Pause holds the queue past the reply's end; Resume lets it go", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "later{Enter}");
    await s.user.click(within(queueIn(document.body)!).getByRole("button", { name: "Pause" }));
    expect(within(queueIn(document.body)!).getByText(/Paused\. You paused it\./)).toBeTruthy();
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    await s.user.click(within(queueIn(document.body)!).getByRole("button", { name: "Resume" }));
    await settle(s.hermes);
    expect(prompts(s.server)).toEqual(["Unlock it", "later"]);
  });

  it("Stop stops the reply and pauses the queue, saying so", async () => {
    const s = await replying();
    await s.user.type(composerIn(document.body), "next{Enter}");
    await s.user.click(screen.getByRole("button", { name: "Stop" }));
    await s.finish({ status: "interrupted", text: "Unlocking" });
    expect(prompts(s.server)).toEqual(["Unlock it"]);
    expect(within(queueIn(document.body)!).getByText(/was stopped/)).toBeTruthy();
  });
});

describe("The same chat in both panes", () => {
  it("shares one queue: queued in one pane, it shows in both, can be removed from either, and goes once", async () => {
    const s = await replying();
    await s.user.click(screen.getByRole("button", { name: "Split into two panes" }));
    const [left, right] = panes();
    await s.user.type(composerIn(right), "from the right{Enter}");
    await s.user.type(composerIn(left), "from the left{Enter}");
    await s.user.type(composerIn(left), "drop me{Enter}");
    expect(queuedTexts(queueIn(left)!)).toEqual(["from the right", "from the left", "drop me"]);
    expect(queuedTexts(queueIn(right)!)).toEqual(["from the right", "from the left", "drop me"]);
    await s.user.click(within(queueIn(right)!).getByRole("button", { name: "Remove queued message 3" }));
    expect(queuedTexts(queueIn(left)!)).toEqual(["from the right", "from the left"]);

    await s.finish();
    await s.finish();
    expect(prompts(s.server)).toEqual(["Unlock it", "from the right", "from the left"]);
  });
});
