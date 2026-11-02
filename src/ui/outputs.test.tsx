// @vitest-environment jsdom
// Outputs in the running app, against a fake Hermes whose stored rows and `/api/fs/*` answer as the deployed `bf0203a`
// does: the files Hermes's tools wrote, for a chat, a project or the profile, and where each came from.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type TranscriptMessage } from "../hermes/fakeHermes";
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

const written = (path: string, bytes: number) => JSON.stringify({ bytes_written: bytes, dirs_created: false, resolved_path: path, files_modified: [path] });

/** A tool call and its stored result, as Hermes stores and `session.resume` projects them. */
function call(id: string, name: string, args: Record<string, unknown>, result: string, rowId: number): TranscriptMessage[] {
  return [
    { role: "assistant", text: "", row_id: rowId, timestamp: 1_790_000_000 + rowId, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", name, tool_call_id: id, args, context: String(args.path ?? ""), row_id: rowId + 1, timestamp: 1_790_000_000 + rowId, result },
  ];
}

const HOSTILE = "/srv/out/<img src=x onerror=alert(1)>‮gnp.html";

function server() {
  const s = new FakeHermes();
  s.sessions = [row("report", 1, { pinned: true, title: "Quarterly report" }), row("cats", 2, { pinned: true, title: "Cat pictures" })];
  s.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  s.transcripts.report = [
    { role: "user", text: "Write the report", row_id: 1, timestamp: 1_790_000_000 },
    ...call("w1", "write_file", { path: "/srv/out/report.md" }, written("/srv/out/report.md", 2048), 2),
    ...call("w2", "write_file", { path: "/srv/out/report.md" }, written("/srv/out/report.md", 4096), 4),
    ...call("t1", "terminal", { command: "touch /srv/out/made-by-shell.csv" }, JSON.stringify({ output: "", exit_code: 0 }), 6),
    ...call("w3", "write_file", { path: HOSTILE }, written(HOSTILE, 10), 8),
    { role: "assistant", text: "Done. Also see /srv/out/mentioned.pdf.", row_id: 10, timestamp: 1_790_000_010 },
  ];
  s.transcripts.cats = [
    { role: "user", text: "Draw a cat", row_id: 1, timestamp: 1_790_000_100 },
    ...call("i1", "image_generate", { prompt: "cat" }, JSON.stringify({ success: true, image: "/srv/img/cat.png" }), 2),
  ];
  s.serverFiles["/srv/out/report.md"] = "# Report\nv2";
  s.serverFiles["/srv/img/cat.png"] = "\x89PNG";
  return s;
}

let launches = 0;
async function launch(s = server()) {
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server: s, hermes, user: userEvent.setup() };
}

const shown = () => [...document.querySelectorAll(".out-table tbody tr")].map((tr) => tr.querySelector(".files-label")!.textContent);

async function openChat(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByText(title));
}

async function openOutputs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Outputs" }));
  await screen.findByRole("heading", { name: "Outputs" });
  await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).toBeNull());
}

describe("Outputs", () => {
  it("lists the open chat's files from tool results only, with versions, sizes and where each came from", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    expect(screen.getByRole("radio", { name: "This chat" }).getAttribute("aria-checked")).toBe("true");
    // The shell's file and the reply's mentioned path aren't Outputs.
    expect(shown()).toEqual(["<img src=x onerror=alert(1)>�gnp.html", "report.md", "report.md"]);
    expect(document.querySelector(".out-table img")).toBeNull();
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    expect(rows[1].textContent).toContain("Version 2 of 2");
    expect(rows[1].textContent).toContain("4 KB");
    expect(rows[2].textContent).toContain("Version 1 of 2");
    expect(rows[1].textContent).toContain("Quarterly report");
    expect(rows[1].textContent).toContain("Written by write_file");
    expect(rows[1].textContent).toContain("Not checked");
  });

  it("widens to every chat in the profile, searches and filters by type, and says when nothing matches", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("radio", { name: "All chats in default" }));
    await waitFor(() => expect(shown()).toContain("cat.png"));
    expect(shown()).toHaveLength(4);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "image");
    expect(shown()).toEqual(["cat.png"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "all");
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "quarterly");
    expect(shown()).toHaveLength(3);
    await user.clear(screen.getByRole("textbox", { name: /Search outputs/ }));
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "nothing-like-this");
    expect(screen.getByText("No outputs match.")).toBeTruthy();
  });

  it("checks on Refresh which files are still there, and marks a deleted one missing with why", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(document.querySelectorAll(".out-avail").length).toBe(3));
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    expect(rows[0].querySelector(".out-avail")!.textContent).toMatch(/^Missing.*deleted, moved or renamed/);
    expect(rows[1].querySelector(".out-avail")!.textContent).toBe("Available");
    // A missing file can't be previewed, and says why.
    const preview = within(rows[0] as HTMLElement).getByRole("button", { name: /^Preview/ }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    expect(preview.title).toBe("The file isn't at this path any more.");
  });

  it("opens a file in the preview pane beside Outputs", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Preview report.md" }));
    await waitFor(() => expect(document.querySelector(".preview-pane, aside.preview")?.textContent).toContain("report.md"));
    expect(screen.getByRole("heading", { name: "Outputs" })).toBeTruthy();
  });

  it("goes to the tool call that made a file, opening it", async () => {
    const { user } = await launch();
    await openChat(user, "Cat pictures");
    await openOutputs(user);
    await user.click(screen.getByRole("button", { name: "Go to the message that made cat.png" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Outputs" })).toBeNull());
    const tool = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-call="i1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.activeElement).toBe(tool));
    expect(tool.classList.contains("jumped")).toBe(true);
    expect(within(tool).getByRole("button", { name: /image_generate/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("adds a Server file to the chat by its path, and takes it out again", async () => {
    const s = server();
    s.serverFiles["/srv/out/made-by-shell.csv"] = "a,b";
    const { user } = await launch(s);
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    const box = screen.getByRole("textbox", { name: /Add a server file/ });
    await user.type(box, "/srv/out/nope.csv{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't add it/);
    await user.clear(box);
    await user.type(box, "/srv/out/made-by-shell.csv{Enter}");
    await waitFor(() => expect(shown()).toContain("made-by-shell.csv"));
    expect(screen.getByText(/Added by you/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Take made-by-shell.csv out of Outputs" }));
    expect(shown()).not.toContain("made-by-shell.csv");
  });

  it("drops what a profile's read finds once the owner switched to another profile meanwhile", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.rest["GET /api/sessions/report/messages"] = async () => {
      await gate;
      return { messages: [{ id: 9, role: "tool", tool_name: "write_file", tool_call_id: "late", content: written("/srv/out/late.md", 1) }] };
    };
    const { hermes, user } = await launch(s);
    await openChat(user, "Quarterly report");
    await user.click(screen.getByRole("button", { name: "Outputs" }));
    await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).not.toBeNull());
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await act(async () => {
      release();
      await hermes.idle();
    });
    // Outputs stays open, now for the work profile, which has no outputs.
    expect(screen.getByRole("heading", { name: "Outputs" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All chats in work" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).toBeNull());
    expect(document.body.textContent).not.toContain("late.md");
    expect(localStorage.getItem("hermes-chat.outputs") ?? "").not.toContain("late.md");
  });

  it("shows many outputs a page at a time", async () => {
    const s = server();
    s.transcripts.report = Array.from({ length: 250 }, (_, i) => call(`w${i}`, "write_file", { path: `/srv/many/f${i}.txt` }, written(`/srv/many/f${i}.txt`, i), i * 2 + 1)).flat();
    const { user } = await launch(s);
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    expect(shown()).toHaveLength(200);
    expect(screen.getByText(/Showing 200 of 250/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(shown()).toHaveLength(250);
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "f249.");
    expect(shown()).toEqual(["f249.txt"]);
  });
});
