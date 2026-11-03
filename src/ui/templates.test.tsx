// @vitest-environment jsdom
// Templates in the running app, against a fake Hermes: making one, finding it by keyboard, filling it in with the
// whole message previewed, and inserting it, which never sends. A draft already there is replaced, added to, or left
// alone by Cancel. Edit, Duplicate, Delete, Import and Export, and templates offered only in one project.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { projectScope } from "../hermes/projectLinks";
import { EXPORT_FORMAT, TEMPLATES_MAX, type Template } from "../hermes/templates";
import { connect, type Hermes } from "../hermes/transport";
import { getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
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

async function launch(templates: Template[] = [], setup: (s: FakeHermes) => void = () => {}) {
  setUIPrefs({ templates });
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const connection = { mode: "ssh" as const, sshTarget: `liam@tpl-${++launches}`, url: "", username: "liam" };
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Nightly backup/ }));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "backup")?.runtimeId).toBeTruthy());
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user, scope: projectScope(connection, "default") };
}

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const dialog = () => screen.getByRole("dialog");
const options = () => within(screen.getByRole("listbox", { name: "Templates" })).queryAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");
const preview = () => screen.getByLabelText(/Message preview/);
const submitted = (s: FakeHermes) => s.requests.filter((r) => r.method === "prompt.submit");
const tpl = (name: string, body: string, extra: Partial<Template> = {}): Template => ({ id: `id-${name}`, name, description: "", body, ...extra });

const RESTART = tpl("Restart a service", "Restart {service} on {host=web-1}.{why...?}", { description: "systemctl restart, then check" });
const REVIEW = tpl("Review a diff", "Review this diff for bugs:\n{diff...}");

describe("A template", () => {
  it("is made in the library, picked by keyboard, filled in with a live preview, and inserted without sending", async () => {
    const { server, user } = await launch();
    await user.click(screen.getByRole("button", { name: "Templates" }));
    expect(within(dialog()).getByText(/No templates yet/)).toBeTruthy();

    await user.click(within(dialog()).getByRole("button", { name: "New" }));
    await user.type(screen.getByLabelText("Name"), "Check disk");
    await user.type(screen.getByLabelText("Description (optional)"), "df on a host");
    // `{` is a special key to user-event; `{{` types one.
    await user.type(screen.getByLabelText("Message"), "Run df -h on {{host} and summarise {{notes...?}");
    expect(within(dialog()).getByText(/Blanks:/).textContent).toMatch(/host \(required\).*notes \(optional\) multiline/);
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(within(dialog()).getByRole("status").textContent).toBe("Saved “Check disk”.");
    expect(getUIPrefs().templates).toMatchObject([{ name: "Check disk", description: "df on a host", body: "Run df -h on {host} and summarise {notes...?}" }]);

    // Enter on the search box uses the selected one.
    await user.keyboard("{Enter}");
    expect(preview().textContent).toBe("Run df -h on {host} and summarise ");
    expect(within(dialog()).getByRole("button", { name: "Insert" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog()).getByRole("status").textContent).toBe("Fill in host to insert.");
    await user.type(screen.getByLabelText(/^host/), "nas-01");
    await user.type(screen.getByLabelText(/^notes/), "Only /srv{Shift>}{Enter}{/Shift}and /var");
    expect(preview().textContent).toBe("Run df -h on nas-01 and summarise Only /srv\nand /var");
    await user.click(within(dialog()).getByRole("button", { name: "Insert" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe("Run df -h on nas-01 and summarise Only /srv\nand /var");
    expect(document.activeElement).toBe(composer());
    expect(submitted(server)).toEqual([]);
  });

  it("is found by search and arrow keys, and Escape steps back out without touching the draft", async () => {
    const { server, user } = await launch([RESTART, REVIEW, tpl("Rotate logs", "logrotate -f {conf}")]);
    await user.type(composer(), "keep me");
    await user.click(screen.getByRole("button", { name: "Templates" }));
    expect(options().map((o) => o.querySelector(".tpl-name")!.textContent)).toEqual(["Restart a service", "Review a diff", "Rotate logs"]);
    expect(selected()!.textContent).toMatch(/Restart a service/);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(selected()!.textContent).toMatch(/Rotate logs/);
    await user.keyboard("{Home}");
    expect(selected()!.textContent).toMatch(/Restart/);
    await user.type(screen.getByRole("combobox", { name: "Search templates" }), "diff bugs");
    expect(options()).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Review a diff" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("listbox", { name: "Templates" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe("keep me");
    expect(submitted(server)).toEqual([]);
  });
});

describe("Inserting over a draft", () => {
  async function fillRestart(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.keyboard("{Enter}");
    await user.type(screen.getByLabelText(/^service/), "nginx");
  }

  it("asks: Replace draft puts the message in its place", async () => {
    const { server, user } = await launch([RESTART]);
    await user.type(composer(), "an old draft");
    await fillRestart(user);
    expect(within(dialog()).getByText(/already has a draft/)).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Insert" })).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Replace draft" }));
    expect(composer().value).toBe("Restart nginx on web-1.");
    expect(submitted(server)).toEqual([]);
  });

  it("asks: Add after draft keeps the draft and adds the message after a blank line", async () => {
    const { server, user } = await launch([RESTART]);
    await user.type(composer(), "an old draft{Shift>}{Enter}{/Shift}");
    await fillRestart(user);
    await user.click(within(dialog()).getByRole("button", { name: "Add after draft" }));
    expect(composer().value).toBe("an old draft\n\nRestart nginx on web-1.");
    expect(submitted(server)).toEqual([]);
  });

  it("Cancel and Back leave the draft exactly as it was, and Ctrl+Enter doesn't pick for the owner", async () => {
    const { server, user } = await launch([RESTART]);
    await user.type(composer(), "  draft with spaces  ");
    await fillRestart(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Back" }));
    await user.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(composer().value).toBe("  draft with spaces  ");
    await fillRestart(user);
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe("  draft with spaces  ");
    expect(submitted(server)).toEqual([]);
  });
});

describe("The library", () => {
  it("edits, refusing a name already taken, and asks before dropping unsaved changes", async () => {
    const { user } = await launch([RESTART, REVIEW]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(within(dialog()).getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "review A DIFF");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already a template called “review A DIFF”/);
    await user.keyboard("{Escape}");
    expect(within(dialog()).getByText("Discard your changes to this template?")).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    await user.clear(name);
    await user.type(name, "Restart a unit");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(getUIPrefs().templates.map((t) => t.name)).toEqual(["Restart a unit", "Review a diff"]);
    expect(getUIPrefs().templates[0].id).toBe(RESTART.id);
  });

  it("keeps the editor and its text when another window filled the library meanwhile", async () => {
    const { user } = await launch([RESTART]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(within(dialog()).getByRole("button", { name: "New" }));
    await user.type(screen.getByLabelText("Name"), "One too many");
    await user.type(screen.getByLabelText("Message"), "hello");
    const full = Array.from({ length: TEMPLATES_MAX }, (_, i) => tpl(`T${i}`, "x"));
    act(() => void setUIPrefs({ templates: full }));
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/300 templates, the most kept.*your text stays here/);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("One too many");
    expect(getUIPrefs().templates).toHaveLength(TEMPLATES_MAX);
    expect(getUIPrefs().templates.some((t) => t.name === "One too many")).toBe(false);
  });

  it("fills a blank called constructor or __proto__ like any other", async () => {
    const { server, user } = await launch([tpl("Odd names", "{constructor} / {__proto__}")]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.keyboard("{Enter}");
    expect(preview().textContent).toBe("{constructor} / {__proto__}");
    await user.type(screen.getByLabelText(/^constructor/), "a");
    await user.type(screen.getByLabelText(/^__proto__/), "b");
    await user.click(within(dialog()).getByRole("button", { name: "Insert" }));
    expect(composer().value).toBe("a / b");
    expect(submitted(server)).toEqual([]);
  });

  it("duplicates under a free name, and deletes only after asking", async () => {
    const { user } = await launch([RESTART]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(within(dialog()).getByRole("button", { name: "Duplicate" }));
    expect(getUIPrefs().templates.map((t) => t.name)).toEqual(["Restart a service", "Restart a service (2)"]);
    expect(selected()!.textContent).toMatch(/\(2\)/);
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(within(dialog()).getByText(/Delete “Restart a service \(2\)”\?/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Keep" }));
    expect(getUIPrefs().templates).toHaveLength(2);
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(getUIPrefs().templates.map((t) => t.name)).toEqual(["Restart a service"]);
  });

  it("imports an export, renaming taken names and skipping malformed entries; a bad file changes nothing", async () => {
    const { user } = await launch([RESTART]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = (text: string) => new File([text], "templates.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [file("{oops")] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't import templates.json: .*isn't JSON/));
    expect(getUIPrefs().templates).toEqual([RESTART]);

    const good = { format: EXPORT_FORMAT, version: 1, templates: [{ name: "restart a SERVICE", body: "again {x}" }, { name: "Ünïcode ✓", description: "ok", body: "{名前}" }, { body: "no name" }, "junk"] };
    fireEvent.change(input, { target: { files: [file(JSON.stringify(good))] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Imported 2 templates\. Skipped 2 that weren't valid templates\. “restart a SERVICE” was already taken, so it's “restart a SERVICE \(2\)”\./));
    expect(getUIPrefs().templates.map((t) => t.name)).toEqual(["Restart a service", "restart a SERVICE (2)", "Ünïcode ✓"]);
  });

  it("exports every template through the Save dialog, without projects", async () => {
    const { user } = await launch([RESTART, tpl("Lab only", "x", { project: { scope: "s", id: "p", name: "Lab" } })]);
    await user.click(screen.getByRole("button", { name: "Templates" }));
    const calls: [string, Record<string, unknown>][] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push([cmd, args]);
        return "/home/liam/hermes-chat-templates.json";
      },
    };
    try {
      await user.click(within(dialog()).getByRole("button", { name: "Export…" }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Exported 2 templates to /home/liam/hermes-chat-templates.json. Projects aren't included."));
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
    expect(calls[0][0]).toBe("templates_export");
    expect(JSON.parse(calls[0][1].json as string).templates).toEqual([
      { name: "Restart a service", description: "systemctl restart, then check", body: RESTART.body },
      { name: "Lab only", description: "", body: "x" },
    ]);
  });

  it("doesn't give back a project scope that was removed while the template was open for editing", async () => {
    const { user, scope } = await launch();
    const scoped = tpl("Lab deploy", "deploy {what}", { project: { scope, id: "p_gone", name: "Lab" } });
    act(() => void setUIPrefs({ templates: [scoped] }));
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByRole("checkbox", { name: /Show 1 for other projects/ }));
    await user.click(within(dialog()).getByRole("button", { name: "Edit" }));
    // Meanwhile the project is deleted, which leaves the template offered everywhere.
    act(() => void setUIPrefs({ templates: [tpl("Lab deploy", "deploy {what}")] }));
    await user.type(screen.getByLabelText("Description (optional)"), "to the lab");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(getUIPrefs().templates).toEqual([tpl("Lab deploy", "deploy {what}", { description: "to the lab" })]);
  });

  it("offers a project's templates only in its chats, and can show the others", async () => {
    const lab = { id: "p_lab", slug: "lab", name: "Lab", primary_path: null, archived: false, created_at: 1, folders: [] };
    const { user, scope } = await launch([], (s) => {
      s.projects.default = [lab];
    });
    setUIPrefs({ templates: [RESTART, tpl("Lab deploy", "deploy {what}", { project: { scope, id: "p_lab", name: "Lab" } })] });
    await user.click(screen.getByRole("button", { name: "Templates" }));
    expect(options().map((o) => o.querySelector(".tpl-name")!.textContent)).toEqual(["Restart a service"]);
    await user.click(screen.getByRole("checkbox", { name: /Show 1 for other projects/ }));
    expect(options()).toHaveLength(2);
    expect(options()[0].textContent).toMatch(/Lab deploy.*Lab/);
  });
});
