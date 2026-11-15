// @vitest-environment jsdom
// The files-changed chip under a reply and the Preview it opens (issue #601, ADR 0177), driven as the owner would,
// against a fake Hermes that keeps checkpoints as Hermes `bf0203a` does. Each test checks what is on screen and what
// reached Hermes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { inlineDiff } from "../hermes/fakeCheckpoints";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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

const FOLDER = "/srv/site";
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const pane = () => screen.getByRole("region", { name: "Preview" });
const file = (path: string) => within(pane()).getByRole("region", { name: path });
const restores = (server: FakeHermes) => server.requests.filter((r) => r.method === "rollback.restore").map((r) => r.params);
const chip = () => screen.queryByRole("button", { name: /files? changed/ });

/** Signed in, with "Site edits" open: a chat in `FOLDER` with checkpoints on. `setup` changes the fake Hermes first. */
async function open(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("site", 1, { pinned: true, title: "Site edits", cwd: FOLDER })];
  server.transcripts = { site: [] };
  server.serverDirs.add(FOLDER);
  server.checkpoints.on = true;
  server.userRowId = 500;
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Site edits/ }));
  await settle(hermes);
  return { server, hermes, user };
}

/** `open`, then a reply that edits two files: a.txt written, b.txt patched, after a write Hermes refused. */
async function edited(setup?: (s: FakeHermes) => void) {
  const s = await open(setup);
  await s.user.type(screen.getByPlaceholderText("Message Hermes"), "Please edit two files{Enter}");
  await waitFor(() => expect(screen.getByText("Done editing the files.")).toBeTruthy());
  await settle(s.hermes);
  return s;
}

async function preview(s: { user: ReturnType<typeof userEvent.setup>; hermes: Hermes }) {
  await s.user.click(await screen.findByRole("button", { name: /files? changed/ }));
  await settle(s.hermes);
  await within(pane()).findByRole("heading", { name: "Files this reply changed" });
}

describe("the files-changed chip", () => {
  it("counts the files a reply edited, and the Preview shows each one's diff from before the reply", async () => {
    const s = await edited();
    expect((await screen.findByRole("button", { name: /files? changed/ })).textContent).toBe("2 files changed");
    await preview(s);
    expect(within(pane()).getByText(/It can't undo databases, pushed commits, sent messages, or shell commands/)).toBeTruthy();
    expect(within(file("b.txt")).getByText("beta original")).toBeTruthy();
    expect(within(file("b.txt")).getByText("beta patched by the bot")).toBeTruthy();
    expect(within(file("a.txt")).getByText("alpha line two (by the bot)")).toBeTruthy();
    expect(within(pane()).queryByRole("region", { name: "notes.txt" })).toBeNull();
  });

  it("undoes one file: only it goes back, the read back confirms it, and the other still differs", async () => {
    const s = await edited();
    await preview(s);
    await s.user.click(within(file("b.txt")).getByRole("button", { name: "Undo this file" }));
    await settle(s.hermes);
    expect(await within(pane()).findByText("b.txt: restored.")).toBeTruthy();
    expect(s.server.serverFiles[`${FOLDER}/b.txt`]).toBe("beta original\n");
    expect(s.server.serverFiles[`${FOLDER}/a.txt`]).toBe("alpha line one\nalpha line two (by the bot)\n");
    await waitFor(() => expect(within(file("b.txt")).getByText("As it was before this reply: nothing to undo.")).toBeTruthy());
    expect(within(file("a.txt")).getByRole("button", { name: "Undo this file" })).toBeTruthy();
    expect(restores(s.server)).toEqual([expect.objectContaining({ file_path: "b.txt" })]);
  });

  it("Undo this turn names every file first, and leaves one edited by hand unchecked", async () => {
    const s = await edited();
    s.server.serverFiles[`${FOLDER}/a.txt`] = "alpha line one\nalpha line two (by the bot)\nand a line of mine\n";
    await preview(s);
    expect(within(file("a.txt")).getByText("Edited by hand since the bot's last change. Undo would overwrite those edits.")).toBeTruthy();
    await s.user.click(within(pane()).getByRole("button", { name: "Undo this turn" }));
    expect(within(pane()).getByRole("checkbox", { name: /a\.txt/ })).toHaveProperty("checked", false);
    expect(within(pane()).getByRole("checkbox", { name: /b\.txt/ })).toHaveProperty("checked", true);
    expect(restores(s.server)).toEqual([]);
    await s.user.click(within(pane()).getByRole("button", { name: "Restore 1 file" }));
    await settle(s.hermes);
    expect(await within(pane()).findByText("b.txt: restored.")).toBeTruthy();
    expect(s.server.serverFiles[`${FOLDER}/a.txt`]).toBe("alpha line one\nalpha line two (by the bot)\nand a line of mine\n");
    expect(restores(s.server).map((p) => p.file_path)).toEqual(["b.txt"]);
  });

  it("restores nothing when a file changed after the preview", async () => {
    const s = await edited();
    await preview(s);
    s.server.serverFiles[`${FOLDER}/b.txt`] = "beta, as the owner has it now\n";
    await s.user.click(within(file("b.txt")).getByRole("button", { name: "Undo this file" }));
    await settle(s.hermes);
    expect((await within(pane()).findByRole("alert")).textContent).toMatch(/changed since this preview, so nothing was restored/);
    expect(restores(s.server)).toEqual([]);
    expect(s.server.serverFiles[`${FOLDER}/b.txt`]).toBe("beta, as the owner has it now\n");
  });

  it("offers no undo for a file the reply created", async () => {
    const s = await edited((server) => {
      server.fileTurn = [{ tool: "write_file", path: "c.txt", content: "a file the bot created\n" }];
    });
    expect((await screen.findByRole("button", { name: /file changed/ })).textContent).toBe("1 file changed");
    await preview(s);
    expect(within(file("c.txt")).getByText("Created by this reply")).toBeTruthy();
    expect(within(file("c.txt")).queryByRole("button", { name: "Undo this file" })).toBeNull();
  });

  it("says when checkpoints are off, and how to turn them on", async () => {
    const s = await edited((server) => void (server.checkpoints.on = false));
    expect((await screen.findByRole("button", { name: /files changed/ })).textContent).toBe("2 files changed · checkpoints are off");
    await preview(s);
    expect(within(pane()).getByText(/Set checkpoints\.enabled: true in the profile's config\.yaml, then start a new chat/)).toBeTruthy();
    expect(within(pane()).queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("isn't shown on a Hermes without the checkpoint methods", async () => {
    const s = await edited((server) => void (server.rollbackMethods = false));
    await waitFor(() => expect(s.hermes.capabilities.get("checkpoints").state).toBe("unsupported"));
    await settle(s.hermes);
    expect(chip()).toBeNull();
  });

  it("isn't shown for a chat whose terminal runs in a container", async () => {
    const s = await edited((server) => server.checkpoints.containerChats.add("site"));
    await waitFor(() => expect(s.hermes.getSnapshot().chats.find((c) => c.id === "site")?.checkpoints?.container).toBe(true));
    expect(chip()).toBeNull();
  });

  it("shows for a reply in the chat's stored history", async () => {
    const at = 1_794_781_521;
    const before = "beta original\n";
    const after = "beta patched by the bot\n";
    await open((server) => {
      const args = { path: "b.txt", old_string: "beta original", new_string: "beta patched by the bot" };
      server.transcripts.site = [
        { role: "user", text: "Fix b", row_id: 1, timestamp: at + 0.4 },
        { role: "tool", name: "patch", tool_call_id: "c1", args, context: "b.txt", row_id: 2, timestamp: at + 0.9, content: '{"success": true}', display_metadata: { tool_result_metadata: { inline_diff: inlineDiff("b.txt", before, after) } } },
        { role: "assistant", text: "Fixed b.", row_id: 3, timestamp: at + 1.2 },
      ];
      server.serverFiles[`${FOLDER}/b.txt`] = before;
      server.checkpoints.take(FOLDER, "before patch");
      server.checkpoints.byFolder[FOLDER][0].timestamp = new Date(at * 1000).toISOString().replace(/\.000Z$/, "Z");
      server.serverFiles[`${FOLDER}/b.txt`] = after;
    });
    expect((await screen.findByRole("button", { name: /file changed/ })).textContent).toBe("1 file changed");
  });
});
