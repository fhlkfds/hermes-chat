// @vitest-environment jsdom
// Settings → Memory on screen, against the fake dashboard: what it shows in each state, editing with Save, Cancel and
// Reload, conflicts and failed saves keeping the owner's text, profile isolation, and asking before an unsaved edit is
// dropped by leaving Settings, opening a chat or switching profile. Every memory entry here is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import type { ConnectionStatus } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

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

const FALCON = "Project Falcon uses Postgres 16; migrations live in db/migrations.";
const SHORT = "Owner prefers short answers with a code sample first.";
const SAM = "Name: Sam Example. Works in UTC+1.";

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { research: [row("notes", 1, { pinned: true, title: "Reading notes" })] };
  s.memory = {
    default: { memory: [FALCON, SHORT], profile: [SAM] },
    research: { memory: ["Research profile: cite sources as numbered footnotes."], profile: [] },
  };
  return s;
}

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

/** Settings on its own, opened on the Memory tab. */
function Shell({ hermes, profile, status }: { hermes: Hermes; profile: string; status: ConnectionStatus }) {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status={status}
      route={{ kind: "ssh", target: "liam@hermes" }}
      unsecure={false}
      username="liam"
      passwordSaved
      profile={profile}
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      memory={hermes.memory}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown({ s = server(), profile = "default", status = "connected" as ConnectionStatus, wait = true } = {}) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  render(<Shell hermes={hermes} profile={profile} status={status} />);
  await user.click(screen.getByRole("tab", { name: /Memory/ }));
  if (wait) await screen.findByRole("list", { name: "Agent notes entries" });
  return { s, hermes, user };
}

/** An entry's button in the list, named by its text (its name goes on with its character count). */
const named = (text: string | RegExp) => (typeof text === "string" ? new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : text);
const entry = (text: string | RegExp) => within(screen.getByRole("list", { name: /entries$/ })).getByRole("button", { name: named(text) });
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Entry in/ });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const learning = (s: FakeHermes, method?: string) => s.requests.filter((r) => (method ? r.method === method : r.method.startsWith("learning.")));

describe("Settings → Memory", () => {
  it("is a tab in Settings that names the server, profile and file it edits", async () => {
    const { user } = await shown();
    expect(screen.getByText("ssh://liam@hermes")).toBeTruthy();
    expect(screen.getByText("/home/liam/.hermes/memories/MEMORY.md")).toBeTruthy();
    const files = screen.getByRole("tablist", { name: "Memory files" });
    expect(within(files).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Agent notesMEMORY.md2 entries", "User profileUSER.md1 entry"]);
    expect(screen.getByRole("heading", { name: "When edits take effect" })).toBeTruthy();
    await user.click(within(files).getByRole("tab", { name: /User profile/ }));
    expect(screen.getByText("/home/liam/.hermes/memories/USER.md")).toBeTruthy();
    expect(entry(SAM)).toBeTruthy();
  });

  it("says it is reading, then shows the entries", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const frames = s.handlers["learning.frames"];
    s.handlers["learning.frames"] = (r) => void gate.then(() => frames(r));
    await shown({ s, wait: false });
    expect(screen.getByRole("status").textContent).toMatch(/Reading memory from Hermes/);
    release();
    expect(await screen.findByRole("button", { name: named(FALCON) })).toBeTruthy();
  });

  it("says when a file has no entries yet", async () => {
    const s = server();
    s.memory.default.profile = [];
    const { user } = await shown({ s });
    await user.click(screen.getByRole("tab", { name: /User profile/ }));
    expect(screen.getByText(/nothing in USER.md yet/)).toBeTruthy();
  });

  it("saves an edit only on Save, and says so once it reads back", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Owner prefers short answers.");
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(learning(s, "learning.edit")).toEqual([]);
    await user.click(button("Save"));
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved, and read back from Hermes. New chats on default start with it/);
    expect(s.memory.default.memory).toEqual([FALCON, "Owner prefers short answers."]);
    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(entry("Owner prefers short answers.")).toBeTruthy();
  });

  it("drops an edit on Cancel and writes nothing", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " Typo");
    await user.click(button("Cancel"));
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    expect(learning(s, "learning.edit")).toEqual([]);
    expect(s.memory.default.memory[1]).toBe(SHORT);
  });

  it("keeps the edit through Reload when the entry is unchanged on the server", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " Always.");
    s.memory.default.memory[0] = "Project Falcon uses Postgres 17.";
    await user.click(button(/Reload/));
    await screen.findByRole("button", { name: named("Project Falcon uses Postgres 17.") });
    expect(editor().value).toBe(`${SHORT} Always.`);
  });

  it("finds a conflict before saving, writes nothing, and keeps the owner's edit to copy or put back", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "My careful edit");
    // The agent rewrites the entry meanwhile.
    s.memory.default.memory[1] = "Owner wants detailed answers.";
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed on the server, or was removed, since you opened it. Nothing was saved/);
    expect(learning(s, "learning.edit")).toEqual([]);
    expect(s.memory.default.memory[1]).toBe("Owner wants detailed answers.");
    const kept = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit" });
    expect(kept.value).toBe("My careful edit");
    // The owner looks at what Hermes has now, and saves their text over it on purpose.
    await user.click(entry("Owner wants detailed answers."));
    await user.click(button(/Put your kept edit in this entry/));
    await user.type(editor(), ", merged");
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory[1]).toBe("My careful edit, merged");
    expect(screen.queryByRole("textbox", { name: "Your kept edit" })).toBeNull();
  });

  it("keeps typing done after a save whose answer was lost, when Reload shows Hermes has the save", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "First version");
    s.dropOnLearning = "applied";
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/may or may not have saved/);
    await user.type(editor(), " and more");
    await act(async () => void (await hermes.reconnect()));
    await user.click(button(/Reload/));
    expect((await screen.findByRole("status")).textContent).toMatch(/Hermes has the edit you saved.*What you typed since is still here/);
    expect(s.memory.default.memory[1]).toBe("First version");
    expect(editor().value).toBe("First version and more");
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("settles a lost save without moving another entry's draft onto it", async () => {
    const { s, hermes, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Saved A");
    s.dropOnLearning = "applied";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.click(button("Cancel"));
    await user.click(entry(FALCON));
    await user.type(editor(), " Draft B");
    await user.click(button(/Reload/));
    expect((await screen.findByRole("status")).textContent).toMatch(/Hermes has the edit whose answer was lost/);
    expect(editor().value).toBe(`${FALCON} Draft B`);
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: named(FALCON) }).getAttribute("aria-current")).toBe("true");
    expect(s.memory.default.memory).toEqual([FALCON, "Saved A"]);
  });

  it("keeps the draft a kept edit replaces in the editor", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed it";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry(FALCON));
    await user.type(editor(), " Draft B");
    await user.click(button(/Put your kept edit in this entry/));
    expect(editor().value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 1" }).value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 2" }).value).toBe(`${FALCON} Draft B`);
  });

  it("drops a pending question about opening another file once a save starts", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const edit = s.handlers["learning.edit"];
    s.handlers["learning.edit"] = (r) => void gate.then(() => edit(r));
    const { user } = await shown({ s });
    await user.click(entry(SHORT));
    await user.type(editor(), " Saved.");
    await user.click(screen.getByRole("tab", { name: /User profile/ }));
    expect(screen.getByRole("alertdialog", { name: "Discard your edit?" })).toBeTruthy();
    await user.click(button("Save"));
    expect(screen.queryByRole("alertdialog", { name: "Discard your edit?" })).toBeNull();
    release();
    await screen.findByText(/Saved, and read back/);
    expect(screen.getByRole("tab", { name: /Agent notes/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
  });

  it("settles a lost save only in the file it was for, though the other file has the same text", async () => {
    const s = server();
    s.memory.default.profile = [SAM, "Same words in both files"];
    const { hermes, user } = await shown({ s });
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Same words in both files");
    s.dropOnLearning = "lost";
    await user.click(button("Save"));
    await screen.findByText(/may or may not have saved/);
    await act(async () => void (await hermes.reconnect()));
    await user.type(editor(), " and more");
    await user.click(button(/Reload/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes doesn't have your edit/);
    expect(screen.getByRole("tab", { name: /Agent notes/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("group", { name: /Edit entry in MEMORY.md/ })).toBeTruthy();
    expect(editor().value).toBe("Same words in both files and more");
    expect(s.memory.default.memory[1]).toBe(SHORT);
    expect(s.memory.default.profile).toEqual([SAM, "Same words in both files"]);
  });

  it("still settles a kept edit put in an entry after a Reload", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed it";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry("Agent changed it"));
    await user.click(button(/Put your kept edit in this entry/));
    await user.type(editor(), ", merged");
    await user.click(button(/Reload/));
    await waitFor(() => expect(button(/Reload/)).toHaveProperty("disabled", false));
    await user.click(button("Save"));
    await screen.findByText(/Saved, and read back/);
    expect(s.memory.default.memory[1]).toBe("Edit A, merged");
    expect(screen.queryByRole("textbox", { name: /Your kept edit/ })).toBeNull();
  });

  it("keeps every edit a conflict leaves, not only the latest", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.clear(editor());
    await user.type(editor(), "Edit A");
    s.memory.default.memory[1] = "Agent changed B";
    await user.click(button("Save"));
    await screen.findByRole("textbox", { name: "Your kept edit" });
    await user.click(entry(FALCON));
    await user.clear(editor());
    await user.type(editor(), "Edit C");
    s.memory.default.memory[0] = "Agent changed D";
    await user.click(button("Save"));
    expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 1" })).value).toBe("Edit A");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your kept edit 2" }).value).toBe("Edit C");
    expect(s.memory.default.memory).toEqual(["Agent changed D", "Agent changed B"]);
  });

  it("holds the open entry and file still while a save is under way", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const edit = s.handlers["learning.edit"];
    s.handlers["learning.edit"] = (r) => void gate.then(() => edit(r));
    const { user } = await shown({ s });
    await user.click(entry(SHORT));
    await user.type(editor(), " Saved later.");
    await user.click(button("Save"));
    await waitFor(() => expect(s.requests.some((r) => r.method === "learning.edit")).toBe(true));
    expect(screen.getByRole("tab", { name: /User profile/ })).toHaveProperty("disabled", true);
    expect(entry(FALCON)).toHaveProperty("disabled", true);
    release();
    await screen.findByText(/Saved, and read back/);
    expect(screen.getByRole("tab", { name: /Agent notes/ }).getAttribute("aria-selected")).toBe("true");
    expect(editor().value).toBe(`${SHORT} Saved later.`);
    expect(screen.getByRole("tab", { name: /User profile/ })).toHaveProperty("disabled", false);
  });

  it("keeps the edit when Hermes refuses the save, with Hermes's reason", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.click(editor());
    await user.paste("x".repeat(2300));
    await user.click(button("Save"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes didn't save it: Replacement would put memory at .*\/2,200 chars.*Your edit is still here/);
    expect(editor().value).toContain("x".repeat(2300));
    expect(s.memory.default.memory[1]).toBe(SHORT);
  });

  it("won't save an entry with a separator line in it", async () => {
    const { s, user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), "{enter}§{enter}second");
    expect(screen.getByText(/saved as several entries/)).toBeTruthy();
    expect(button("Save")).toHaveProperty("disabled", true);
    expect(learning(s, "learning.edit")).toEqual([]);
  });

  it("asks before opening another entry over an unsaved edit", async () => {
    const { user } = await shown();
    await user.click(entry(SHORT));
    await user.type(editor(), " More.");
    await user.click(entry(FALCON));
    const ask = screen.getByRole("alertdialog", { name: "Discard your edit?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} More.`);
    await user.click(entry(FALCON));
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard your edit?" })).getByRole("button", { name: "Discard edit" }));
    expect(editor().value).toBe(FALCON);
  });

  it("removes an entry after asking, and reads back that it's gone", async () => {
    const { s, user } = await shown();
    await user.click(screen.getByRole("tab", { name: /User profile/ }));
    await user.click(entry(SAM));
    await user.click(button("Delete"));
    await user.click(within(screen.getByRole("alertdialog", { name: "Remove this entry?" })).getByRole("button", { name: "Remove entry" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Removed, and read back/);
    expect(s.memory.default.profile).toEqual([]);
  });

  it("shows memory text as plain text, never as markup", async () => {
    const s = server();
    s.memory.default.memory = ['<img src=x onerror="alert(1)"> **not bold** [link](javascript:alert(1))'];
    const { user } = await shown({ s });
    expect(document.querySelector(".memory-entries img, .memory-entries a, .memory-entries strong")).toBeNull();
    await user.click(entry(/<img src=x/));
    expect(editor().value).toBe('<img src=x onerror="alert(1)"> **not bold** [link](javascript:alert(1))');
  });
});

describe("Settings → Memory states", () => {
  it("won't show or edit another profile's memory, as Hermes's calls reach only the dashboard's own", async () => {
    const { s } = await shown({ profile: "research", wait: false });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/This profile's memory can't be edited here/);
    expect(alert.textContent).toMatch(/runs as, which is default. The research profile's memory can't be read or changed/);
    expect(screen.queryByRole("list", { name: /entries$/ })).toBeNull();
    expect(learning(s)).toEqual([]);
  });

  it("says when the server has no memory editing calls", async () => {
    const s = server();
    s.learningMethods = false;
    await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/This Hermes server can't edit memory.*Updating Hermes adds them/);
  });

  it("says when Hermes refuses for lack of permission", async () => {
    const s = server();
    s.handlers["learning.frames"] = (r) => s.fail(r.id, 5000, "learning.frames failed: [Errno 13] Permission denied: '/home/liam/.hermes/memories/MEMORY.md'");
    await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes refused.*Permission denied/);
  });

  it("says when it couldn't read, and tries again", async () => {
    const s = server();
    const frames = s.handlers["learning.frames"];
    s.handlers["learning.frames"] = (r) => s.fail(r.id, 5000, "learning.frames failed: disk I/O error");
    const { user } = await shown({ s, wait: false });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't read memory.*disk I\/O error/);
    s.handlers["learning.frames"] = frames;
    await user.click(button(/Try again/));
    expect(await screen.findByRole("button", { name: named(FALCON) })).toBeTruthy();
  });

  it("waits for a connection before reading", async () => {
    const { s } = await shown({ status: "offline", wait: false });
    expect(screen.getByRole("status").textContent).toMatch(/Not connected to Hermes/);
    expect(learning(s)).toEqual([]);
  });
});

// The app around it: leaving Settings, opening a chat or switching profile with an unsaved edit asks first.
let launches = 0;
async function launchApp({ openChat = false } = {}) {
  const s = server();
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-mem-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  if (openChat) {
    await user.click(screen.getByText("Nightly backup"));
    await act(async () => void (await hermes.idle()));
  }
  await user.click(screen.getByRole("button", { name: /Settings/ }));
  await user.click(screen.getByRole("tab", { name: /Memory/ }));
  await screen.findByRole("list", { name: "Agent notes entries" });
  await user.click(entry(SHORT));
  await user.type(editor(), " Unsaved words.");
  return { s, hermes, user };
}

const leaveDialog = () => screen.getByRole("alertdialog", { name: "Discard your memory edit?" });

describe("An unsaved memory edit in the app", () => {
  it("asks before Back to chat, and stays on Keep editing", async () => {
    const { user } = await launchApp();
    await user.click(button(/Back to chat/));
    expect(within(leaveDialog()).getByText(/isn't saved to Hermes/)).toBeTruthy();
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    await user.click(button(/Back to chat/));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("asks before another Settings tab", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByRole("tab", { name: /General/ }));
    expect(leaveDialog()).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("tab", { name: /Memory/ }).getAttribute("aria-selected")).toBe("true");
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("asks before opening a chat from the list", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByText("Nightly backup"));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("asks before switching profile, and switches nothing on Keep editing", async () => {
    const { hermes, user } = await launchApp();
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /research/ }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Keep editing" }));
    expect(hermes.getSnapshot().profile).toBe("default");
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("stays in Settings when the chat behind it leaves the list meanwhile", async () => {
    const { hermes, user } = await launchApp({ openChat: true });
    // Archiving the chat on screen moves its pane to a New chat, which would close Settings.
    await user.click(screen.getAllByRole("button", { name: /^Archive:/ })[0]);
    await act(async () => void (await hermes.idle()));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
  });

  it("doesn't ask on Ctrl+\\, which leaves Settings open, and still asks on leaving after it", async () => {
    const { user } = await launchApp({ openChat: true });
    await user.keyboard("{Control>}\\{/Control}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editor().value).toBe(`${SHORT} Unsaved words.`);
    await user.type(editor(), " More.");
    await user.click(button(/Back to chat/));
    expect(leaveDialog()).toBeTruthy();
  });

  it("drops the edit on Discard even when Settings stays open", async () => {
    const { user } = await launchApp();
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(within(leaveDialog()).getByRole("button", { name: "Discard edit" }));
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await screen.findByRole("list", { name: "Agent notes entries" });
    expect(screen.queryByRole("textbox", { name: /Entry in/ })).toBeNull();
    await user.click(button(/Back to chat/));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes Settings as before when there's no unsaved edit", async () => {
    const { user } = await launchApp();
    await user.click(button("Cancel"));
    await user.click(screen.getByText("Nightly backup"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });
});
