// @vitest-environment jsdom
// The Bots view in the running app, against a fake Hermes as the deployed f0d94882 (ADR 0066): what each bot's row
// shows, that a row opens the bot's Bot Chat in its profile and keeps it out of the chat list, that the pen starts an
// ordinary chat there, that /new in a Bot Chat compacts it, that the chat list panel shows the bots while a Bot Chat is
// open (bot mode), that a Hermes without Bot Mode shows no Bots button, and each row's menu (ADR 0188): Edit bot,
// Clone, Pin, Hide, Delete and Open in Settings → Profiles.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { BOT_CHAT_TITLE, BotModeUnsupportedError, rosterOf, type Bot } from "../hermes/bots";
import { getUIPrefs } from "../hermes/uiPrefs";
import { Bots, BOTS_REFRESH_MS } from "./Bots";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
const servers: FakeHermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  // Nothing the view does may send a Bot Mode write that Hermes wouldn't check against another client's (ADR 0188).
  for (const server of servers.splice(0)) expect(server.uncheckedConfigures()).toEqual([]);
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
  servers.push(server);
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

async function pickProfile(user: ReturnType<typeof userEvent.setup>, profile: string) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${profile}`) }));
}

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

  it("shows only the bots whose name holds what is typed in the search box, in any case, and not their description", async () => {
    const { user } = await launch();
    await openBots(user);
    const search = within(bots()).getByRole("textbox", { name: "Search bots" });
    await user.type(search, "SCRI");
    expect(botRows().map((r) => r.querySelector(".bots-name")?.textContent)).toEqual(["Scribe"]);
    await user.clear(search);
    await user.type(search, "release");
    expect(botRows()).toEqual([]);
    expect(within(bots()).getByText("No bots match “release”.")).toBeTruthy();
    await user.clear(search);
    expect(botRows().length).toBe(2);
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
    expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.bot).toBe(true);
    // The panel shows the bots meanwhile; back on the chat list, it lists the side-chat only.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
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
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Export…", "Share snapshot…"]);
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

describe("New bot in the Bots view", () => {
  const form = () => screen.getByRole("dialog", { name: "New bot" });

  it("makes a profile through New profile's form and shows the new bot's row, focused, without starting its Bot Chat", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "ada");
    await user.type(within(form()).getByLabelText("Description (optional)"), "Reads papers");
    await user.click(within(form()).getByRole("button", { name: /Create bot/ }));
    await waitFor(() => expect(botRows()).toHaveLength(3));
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body])).toEqual([["POST /api/profiles", { name: "ada", description: "Reads papers" }]]);
    const ada = botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!;
    expect(within(ada).getByText("Reads papers")).toBeTruthy();
    expect(within(ada).getByText("No Bot Chat yet. Open it to start one.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(ada));
    expect(within(bots()).getByRole("status").textContent).toBe("Created ada. Open its row to start its Bot Chat.");
    expect(server.requests.filter((r) => r.method === "session.create" || r.method === "prompt.submit")).toEqual([]);
  });

  it("clears a search that would hide the new bot, so its row is shown and focused", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.type(screen.getByLabelText("Search bots"), "scribe");
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "ada");
    await user.click(within(form()).getByRole("button", { name: /Create bot/ }));
    await waitFor(() => expect(botRows()).toHaveLength(3));
    expect(screen.getByLabelText("Search bots")).toHaveProperty("value", "");
    const ada = botRows().find((r) => r.querySelector(".bots-name")?.textContent === "Ada")!;
    await waitFor(() => expect(document.activeElement).toBe(ada));
  });

  it("refuses a name another bot's profile has, before asking Hermes", async () => {
    const { server, user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(within(form()).getByRole("button", { name: /Create bot/ })).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  /** The Bots view with its first roster read still pending: `arrive` gives it `roster` and answers the read. */
  async function pending() {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    let answer = () => {};
    const view = (last?: { roster: Bot[]; at: number }) => (
      <Bots
        server="hermes"
        profile="default"
        connected
        last={last}
        pictures={{}}
        load={() => new Promise<void>((done) => (answer = done))}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        profiles={{
          api: hermes.manageProfiles,
          inUse: "default",
          connected: true,
          unread: () => undefined,
          catalog: async () => [],
          busy: () => undefined,
          lostMessages: () => 0,
          jobCount: async () => undefined,
          switchTo: async () => false,
          local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
          copyText: async () => {},
        }}
      />
    );
    const { rerender } = render(view());
    expect(screen.getByText("Reading the bots…")).toBeTruthy();
    const arrive = (roster: Bot[]) =>
      act(async () => {
        rerender(view({ roster, at: Date.now() }));
        answer();
      });
    return { user, onClose, server, arrive };
  }

  it("keeps focus in the form when the roster arrives after it opened", async () => {
    const { user, onClose, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    const name = within(form()).getByLabelText("Name");
    await user.type(name, "ada");
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }] }));
    expect(botRows()).toHaveLength(1);
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Escape}");
    expect(within(form()).getByText("The changes you made here aren't saved.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("waits for the roster before creating, so a taken name never reaches Hermes", async () => {
    const { user, server, arrive } = await pending();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(within(form()).getByLabelText("Name"), "scribe");
    const create = within(form()).getByRole("button", { name: /Create bot/ });
    expect(create).toHaveProperty("disabled", true);
    expect(within(form()).getByRole("status").textContent).toBe("Wait for the list of profiles, so the name can be checked against it.");
    await user.click(create);
    await user.keyboard("{Enter}");
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    await arrive(rosterOf({ profiles: [{ name: "default", canonical_session: null }, { name: "scribe", canonical_session: null }] }));
    expect(within(form()).getByText("There's already a profile named scribe. Pick another name.")).toBeTruthy();
    expect(create).toHaveProperty("disabled", true);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("closes only the form on Escape, with focus back on New bot", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
    expect(bots()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New bot" }));
  });
});

describe("A bot's menu in the Bots view", { timeout: 30_000 }, () => {
  const rowOf = (profile: string) => bots().querySelector<HTMLElement>(`.bots-row[data-profile="${profile}"]`)!;
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const block = (server: FakeHermes, profile = "scribe") => server.profileMeta[profile]?.ui_meta?.["hermes-bots"] as Record<string, unknown>;
  const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  const sent = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
  const menuOf = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(within(bots()).getByRole("button", { name: `More for ${name}` }));
    return screen.getByRole("menu", { name: `More for ${name}` });
  };
  const pickFrom = async (user: ReturnType<typeof userEvent.setup>, name: string, entry: string) => user.click(within(await menuOf(user, name)).getByRole("menuitem", { name: entry }));
  /** Scribe's block as Hermes's desktop keeps it, with keys this app never edits. */
  const DESKTOP_KEYS = { sectionId: "s1", groups: ["drafts"], shape: "blob", futureKey: { n: 1 } };
  const withDesktopKeys = (s: FakeHermes) => {
    s.profileMeta.scribe = { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS } } };
    s.uiMetaRevisions.scribe = { "hermes-bots": 2 };
  };
  const editBot = async (user: ReturnType<typeof userEvent.setup>) => {
    await pickFrom(user, "Scribe", "Edit bot…");
    return screen.findByRole("dialog", { name: "Edit bot: Scribe" });
  };

  it("opens from the ⋯ button, a right-click, Shift+F10 and the Menu key, and Escape closes the menu alone", async () => {
    const { user } = await launch();
    await openBots(user);
    const menu = await menuOf(user, "Scribe");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit bot…", "Clone…", "Pin", "Hide", "Open in Settings → Profiles", "Delete bot…"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(bots()).toBeTruthy();
    for (const open of [
      () => user.pointer({ keys: "[MouseRight]", target: botRows()[1] }),
      async () => (botRows()[1].focus(), await user.keyboard("{Shift>}{F10}{/Shift}")),
      async () => (within(rowOf("scribe")).getByRole("button", { name: "New chat with Scribe" }).focus(), await user.keyboard("{ContextMenu}")),
    ]) {
      await open();
      expect(screen.getByRole("menu", { name: "More for Scribe" })).toBeTruthy();
      // The menu works from the keyboard: Down moves on from its first entry.
      expect(document.activeElement?.textContent).toBe("Edit bot…");
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement?.textContent).toBe("Clone…");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(bots()).toBeTruthy();
    }
  });

  it("has no menu in the chat list panel's bots", async () => {
    const { user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(document.querySelector(".sb-bots .bots-row")).toBeTruthy());
    expect(document.querySelector(".sb-bots .bots-more")).toBeNull();
  });

  it("pins and unpins a bot in Hermes, moving its row, and keeps what Hermes's desktop wrote beside it", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    await pickFrom(user, "Scribe", "Pin");
    await waitFor(() => expect(names()).toEqual(["Scribe", "Hermes"]));
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, pinned: true });
    await pickFrom(user, "Scribe", "Unpin");
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, pinned: false });
  });

  it("hides a bot behind Hidden in Hermes, with focus on that fold, and shows it again", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    await pickFrom(user, "Scribe", "Hide");
    const fold = await within(bots()).findByRole("button", { name: "Hidden in Hermes (1)" });
    expect(names()).toEqual(["Hermes"]);
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, hidden: true });
    await waitFor(() => expect(document.activeElement).toBe(fold));
    await user.click(fold);
    await pickFrom(user, "Scribe", "Show");
    await waitFor(() => expect(within(bots()).queryByRole("button", { name: /Hidden in Hermes/ })).toBeNull());
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(block(server).hidden).toBe(false);
  });

  it("turns off only Pin and Hide on a Hermes without profiles.configure, and says which method is missing", async () => {
    const { server, user } = await launch();
    server.handlers["profiles.configure"] = (r) => server.fail(r.id, -32601, "unknown method: profiles.configure");
    await openBots(user);
    await pickFrom(user, "Scribe", "Pin");
    const why = "This Hermes server can't do this: it has no route for profiles.configure. Updating Hermes adds it.";
    expect((await within(bots()).findByRole("status")).textContent).toBe(`Scribe wasn't changed. ${why}`);
    const menu = await menuOf(user, "Scribe");
    const disabled = within(menu).getAllByRole("menuitem").filter((i) => i.getAttribute("aria-disabled") === "true");
    expect(disabled.map((i) => i.textContent)).toEqual(["Pin", "Hide"]);
    expect(within(menu).getAllByText(why)).toHaveLength(2);
    await user.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    expect(sent(server, "profiles.configure")).toHaveLength(1);
    expect(names()).toEqual(["Hermes", "Scribe"]);
  });

  it("Edit bot changes the name, color and description, each read back into the row", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    const dialog = await editBot(user);
    const name = within(dialog).getByLabelText("Name in Bot Mode");
    expect(document.activeElement).toBe(name);
    await user.clear(name);
    await user.type(name, "Writer");
    fireEvent.change(within(dialog).getByLabelText("Color"), { target: { value: "#ff8800" } });
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "Drafts the changelog");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(block(server)).toEqual({ title: "Writer", color: "#ff8800", ...DESKTOP_KEYS, custom: true });
    expect(server.profileMeta.scribe.description).toBe("Drafts the changelog");
    expect(writes(server)).toEqual(["PUT /api/profiles/scribe/description"]);
    await waitFor(() => expect(names()).toEqual(["Hermes", "Writer"]));
    expect(within(rowOf("scribe")).getByText("Drafts the changelog")).toBeTruthy();
    expect(rowOf("scribe").querySelector<HTMLElement>(".bots-face")!.style.background).toBe("rgb(255, 136, 0)");
    expect(within(bots()).getByRole("status").textContent).toBe("Saved scribe.");
  });

  it("Edit bot shows Hermes's new name and stays open when the name changed elsewhere", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    const dialog = await editBot(user);
    server.writeBotAsOtherClient("scribe", { title: "Quill" });
    const name = within(dialog).getByLabelText("Name in Bot Mode");
    await user.clear(name);
    await user.type(name, "Writer");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    expect(await within(dialog).findByText("Changed elsewhere since you opened this. Hermes has “Quill” now. Save again to replace it.")).toBeTruthy();
    expect(block(server).title).toBe("Quill");
    expect(sent(server, "profiles.configure")).toEqual([]);
    expect(name).toHaveProperty("value", "Writer");
    expect(screen.getByRole("dialog", { name: "Edit bot: Scribe" })).toBeTruthy();
    // The row behind the dialog already shows what Hermes has.
    expect(names()).toEqual(["Hermes", "Quill"]);

    await user.click(within(dialog).getByRole("button", { name: "Use Hermes's" }));
    expect(name).toHaveProperty("value", "Quill");
    expect(within(dialog).queryByText(/Changed elsewhere/)).toBeNull();
    // Nothing is left to save, so the dialog closes without a question and nothing is written.
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    expect(sent(server, "profiles.configure")).toEqual([]);
    expect(block(server)).toEqual({ title: "Quill", color: "#44aa77", ...DESKTOP_KEYS });
  });

  it("Edit bot replaces a name changed elsewhere only on a second Save, once the owner has seen it", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    const dialog = await editBot(user);
    server.writeBotAsOtherClient("scribe", { title: "Quill", sectionId: "s2" });
    await user.clear(within(dialog).getByLabelText("Name in Bot Mode"));
    await user.type(within(dialog).getByLabelText("Name in Bot Mode"), "Writer");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await within(dialog).findByText(/Hermes has “Quill” now/);
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(block(server)).toEqual({ title: "Writer", color: "#44aa77", ...DESKTOP_KEYS, sectionId: "s2" });
  });

  it("Edit bot sets and removes the bot's picture, shown in its row", async () => {
    const { server, user } = await launch(withDesktopKeys);
    await openBots(user);
    const dialog = await editBot(user);
    const bytes = Uint8Array.from("\x89PNG\r\n\x1a\nface", (c) => c.charCodeAt(0));
    const url = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    await user.upload(within(dialog).getByLabelText("Choose a picture…", { selector: "input" }), new File([bytes], "face.png", { type: "image/png" }));
    await waitFor(() => expect(dialog.querySelector(".profile-picture img")?.getAttribute("src")).toBe(url));
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.botAvatars.scribe).toBe(url);
    expect(block(server)).toEqual({ title: "Scribe", color: "#44aa77", ...DESKTOP_KEYS, custom: true, imageKind: "photo" });
    await waitFor(() => expect(rowOf("scribe").querySelector("img")?.getAttribute("src")).toBe(url));

    const again = await editBot(user);
    await user.click(within(again).getByRole("button", { name: "Remove picture" }));
    await user.click(within(again).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    expect(server.botAvatars).toEqual({});
    expect(block(server).imageKind).toBe("shape");
    await waitFor(() => expect(rowOf("scribe").querySelector("img")).toBeNull());
  });

  it("Edit bot refuses a picture Hermes wouldn't store, before sending it", async () => {
    const { server, user } = await launch();
    await openBots(user);
    const dialog = await editBot(user);
    const input = within(dialog).getByLabelText("Choose a picture…", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["GIF89a"], "face.gif", { type: "image/gif" })] } });
    expect(await within(dialog).findByText("Hermes takes PNG, JPEG or WebP pictures.")).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(2_000_001)], "big.png", { type: "image/png" })] } });
    expect(await within(dialog).findByText("That picture is over 2 MB, the most Hermes stores.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Save changes/ })).toHaveProperty("disabled", true);
    expect(sent(server, "profiles.set_asset")).toEqual([]);
  });

  it("Edit bot renames the profile last, as Settings → Profiles does, and its row follows with its look", async () => {
    // A profile with a reply running can't be renamed, so Scribe is idle here.
    const { server, hermes, user } = await launch((s) => {
      withDesktopKeys(s);
      s.liveSessions = [];
    });
    await openBots(user);
    const dialog = await editBot(user);
    await user.clear(within(dialog).getByLabelText("Name in Bot Mode"));
    await user.type(within(dialog).getByLabelText("Name in Bot Mode"), "Writer");
    await user.clear(within(dialog).getByLabelText("Profile name"));
    await user.type(within(dialog).getByLabelText("Profile name"), "quill");
    await user.click(within(dialog).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull());
    // The look is written under the old name, then the profile is renamed.
    expect(sent(server, "profiles.configure").map((r) => r.params.name)).toEqual(["scribe"]);
    expect(writes(server)).toEqual(["PATCH /api/profiles/scribe"]);
    expect(block(server, "quill")).toEqual({ title: "Writer", color: "#44aa77", ...DESKTOP_KEYS });
    await waitFor(() => expect(rowOf("quill")).toBeTruthy());
    expect(names()).toEqual(["Hermes", "Writer"]);
    expect(within(bots()).getByRole("status").textContent).toBe("Renamed scribe to quill.");
    await waitFor(() => expect(document.activeElement).toBe(within(rowOf("quill")).getByRole("button", { name: /^Writer/ })));
    expect(hermes.profile).toBe("default");
  });

  it("Edit bot says so when Hermes no longer has the profile, and opens nothing", async () => {
    const { server, user } = await launch();
    await openBots(user);
    delete server.otherProfiles.scribe;
    await pickFrom(user, "Scribe", "Edit bot…");
    expect((await within(bots()).findByRole("status")).textContent).toBe("Hermes no longer has scribe. Another client may have renamed or deleted it.");
    expect(screen.queryByRole("dialog", { name: /Edit bot/ })).toBeNull();
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
  });

  it("Clone… opens the Clone dialog with this bot as the source", async () => {
    const { user } = await launch();
    await openBots(user);
    await pickFrom(user, "Scribe", "Clone…");
    const dialog = await screen.findByRole("dialog", { name: "Clone a profile" });
    await waitFor(() => expect(within(dialog).getByLabelText("From")).toHaveProperty("value", "scribe"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clone a profile" })).toBeNull());
    expect(bots()).toBeTruthy();
  });

  it("Delete bot… deletes through Settings → Profiles' question, and default can't be deleted", async () => {
    const { server, user } = await launch();
    await openBots(user);
    const hermesMenu = await menuOf(user, "Hermes");
    const del = within(hermesMenu).getByRole("menuitem", { name: "Delete bot…" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(within(hermesMenu).getByText("Hermes's built-in profile can't be deleted.")).toBeTruthy();
    await user.click(del);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.keyboard("{Escape}");

    await pickFrom(user, "Scribe", "Delete bot…");
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scribe”\?/ });
    const confirm = within(question).getByRole("button", { name: /Delete profile/ });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(question).getByLabelText("Type scribe to confirm"), "scribe");
    await user.click(confirm);
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
    expect(writes(server)).toEqual(["DELETE /api/profiles/scribe"]);
    expect(server.otherProfiles.scribe).toBeUndefined();
    expect(within(bots()).getByRole("status").textContent).toBe("Deleted scribe.");
    expect(bots().contains(document.activeElement)).toBe(true);
  });

  it("Delete bot… switches to default first when the bot's profile is the one in use", async () => {
    const { server, hermes, user } = await launch();
    await pickProfile(user, "scribe");
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await openBots(user);
    await pickFrom(user, "Scribe", "Delete bot…");
    const question = await screen.findByRole("alertdialog", { name: /Delete profile “scribe”\?/ });
    expect(within(question).getByText("You're using this profile. Highwing will switch to default first.")).toBeTruthy();
    await user.type(within(question).getByLabelText("Type scribe to confirm"), "scribe");
    await user.click(within(question).getByRole("button", { name: /Delete profile/ }));
    await waitFor(() => expect(server.otherProfiles.scribe).toBeUndefined());
    expect(hermes.profile).toBe("default");
    await waitFor(() => expect(names()).toEqual(["Hermes"]));
  });

  it("Open in Settings → Profiles opens Settings on that bot's profile", async () => {
    const { user } = await launch();
    await openBots(user);
    await pickFrom(user, "Scribe", "Open in Settings → Profiles");
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    const list = await screen.findByRole("listbox", { name: "Profiles" });
    await waitFor(() => expect(within(list).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.getAttribute("data-profile")).toBe("scribe"));
    expect(screen.getByRole("tab", { name: "Profiles" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Opening the Bots view", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const names = () => botRows().map((r) => r.querySelector(".bots-name")?.textContent);
  const picture = (i: number) => botRows()[i].querySelector("img")?.getAttribute("src");
  /** Holds every later `profiles.list` until `release`, so the view can show only what the app already read. */
  function holdRosters(server: FakeHermes) {
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    return () => {
      server.handlers["profiles.list"] = list;
      held.splice(0).forEach((f) => f());
    };
  }

  it("shows the bots and their pictures at once after connecting, before Hermes answers again", async () => {
    const { server, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    holdRosters(server);
    await user.click(botsButton()!);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    expect(screen.queryByText("Reading the bots…")).toBeNull();
    expect(document.activeElement).toBe(botRows()[0]);
  });

  it("shows them at once on reopening, and doesn't ask for the pictures again on the same connection", async () => {
    const { server, hermes, user } = await launch((s) => (s.botAvatars = { scribe: PNG }));
    await openBots(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Bots/ })).toBeNull();
    const release = holdRosters(server);
    await user.click(botsButton()!);
    expect(names()).toEqual(["Hermes", "Scribe"]);
    expect(picture(1)).toBe(PNG);
    await act(async () => release());
    await act(async () => void (await hermes.idle()));
    expect(server.requests.filter((r) => r.method === "profiles.get_asset")).toHaveLength(1);
  });

  it("shows the roster read last, then a change on the server once it is read again", async () => {
    const { server, user } = await launch();
    const scribe = server.profileMeta.scribe.ui_meta!["hermes-bots"] as { title: string };
    scribe.title = "Quill";
    const release = holdRosters(server);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await user.click(botsButton()!);
      expect(names()).toEqual(["Hermes", "Scribe"]);
      await act(async () => release());
      await waitFor(() => expect(names()).toEqual(["Hermes", "Quill"]));
      scribe.title = "Inkwell";
      await act(async () => void vi.advanceTimersByTime(BOTS_REFRESH_MS));
      await waitFor(() => expect(names()).toEqual(["Hermes", "Inkwell"]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("A Hermes without Bot Mode", () => {
  it("shows no Bots button once the check finds no profiles.list", async () => {
    const { hermes } = await launch((s) => (s.botMode = "none"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
  });

  it("shows no Bots button once the check finds a profiles.list that doesn't report Bot Chats, without opening the view", async () => {
    const { hermes } = await launch((s) => (s.botMode = "no-canonical"));
    await act(async () => void (await hermes.capabilities.refresh()));
    await waitFor(() => expect(botsButton()).toBeNull());
    expect(hermes.capabilities.get("botMode").why).toMatch(/doesn't report their Bot Chats/);
  });

  it("says why in the view when it finds out there, with focus on Close so Escape closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUnsupported = vi.fn();
    render(
      <Bots
        server="hermes"
        profile="default"
        connected
        pictures={{}}
        load={async () => {
          throw new BotModeUnsupportedError("This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode.");
        }}
        activity={() => undefined}
        onOpen={() => {}}
        onNewChat={() => {}}
        onRefresh={() => {}}
        onClose={onClose}
        onUnsupported={onUnsupported}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/so it has no Bot Mode\. Highwing shows no Bots button for it\.$/));
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement?.classList.contains("bots-close")).toBe(true));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("What the owner does while a Bot Chat opens", () => {
  /** Holds every `session.list` until `release`. */
  function holdLookups(server: FakeHermes) {
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => void held.push(() => lookup(r));
    return () => held.splice(0).forEach((f) => f());
  }

  it("keeps the chat the owner opened meanwhile, in the same profile", async () => {
    const { server, hermes, user } = await launch();
    const release = holdLookups(server);
    await openBots(user);
    await user.click(botRows()[0]);
    await waitFor(() => expect(server.requests.some((r) => r.method === "session.list")).toBe(true));
    await user.click(screen.getByText("Disk usage"));
    await waitFor(() => expect(screen.getByText("How full is the disk?")).toBeTruthy());
    await act(async () => release());
    await waitFor(() => expect(server.sessions.some((s) => s.title === BOT_CHAT_TITLE)).toBe(true));
    // The Bot Chat was made, but the pane stays on the chat the owner picked.
    await act(async () => void (await hermes.idle()));
    expect(screen.getByText("How full is the disk?")).toBeTruthy();
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Disk usage/);
  });

  it("drops the open once the owner picks another profile before the bot's list loads, even after coming back", async () => {
    const { server, hermes, user } = await launch();
    // The scribe profile's list is held, so the open waits for it.
    const list = server.rest["GET /api/sessions"];
    const held: (() => void)[] = [];
    let holding = true;
    server.rest["GET /api/sessions"] = (req) =>
      holding && req.query.get("profile") === "scribe" ? new Promise((resolve) => held.push(() => resolve(list(req)))) : list(req);
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.profile).toBe("scribe"));
    await pickProfile(user, "default");
    await waitFor(() => expect(listTitles()).toEqual(["Disk usage"]));
    holding = false;
    held.splice(0).forEach((f) => f());
    await pickProfile(user, "scribe");
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    await act(async () => void (await hermes.idle()));
    // Coming back is an ordinary switch: no Bot Chat lookup, and the Bot Chat doesn't open.
    expect(server.requests.filter((r) => r.method === "session.list")).toEqual([]);
    expect(screen.queryByText("Draft the release notes for 0.9")).toBeNull();
  });
});

describe("A Bot Chat outside the list", () => {
  it("keeps the rail's dot for an Approval in a Bot Chat resumed here, after switching away from its profile", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    const runtimeId = hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")!.runtimeId!;
    // Hermes lists the session this app resumed as waiting; its row carries no title, and the app knows its profile.
    server.liveSessions = [{ id: runtimeId, session_key: "scribe-bot", status: "waiting", last_active: nowS() }];
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.checkOtherProfiles()));
    expect(hermes.getSnapshot().live?.sessions).toEqual([expect.objectContaining({ chatId: "scribe-bot", status: "waiting", profile: "scribe" })]);
    expect(hermes.getSnapshot().live?.sessions[0].title).toBeUndefined();
    await waitFor(() => expect(botsButton()?.getAttribute("aria-label")).toBe("Bots, one needs you"));
  });

  it("stays out of the list after switching away and back, and isn't the chat reopened at launch", async () => {
    const { hermes, user } = await launch();
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    expect(getUIPrefs().lastOpenChat.scribe).toBeUndefined();
    await act(async () => void (await hermes.switchProfile("default")));
    await act(async () => void (await hermes.sync()));
    await act(async () => void (await hermes.switchProfile("scribe")));
    // The saved list shows at once, before Hermes answers: it never held the Bot Chat.
    expect(listTitles()).not.toContain(BOT_CHAT_TITLE);
    await act(async () => void (await hermes.sync()));
    expect(listTitles()).toEqual(["Changelog wording"]);
  });
});

describe("Bot mode in the chat list panel", () => {
  const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
  const panelBots = () => Array.from(panel().querySelectorAll<HTMLButtonElement>(".bots-open"));
  const names = () => panelBots().map((r) => r.querySelector(".bots-name")?.textContent);
  const current = () => panelBots().map((r) => r.getAttribute("aria-current"));

  async function openScribe(user: ReturnType<typeof userEvent.setup>) {
    await openBots(user);
    await user.click(botRows()[1]);
    await waitFor(() => expect(screen.getByText("Draft the release notes for 0.9")).toBeTruthy());
    await waitFor(() => expect(names()).toEqual(["Hermes", "Scribe"]));
  }

  it("shows the bots instead of the chats while a Bot Chat is open, with its bot current", async () => {
    const { user } = await launch();
    await openScribe(user);
    expect(within(panel()).getByRole("heading", { name: "Bots" })).toBeTruthy();
    expect(current()).toEqual([null, "true"]);
    expect(within(panelBots()[1]).getByText("Release notes drafted: three fixes.")).toBeTruthy();
    expect(listTitles()).toEqual([]);
    expect(panel().querySelector(".profile-btn")?.textContent).toMatch(/scribe/);
    expect(within(panel()).getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Search chats" })).toBeTruthy();
  });

  it("goes back to the chat list on New chat", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.click(within(panel()).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
    expect(within(panel()).queryByRole("heading", { name: "Bots" })).toBeNull();
  });

  it("goes back to the chat list on Ctrl+N", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(() => expect(screen.getByText("What should Hermes work on?")).toBeTruthy());
    await waitFor(() => expect(listTitles()).toContain("Changelog wording"));
    expect(panelBots()).toEqual([]);
  });

  it("goes back to the chat list once an ordinary chat opens from search", async () => {
    const { user } = await launch();
    await openScribe(user);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Changelog");
    await waitFor(() => expect(document.querySelector(".hit-row")).toBeTruthy());
    await user.click(document.querySelector<HTMLElement>(".hit-row")!);
    await waitFor(() => expect(screen.getByText("Which wording reads better?")).toBeTruthy());
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
  });

  it("opens another bot's Bot Chat from the panel, in its profile, and stays in bot mode with that bot current", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    // Never the next profile's chats meanwhile.
    const chatsShown: string[][] = [];
    const watch = new MutationObserver(() => panelBots().length || chatsShown.push(listTitles() as string[]));
    watch.observe(document.body, { subtree: true, childList: true });
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    const made = await waitFor(() => server.sessions.find((s) => s.title === BOT_CHAT_TITLE && s.hidden)!.id);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === made)?.bot).toBe(true));
    await act(async () => void (await hermes.idle()));
    watch.disconnect();
    expect(chatsShown).toEqual([]);
    expect(current()).toEqual(["true", null]);
    expect(within(document.querySelector<HTMLElement>(".chat-head")!).getByText("Bot")).toBeTruthy();
    expect(panel().querySelector(".profile-btn")?.textContent).toMatch(/default/);
  });

  it("asks before a bot in another profile opens while an Approval waits here, as the Bots view does", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "scribe-bot")?.runtimeId).toBeTruthy());
    await act(async () => void server.askApproval(server.runtimeIdOf("scribe-bot")!));
    await user.click(panelBots()[0]);
    const ask = await screen.findByRole("alertdialog", { name: "Switch to default?" });
    expect(ask.textContent).toMatch(/An approval is waiting in scribe/);
    await user.keyboard("{Escape}");
    expect(ask.isConnected).toBe(false);
    expect(hermes.profile).toBe("scribe");
    expect(current()).toEqual([null, "true"]);
    // Escape from a row, or choosing another row, also takes the question away.
    await user.click(panelBots()[0]);
    panelBots()[1].focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    await user.click(panelBots()[0]);
    await user.click(panelBots()[1]);
    expect(screen.queryByRole("alertdialog", { name: "Switch to default?" })).toBeNull();
    expect(hermes.profile).toBe("scribe");
    await user.click(panelBots()[0]);
    await user.click(screen.getByRole("button", { name: "Switch to default" }));
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(current()).toEqual(["true", null]));
  });

  it("keeps a chat started while another bot's Bot Chat is on its way, and leaves bot mode for it", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const held: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void held.push(() => lookup(r)) : lookup(r));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(held).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    await waitFor(() => expect(panelBots()).toEqual([]));
    server.handlers["session.list"] = lookup;
    held.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(panelBots()).toEqual([]);
  });

  it("keeps a chat sent while it is still starting, when the Bot Chat on its way is found first", async () => {
    const { server, hermes, user } = await launch((s) => (s.liveSessions = []));
    await openScribe(user);
    const lookup = server.handlers["session.list"];
    const create = server.handlers["session.create"];
    const lookups: (() => void)[] = [];
    const creates: (() => void)[] = [];
    server.handlers["session.list"] = (r) => (r.params.title ? void lookups.push(() => lookup(r)) : lookup(r));
    server.handlers["session.create"] = (r) => (r.params.title ? create(r) : void creates.push(() => create(r)));
    await user.click(panelBots()[0]);
    await waitFor(() => expect(hermes.profile).toBe("default"));
    await waitFor(() => expect(lookups).toHaveLength(1));
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message/);
    await user.click(composer);
    await user.paste("Check the disk");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(creates).toHaveLength(1));
    server.handlers["session.list"] = lookup;
    lookups.splice(0).forEach((f) => f());
    await act(async () => void (await hermes.idle()));
    // The owner's message is on its way to a chat of its own, so the Bot Chat found meanwhile doesn't take the pane.
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    server.handlers["session.create"] = create;
    creates.splice(0).forEach((f) => f());
    await waitFor(() => expect(server.requests.some((r) => r.method === "prompt.submit")).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(document.querySelector(".chat-head")?.textContent).not.toMatch(/Bot Chat/);
    expect(document.querySelector(".chat-head")?.textContent).toMatch(/Check the disk/);
    expect(panelBots()).toEqual([]);
  });

  it("isn't in bot mode after a relaunch", async () => {
    const { hermes, user } = await launch();
    await openScribe(user);
    cleanup();
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(listTitles()).toEqual(["Changelog wording"]));
    expect(panelBots()).toEqual([]);
  });
});
