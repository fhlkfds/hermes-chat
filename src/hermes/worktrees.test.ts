import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { folderName, removalBlockers, setupSummary, stepsToRun, type RemovalFacts, type WorktreeRecord } from "./worktrees";

const facts = (over: Partial<RemovalFacts> = {}): RemovalFacts => ({
  path: "/srv/app.worktrees/fix",
  blockers: [],
  files: [],
  ignored: [],
  unpushed: [],
  head: "a".repeat(40),
  branch: "fix",
  keepHead: false,
  stamp: "s",
  ...over,
});

describe("what stops a removal", () => {
  it("is nothing for a worktree no chat works in", () => {
    expect(removalBlockers(facts(), { chats: [], more: false })).toEqual([]);
  });

  it("is a chat Hermes has working in the folder, from any client, however quiet", () => {
    const b = removalBlockers(facts(), { chats: [{ id: "s1", title: "Fix login", archived: false }], more: false });
    expect(b.map((x) => x.kind)).toEqual(["hermes-chats"]);
    expect(b[0].message).toContain("“Fix login”");
  });

  it("isn't an archived chat alone", () => {
    expect(removalBlockers(facts(), { chats: [{ id: "s1", title: "Old", archived: true }], more: false })).toEqual([]);
  });

  it("is a Hermes that can't be asked: a chat working there can't be ruled out", () => {
    expect(removalBlockers(facts(), undefined).map((x) => x.kind)).toEqual(["hermes"]);
    expect(removalBlockers(facts(), new Error("offline"))[0].message).toContain("offline");
  });

  it("keeps the server's own blockers", () => {
    const b = removalBlockers(facts({ blockers: [{ kind: "protected", message: "It's protected." }] }), { chats: [], more: false });
    expect(b.map((x) => x.kind)).toEqual(["protected"]);
  });

  it("counts a page that was cut as chats working there", () => {
    expect(removalBlockers(facts(), { chats: [], more: true }).map((x) => x.kind)).toEqual(["hermes-chats"]);
  });
});

describe("setup", () => {
  const rec = (states: [string, string][]): WorktreeRecord =>
    ({ setup: states.map(([action, state], i) => ({ entry: `e${i}`, action, state, message: "" })) }) as unknown as WorktreeRecord;

  it("runs pending and failed steps, in order, and never one that's done or skipped", () => {
    expect(stepsToRun(rec([["copy", "done"], ["copy", "failed"], ["skip", "skipped"], ["link", "pending"]]))).toEqual([1, 3]);
  });

  it("counts only steps that do something", () => {
    const s = setupSummary(rec([["copy", "done"], ["copy", "failed"], ["skip", "skipped"], ["link", "pending"]]));
    expect([s.done, s.total, s.failed.length, s.pending]).toEqual([1, 3, 1, 1]);
  });
});

it("names the folder as the helper does", () => {
  expect(folderName("fix/login")).toBe("fix-login");
  expect(folderName("feature/ünï code..x")).toBe("feature-n-code..x");
  expect(folderName(".hidden-")).toBe("hidden");
});

describe("the chats Hermes has working in a folder", () => {
  const running: Hermes[] = [];
  afterEach(async () => void (await Promise.all(running.splice(0).map((h) => h.close()))));

  it("are the folder's and those under it, archived ones too, never a sibling's that shares its name", async () => {
    const s = new FakeHermes();
    s.sessions = [
      row("in", 1, { title: "In it", cwd: "/srv/app.worktrees/fix" }),
      row("below", 1, { title: "Below it", cwd: "/srv/app.worktrees/fix/src", archived: true }),
      row("sibling", 1, { title: "Sibling", cwd: "/srv/app.worktrees/fix-2" }),
      row("none", 1, { title: "No folder" }),
    ];
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    const got = await hermes.chatsIn("/srv/app.worktrees/fix");
    expect(got.chats.map((c) => [c.id, c.archived])).toEqual([
      ["in", false],
      ["below", true],
    ]);
    expect(got.more).toBe(false);
    const asked = s.restRequests.find((r) => r.query.has("cwd_prefix"))!;
    expect(asked.path).toBe("/api/sessions");
    expect(asked.query.get("archived")).toBe("include");
  });
});
