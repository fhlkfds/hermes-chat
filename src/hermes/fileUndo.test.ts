// Undoing a reply's files against a fake Hermes that keeps checkpoints as Hermes `bf0203a` does (ADR 0177).
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { replyFiles, type UndoableFile } from "./fileChanges";
import { loadFiles, undoFiles, type FoundFiles } from "./fileUndo";
import { connect, type Hermes } from "./transport";

const FOLDER = "/srv/site";
const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** A chat in `FOLDER` whose one reply edited two files, with checkpoints on. */
async function edited(server = new FakeHermes()) {
  server.serverDirs.add(FOLDER);
  server.checkpoints.on = true;
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const id = await hermes.newChat(undefined, { folder: FOLDER });
  await hermes.send(id, "Please edit two files");
  await hermes.idle();
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const [reply] = replyFiles(chat().items, chat().folder);
  const io = hermes.rollbackIO(id);
  const load = () => loadFiles(io, reply, chat().items, chat().folder);
  return { server, hermes, id, chat, reply, io, load };
}

const found = async (view: Promise<unknown>) => {
  const v = (await view) as FoundFiles;
  expect(v.kind).toBe("found");
  return v;
};
const undoable = (v: FoundFiles, rel: string) => v.files.find((f): f is UndoableFile => f.state === "undoable" && f.rel === rel)!;
const restores = (server: FakeHermes) => server.requests.filter((r) => r.method === "rollback.restore").map((r) => r.params);

describe("a reply's file changes", () => {
  it("are the files the reply edited, not the one Hermes refused to write", async () => {
    const { reply } = await edited();
    expect(reply.paths).toEqual(["a.txt", "b.txt"]);
  });

  it("show the diff from the checkpoint before the reply", async () => {
    const { load } = await edited();
    const view = await found(load());
    expect(view.files.map((f) => [f.path, f.state])).toEqual([
      ["a.txt", "undoable"],
      ["b.txt", "undoable"],
    ]);
    expect(undoable(view, "b.txt").section).toContain("-beta original\n+beta patched by the bot");
    expect(undoable(view, "a.txt").section).toContain("+alpha line two (by the bot)");
    expect(view.files.every((f) => f.state === "undoable" && f.handEdit === "as-left" && !f.laterReply)).toBe(true);
  });

  it("undo one file at a time: only that file goes back, and the read back says so", async () => {
    const { server, load, io } = await edited();
    const view = await found(load());
    const report = await undoFiles(io, view, [undoable(view, "b.txt")]);
    expect(report).toMatchObject({ kind: "done", files: [{ outcome: "restored" }] });
    expect(server.serverFiles[`${FOLDER}/b.txt`]).toBe("beta original\n");
    expect(server.serverFiles[`${FOLDER}/a.txt`]).toBe("alpha line one\nalpha line two (by the bot)\n");
    const after = await found(load());
    expect(after.files.map((f) => [f.path, f.state])).toEqual([
      ["a.txt", "undoable"],
      ["b.txt", "unchanged"],
    ]);
    expect(restores(server)).toEqual([expect.objectContaining({ file_path: "b.txt" })]);
  });

  it("says a restore is unconfirmed when the file can't be read back, since a failed diff looks like an empty one", async () => {
    const { load, io } = await edited();
    const view = await found(load());
    let restored = false;
    const blind = { ...io, restoreFile: (h: string, f: Parameters<typeof io.restoreFile>[1]) => io.restoreFile(h, f).finally(() => (restored = true)), readText: (abs: string) => (restored ? Promise.resolve(undefined) : io.readText(abs)) };
    expect(await undoFiles(blind, view, [undoable(view, "b.txt")])).toMatchObject({ kind: "done", files: [{ outcome: "unconfirmed" }] });
  });

  it("restores nothing when the files changed since the preview", async () => {
    const { server, load, io } = await edited();
    const view = await found(load());
    server.serverFiles[`${FOLDER}/a.txt`] = "the owner's own text\n";
    expect(await undoFiles(io, view, [undoable(view, "b.txt")])).toEqual({ kind: "changed" });
    expect(restores(server)).toEqual([]);
    expect(server.serverFiles[`${FOLDER}/b.txt`]).toBe("beta patched by the bot\n");
  });

  it("warns of a hand edit since the bot's", async () => {
    const { server, load } = await edited();
    server.serverFiles[`${FOLDER}/a.txt`] = "alpha line one\nalpha line two (by the bot)\nand mine\n";
    expect(undoable(await found(load()), "a.txt").handEdit).toBe("edited");
  });

  it("stops at the first file Hermes doesn't restore, and says which weren't tried", async () => {
    const { load, io } = await edited();
    const view = await found(load());
    const missing: UndoableFile = { ...undoable(view, "a.txt"), rel: "gone.txt" as UndoableFile["rel"] };
    const report = await undoFiles(io, { ...view, shown: { ...view.shown, texts: new Map([...view.shown.texts, [missing.abs, view.shown.texts.get(missing.abs)]]) } }, [missing, undoable(view, "b.txt")]);
    expect(report).toMatchObject({ kind: "done", files: [{ outcome: "failed", error: expect.stringContaining("did not match any file") }, { outcome: "not-tried" }] });
  });

  it("offers no undo for a file the reply created", async () => {
    const server = new FakeHermes();
    server.fileTurn = [{ tool: "write_file", path: "c.txt", content: "a file the bot created\n" }];
    const { load } = await edited(server);
    expect((await found(load())).files).toEqual([expect.objectContaining({ path: "c.txt", state: "created" })]);
  });

  it("finds no checkpoint once Hermes has pruned it, and says checkpoints are off when they are", async () => {
    const { server, load } = await edited();
    server.checkpoints.byFolder[FOLDER] = [];
    expect(await load()).toEqual({ kind: "none" });
    server.checkpoints.on = false;
    expect(await load()).toEqual({ kind: "off" });
  });

  it("never asks Hermes for a whole-folder restore, which would drop the chat's newest message", async () => {
    const { server, load, io, id } = await edited();
    const view = await found(load());
    await undoFiles(io, view, view.files.filter((f): f is UndoableFile => f.state === "undoable"));
    expect(restores(server)).toHaveLength(2);
    expect(restores(server).every((p) => typeof p.file_path === "string" && p.file_path !== "")).toBe(true);
    expect(server.transcripts[id].some((m) => m.role === "user")).toBe(true);
  });
});

describe("the chat's checkpoints check", () => {
  it("finds a host terminal and the profile's setting, or a container", async () => {
    const { server, hermes, id, chat } = await edited();
    hermes.checkCheckpoints(id);
    await hermes.idle();
    expect(chat().checkpoints).toEqual({ runtimeId: chat().runtimeId, container: false, on: true });

    const other = await edited(server);
    server.checkpoints.containerChats.add(other.id);
    other.hermes.checkCheckpoints(other.id);
    await other.hermes.idle();
    expect(other.chat().checkpoints).toMatchObject({ container: true });
  });

  it("still finds a host terminal when the profile's config answers with a page that isn't JSON", async () => {
    const server = new FakeHermes();
    const openPipe = server.openPipe;
    // A proxy in front of the dashboard can answer with its own HTML page.
    server.openPipe = async (...args) => {
      const pipe = await openPipe(...args);
      const getLimited = pipe.getLimited.bind(pipe);
      pipe.getLimited = (q, max) => (q.startsWith("api/config") ? Promise.resolve("<html>Bad gateway</html>") : getLimited(q, max));
      return pipe;
    };
    const { hermes, id, chat } = await edited(server);
    hermes.checkCheckpoints(id);
    await hermes.idle();
    expect(chat().checkpoints).toEqual({ runtimeId: chat().runtimeId, container: false });
  });
});

describe("the checkpoints capability", () => {
  it("is there when Hermes has rollback.list, and says whether the profile has checkpoints on", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    await hermes.capabilities.refresh();
    expect(hermes.capabilities.get("checkpoints")).toMatchObject({ state: "supported", why: expect.stringContaining("Checkpoints are off for this profile") });
    server.checkpoints.on = true;
    await hermes.capabilities.refresh();
    expect(hermes.capabilities.get("checkpoints").why).toContain("Checkpoints are on for this profile.");
  });

  it("is missing on a Hermes without rollback.list", async () => {
    const server = new FakeHermes();
    server.rollbackMethods = false;
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    await hermes.capabilities.refresh();
    expect(hermes.capabilities.get("checkpoints").state).toBe("unsupported");
  });
});
