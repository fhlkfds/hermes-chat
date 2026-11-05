// @vitest-environment jsdom
// The Bots view in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row
// shows, that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an
// ordinary chat there, that /new in a Bot Chat compacts it, and that a Hermes without Bot Mode shows no Bots button.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { BOT_CHAT_TITLE } from "../hermes/bots";
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

let launches = 0;
const nowS = () => Date.now() / 1000;

/** Signed in to `default`, with Scribe in `scribe`: its Bot Chat holds one exchange and is replying again. */
async function launch(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage", last_read_at: nowS() })];
  server.otherProfiles = {
    scribe: [
      row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true, last_read_at: nowS() }),
      row("scribe-side", 1, { pinned: true, title: "Changelog wording", last_read_at: nowS() }),
    ],
  };
  server.transcripts = {
    disk: [{ role: "user", text: "How full is the disk?" }],
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
    "scribe-side": [{ role: "user", text: "Which wording reads better?" }],
  };
  server.profileMeta = { scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  server.liveSessions = [{ id: "rt-s", session_key: "scribe-bot", status: "working", last_active: nowS() - 5 }];
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  return { server, hermes, user: userEvent.setup() };
}

const botsButton = () => document.querySelector<HTMLButtonElement>(".bots-btn");
const bots = () => screen.getByRole("dialog", { name: /Bots/ });
const botRows = () => Array.from(bots().querySelectorAll<HTMLButtonElement>(".bots-open"));
const listTitles = () => [...document.querySelectorAll(".sidebar .row-title")].map((e) => e.textContent);

async function openBots(user: ReturnType<typeof userEvent.setup>) {
  await user.click(botsButton()!);
  await waitFor(() => expect(botRows().length).toBe(2));
}

describe("The Bots view", () => {
  it("lists every profile as a bot, with its description, its Bot Chat's last message and what it is doing", async () => {
    const { user } = await launch();
    await openBots(user);
    const [hermesRow, scribeRow] = botRows();
    expect(within(hermesRow).getByText("Hermes")).toBeTruthy();
    expect(within(hermesRow).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    expect(within(scribeRow).getByText("Scribe")).toBeTruthy();
    expect(within(scribeRow).getByText("Writes release notes")).toBeTruthy();
    expect(within(scribeRow).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(within(scribeRow).getByText("Replying")).toBeTruthy();
    expect(scribeRow.getAttribute("aria-label")).toMatch(/^Scribe\. Replying\. Writes release notes\. Last message: Release notes drafted/);
    expect(screen.getByRole("button", { name: "New chat with Scribe" })).toBeTruthy();
  });

  it("opens a bot's Bot Chat in its profile, and keeps it out of the chat list", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    // Looked up by title, not created.
    expect(server.requests.filter((r) => r.method === "session.list").map((r) => r.params.title)).toEqual([BOT_CHAT_TITLE]);
    expect(server.requests.filter((r) => r.method === "session.create")).toEqual([]);
    // The list shows the side-chat only.
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
  });

  it("marks the open Bot Chat as one, and offers nothing that would rename, retire or link it by id", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    const head = document.querySelector<HTMLElement>(".chat-head")!;
    expect(within(head).getByText("Bot")).toBeTruthy();
    expect(within(head).queryByText("Settled")).toBeNull();
    await user.click(within(head).getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: /More actions for Bot Chat/ });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Export as Markdown"]);
  });

  it("starts a Bot Chat once for a bot without one, and sends nothing", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE && s.hidden)).toBe(true));
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    const id = server.sessions.find((s) => s.title === BOT_CHAT_TITLE)!.id;
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true));
  });

  it("starts an ordinary chat in the bot's profile from the pen", async () => {
    const { server, hermes, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New chat with Scribe" }));
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
  });

  it("compacts a Bot Chat for /new instead of starting a new chat", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.keyboard("/new{Enter}{Enter}");
    await waitFor(() => expect(screen.getByText(/A Bot Chat is one continuous conversation, so \/new compacts it/)).toBeTruthy());
    expect(server.requests.filter((r) => r.method === "session.compress")).toHaveLength(1);
    expect(screen.queryByText("What should Hermes work on?")).toBeNull();
  });
});

describe("A Hermes without Bot Mode", () => {
  it("shows no Bots button once the check finds no profiles.list", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
  });

  it("says why in the view when its rows don't report Bot Chats, and the button goes once it closes", async () => {
    const { user } = await launch((s) => (s.botMode = "no-canonical"));
    await user.click(botsButton()!);
    await waitFor(() => expect(within(bots()).getByRole("alert").textContent).toMatch(/doesn't report their Bot Chats, so it has no Bot Mode\. Hermes Chat shows no Bots button for it\.$/));
    // The button stays while the view that found out is open, and Escape closes it from Close, which has focus.
    expect(botsButton()).not.toBeNull();
    await waitFor(() => expect(document.activeElement?.classList.contains("bots-close")).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(botsButton()).toBeNull());
  });
});
