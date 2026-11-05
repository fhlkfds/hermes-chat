// @vitest-environment jsdom
// Side questions (`/btw`, ADR 0069) in the running app, against a fake Hermes: offered by Hermes's catalog, asked while a
// reply runs or the chat is idle, answered on a card above the composer and never in the transcript.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import type { SideQuestion } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { SideQuestions } from "./SideQuestions";

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

let launches = 0;

/** The app signed in to a fake Hermes, with the chat "Nightly backup" open. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nginx", 2, { pinned: true, title: "Rotate nginx logs" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }, { role: "assistant", text: "The restic repo was locked." }] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@btw-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user, runtime: server.runtimeIdOf("backup")! };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const options = () => within(screen.getByRole("listbox", { name: "Commands" })).getAllByRole("option");
const sent = (server: FakeHermes) => server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text);
const cards = () => screen.queryAllByRole("article", { name: /^Side question:/ });

describe("/btw in the menu", () => {
  it("is offered when Hermes lists it, as a command Hermes runs", async () => {
    const { user } = await launch();
    await user.click(composer());
    await user.keyboard("/bt");
    expect(options().map((o) => o.querySelector(".cmd-name")!.textContent)).toEqual(["/btw"]);
    expect(options()[0].textContent).toMatch(/<question>.*Hermes.*Ask a side question about this chat without interrupting the reply/);
    expect(options()[0].querySelector(".cmd-why")).toBeNull();
  });

  it("is marked unavailable, saying why, when this Hermes doesn't list it, and asks nothing", async () => {
    const { server, user } = await launch((s) => (s.commandCatalog = ["steer", "context"]));
    await user.click(composer());
    await user.keyboard("/bt");
    expect(options()[0].querySelector(".cmd-why")!.textContent).toBe("This Hermes doesn't list it, so it may not have it. Updating Hermes may add it.");
    await user.keyboard("{Enter}Which repo?{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/^\/btw can't run: This Hermes doesn't list it/);
    expect(composer().value).toBe("/btw Which repo?");
    expect(server.requests.some((r) => r.method === "prompt.btw")).toBe(false);
    expect(cards()).toEqual([]);
  });
});

describe("A side question", () => {
  it("asked while a reply runs shows on a card, waits, then shows its answer, and the reply goes on untouched", async () => {
    const { server, hermes, user, runtime } = await launch();
    await user.type(composer(), "Run the backup{Enter}");
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true));
    act(() => server.event(runtime, "message.delta", { text: "Running restic" }));

    await user.type(composer(), "/btw which repo was locked?{Enter}");
    const card = await screen.findByRole("article", { name: "Side question: which repo was locked?" });
    expect(within(card).getByRole("status").textContent).toMatch(/Hermes is answering from a snapshot of this chat/);
    await waitFor(() => expect(composer().value).toBe(""));
    expect(server.last("prompt.btw")?.params).toEqual({ session_id: runtime, text: "which repo was locked?" });
    // Never queued, steered or sent as a message.
    expect(sent(server)).toEqual(["Run the backup"]);
    expect(server.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();

    const taskId = "btw_000001";
    act(() => server.event(runtime, "btw.complete", { task_id: taskId, question: "which repo was locked?", text: "The **restic** repo on the NAS." }));
    await waitFor(() => expect(within(card).getByText("restic").tagName).toBe("STRONG"));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.running).toBe(true);

    // The answer and question are on the card, not in the transcript.
    const messages = [...document.querySelectorAll(".msg")].map((m) => m.textContent ?? "");
    expect(messages.some((m) => /NAS|which repo/.test(m))).toBe(false);
    expect(messages.some((m) => /Running restic/.test(m))).toBe(true);

    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    await user.click(within(card).getByRole("button", { name: "Copy" }));
    expect(copied).toEqual(["The **restic** repo on the NAS."]);

    await user.click(within(card).getByRole("button", { name: "Dismiss side question" }));
    expect(cards()).toEqual([]);
    expect(document.activeElement).toBe(composer());
  });

  it("asked with the chat idle starts no turn, and stays with its chat across a switch", async () => {
    const { server, user } = await launch((s) => (s.sideAnswer = (q) => `Answer to ${q}`));
    await user.click(composer());
    await user.keyboard("/btw what was the error?{Enter}");
    expect(await screen.findByText("Answer to what was the error?")).toBeTruthy();
    expect(sent(server)).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Rotate nginx logs/ }));
    await waitFor(() => expect(cards()).toEqual([]));
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(await screen.findByText("Answer to what was the error?")).toBeTruthy();
  });

  it("stacks, newest nearest the composer, three at most", async () => {
    const { user } = await launch((s) => (s.sideAnswer = (q) => `Answer to ${q}`));
    await user.click(composer());
    for (const q of ["one", "two", "three", "four"]) {
      await user.keyboard(`/btw ${q}{Enter}`);
      await screen.findByText(`Answer to ${q}`);
    }
    expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual(["Side question: two", "Side question: three", "Side question: four"]);
    // In the flow above the composer, so the last card is the one right before it.
    const wrap = composer().closest(".composer-wrap")!;
    expect(cards().at(-1)!.closest(".side-questions")!.nextElementSibling).toBe(wrap);
  }, 20_000);

  it("shows Hermes's refusal on its card, not as a failed message, and keeps the words typed", async () => {
    const { server, user } = await launch();
    server.handlers["prompt.btw"] = (r) => server.fail(r.id, 4001, "session not found");
    await user.click(composer());
    await user.keyboard("/btw anything?{Enter}");
    const card = await screen.findByRole("article", { name: "Side question: anything?" });
    expect(within(card).getByRole("alert").textContent).toBe("No answer: session not found");
    expect(composer().value).toBe("/btw anything?");
    expect([...document.querySelectorAll(".msg.user")].map((m) => m.textContent)).not.toContainEqual(expect.stringMatching(/anything/));
  });

  it("shows on its card that the connection dropped before the answer", async () => {
    const { server, user } = await launch();
    await user.click(composer());
    await user.keyboard("/btw still there?{Enter}");
    const card = await screen.findByRole("article", { name: "Side question: still there?" });
    act(() => server.drop());
    await waitFor(() => expect(within(card).getByRole("alert").textContent).toBe("No answer: The connection to Hermes dropped before it answered."));
  });
});

describe("The stack of cards", () => {
  /** The section as a scroll box 100 px tall whose content is `content.height` tall. */
  const geometry = (section: HTMLElement, content: { height: number }) => {
    let top = 0;
    Object.defineProperties(section, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => content.height },
      scrollTop: { configurable: true, get: () => top, set: (v: number) => (top = Math.max(0, Math.min(v, content.height - 100))) },
    });
  };
  const asking = (id: string): SideQuestion => ({ id, question: `Q ${id}?`, state: "asking" });
  const answered = (q: SideQuestion): SideQuestion => ({ id: q.id, question: q.question, state: "answered", answer: "A long answer." });

  it("stays on the newest card as older answers grow, unless the owner scrolled up, and a new question brings it back", () => {
    const content = { height: 100 };
    const [one, two, three] = [asking("1"), asking("2"), asking("3")];
    const { rerender } = render(<SideQuestions questions={[one, two, three]} onDismiss={() => {}} />);
    const section = screen.getByRole("region", { name: "Side questions" });
    geometry(section, content);

    content.height = 400;
    rerender(<SideQuestions questions={[answered(one), two, three]} onDismiss={() => {}} />);
    expect(section.scrollTop).toBe(300);

    section.scrollTop = 0;
    fireEvent.scroll(section);
    content.height = 600;
    rerender(<SideQuestions questions={[answered(one), answered(two), three]} onDismiss={() => {}} />);
    expect(section.scrollTop).toBe(0);

    rerender(<SideQuestions questions={[answered(two), three, asking("4")]} onDismiss={() => {}} />);
    expect(section.scrollTop).toBe(500);
  });
});
