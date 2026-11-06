// @vitest-environment jsdom
// Clone a profile from the profile switcher, in the running app against a fake Hermes: what the dialog shows before
// anything is written, picking categories, the opt-in full copy and its warning, a taken name, a refusal, deleting a
// clone that didn't fully copy, and opening the clone only once it's read back. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
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
const HOME = "/home/liam/.hermes";

async function launch() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  server.souls = { default: "You are Hermes.\n", work: "You are Work, a terse release engineer.\n" };
  server.profileModel.default = { model: "anthropic/claude-sonnet-4.5", provider: "openrouter", reasoning_effort: "medium", fast: false };
  server.profileMeta.default = { description: "Everyday agent" };
  server.profileEnv.default = { OPENROUTER_API_KEY: "sk-or-synthetic-91" };
  server.memory.default = { memory: ["Ships on Fridays."], profile: [] };
  server.skills.add("default", { dir: `${HOME}/skills/release-notes`, source: "agent" }, "---\nname: release-notes\ndescription: Draft release notes\n---\n\n# Notes\n");
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-clone-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user: userEvent.setup() };
}

async function openClone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
  await user.click(await screen.findByRole("button", { name: "Clone a profile…" }));
  const dialog = await screen.findByRole("dialog", { name: "Clone a profile" });
  await within(dialog).findByRole("table", { name: "What the clone copies" });
  return dialog;
}

const rows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
const creates = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/profiles").map((r) => r.body);

describe("Clone a profile", () => {
  it("shows what each category copies, leaves API keys out by default, and opens the clone once it's read back", async () => {
    const { server, hermes, user } = await launch();
    const dialog = await openClone(user);
    expect(within(dialog).getByLabelText("New profile's name")).toHaveProperty("value", "default-copy");
    const table = within(dialog).getByRole("table", { name: "What the clone copies" });
    expect(rows(table)).toEqual([
      "Persona (SOUL.md)16 characters, as Hermes has it now",
      "Modelanthropic/claude-sonnet-4.5 (openrouter). Hermes checks it against its model list",
      "DescriptionEveryday agent",
      "Own skillsrelease-notes: SKILL.md only, the files beside it stay",
      "API keys and settingsNot copied: the clone starts with an empty .env and Hermes's default settings (toolsets, MCP servers, memory provider)",
      "MemoryNot copied: Hermes has no call that adds memory entries, so only the full copy has it",
      "Chats, scheduled jobs and messaging channelsNever copied",
    ]);
    await user.click(within(dialog).getByRole("checkbox", { name: "Copy Description" }));
    await user.click(within(dialog).getByRole("button", { name: "Clone" }));

    const done = await within(dialog).findByRole("table", { name: "What default-copy has" });
    expect(creates(server)).toEqual([{ name: "default-copy", soul: "You are Hermes.\n", provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }]);
    expect(server.profileEnv["default-copy"]).toEqual({});
    expect(server.memory["default-copy"]).toBeUndefined();
    expect(within(done).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "Persona (SOUL.md)SOUL.md reads back as the source's",
      "Modelanthropic/claude-sonnet-4.5 (openrouter)",
      "DescriptionNot picked",
      "Own skills1 copied, SKILL.md only",
      "API keys and settingsNot copied: add API keys for default-copy in Hermes, or with `hermes -p default-copy setup` on the server",
      "MemoryNot copied: Hermes has no call that adds memory entries",
      "Chats, scheduled jobs and messaging channelsNot copied",
    ]);
    expect(within(dialog).getByRole("list", { name: "Progress" }).textContent).toMatch(/Read default-copy back · done/);

    await user.click(within(dialog).getByRole("button", { name: "Open default-copy" }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "default-copy", status: "connected" }));
    expect(screen.queryByRole("dialog", { name: "Clone a profile" })).toBeNull();
  });

  it("copies API keys only when the full copy is turned on, and warns first", async () => {
    const { server, user } = await launch();
    const dialog = await openClone(user);
    expect(within(dialog).queryByRole("note")).toBeNull();
    await user.click(within(dialog).getByRole("checkbox", { name: /Also copy API keys/ }));
    expect(within(dialog).getByRole("note").textContent).toMatch(/gets the same API keys as default/);
    expect(within(dialog).queryByRole("checkbox", { name: "Copy Persona (SOUL.md)" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Clone with API keys" }));
    await within(dialog).findByRole("table", { name: "What default-copy has" });
    expect(creates(server)).toEqual([{ name: "default-copy", clone_from: "default", description: "Everyday agent" }]);
    expect(server.profileEnv["default-copy"]).toEqual({ OPENROUTER_API_KEY: "sk-or-synthetic-91" });
  });

  it("says a name is taken before anything is sent, and won't clone over it", async () => {
    const { server, user } = await launch();
    const dialog = await openClone(user);
    const name = within(dialog).getByLabelText("New profile's name");
    await user.clear(name);
    await user.type(name, "work");
    expect(within(dialog).getByRole("alert").textContent).toBe("There's already a profile named work. Pick another name: a clone never replaces a profile.");
    expect(within(dialog).getByRole("button", { name: "Clone" })).toHaveProperty("disabled", true);
    await user.type(name, "-2");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Clone" })).toHaveProperty("disabled", false);
    expect(creates(server)).toEqual([]);
  });

  it("shows Hermes's refusal, keeps the form, and creates nothing", async () => {
    const { server, user } = await launch();
    server.profileCreateError = `The dashboard answered 400: {"detail":"Profile name 'default-copy' is reserved."}`;
    const dialog = await openClone(user);
    await user.click(within(dialog).getByRole("button", { name: "Clone" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Hermes didn't create default-copy. Hermes said: Profile name 'default-copy' is reserved. Nothing was created; you can try again.",
    );
    expect(within(dialog).getByRole("button", { name: "Clone" })).toBeTruthy();
    expect(server.otherProfiles["default-copy"]).toBeUndefined();
  });

  it("says the clone isn't full when a part didn't copy, and deletes it when asked", async () => {
    const { server, user } = await launch();
    server.profileModelError = "Model was not found in this provider's model listing.";
    const dialog = await openClone(user);
    await user.click(within(dialog).getByRole("button", { name: "Clone" }));
    await within(dialog).findByRole("table", { name: "What default-copy has" });
    expect(within(dialog).getByText(/not everything above copied. It's not a full clone/)).toBeTruthy();
    expect(within(dialog).getByText(/Hermes didn't set it: Model was not found/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Delete default-copy" }));
    const ask = within(dialog).getByRole("alertdialog", { name: "Delete default-copy?" });
    await user.click(within(ask).getByRole("button", { name: "Delete default-copy" }));
    await within(dialog).findByText("default-copy was deleted from the server.");
    expect(server.otherProfiles["default-copy"]).toBeUndefined();
    expect(server.otherProfiles.work).toBeDefined();
  });
});
