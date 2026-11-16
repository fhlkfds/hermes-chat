// @vitest-environment jsdom
// Standing missions (ADR 0187): setting a chat's goal with a check, reading it back, the goal bar's updates, Pause,
// Resume and Clear, and the capability check, against FakeHermes with the shapes Hermes has at `bf0203a`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";
import { controlOf, draftProblem, goalArg, readBackProblem, setGoal, type Control, type GoalDraft } from "./goals";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

async function opened(server = new FakeHermes()) {
  server.sessions = [row("release", 1, { title: "Release 2.4" })];
  server.transcripts = { release: [{ role: "user", text: "Get 2.4 out" }, { role: "assistant", text: "On it." }] };
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  running.push(hermes);
  await hermes.sync();
  await hermes.open("release");
  await hermes.capabilities.refresh();
  const runtime = server.runtimeIdOf("release")!;
  return { server, hermes, runtime, goal: () => hermes.goals.get("release")?.goal, chat: () => hermes.getSnapshot().chats.find((c) => c.id === "release")! };
}

const DRAFT: GoalDraft = { outcome: "Ship  release 2.4\nto the stable channel", mustNot: "the public\nAPI", check: "  npm test  " };

/** Ends the running turn as Hermes does, and waits for the goal's update to arrive. */
async function finishTurn(server: FakeHermes, hermes: Hermes, runtime: string) {
  server.event(runtime, "message.start");
  server.event(runtime, "message.complete", { text: "Done a step.", status: "complete" });
  await new Promise((r) => setTimeout(r, 5));
  await hermes.idle();
}

describe("the goal Set a goal sends", () => {
  it("is one /goal line per field, behind -- so a control word can start the outcome", () => {
    expect(goalArg(DRAFT)).toBe("-- Ship release 2.4 to the stable channel\nmust not: the public API");
    expect(goalArg({ outcome: "pause the cron", mustNot: "", check: "" })).toBe("-- pause the cron");
  });

  it("refuses an outcome Hermes would read as a contract line, and a check of more than one line", () => {
    expect(draftProblem({ outcome: " ", mustNot: "", check: "" })).toBe("Say what done looks like.");
    expect(draftProblem({ outcome: "Scope: the docs", mustNot: "", check: "" })).toMatch(/“Scope:” at the start/);
    expect(draftProblem({ outcome: "Release: 2.4", mustNot: "", check: "" })).toBeUndefined();
    expect(draftProblem({ outcome: "x", mustNot: "", check: "a\nb" })).toBe("The check has to be one line.");
  });
});

describe("Setting a goal", () => {
  it("sends /goal, then the check, reads it back, and only then sends the turn that starts it", async () => {
    const { server, hermes, runtime, goal, chat } = await opened();
    const seen = (await hermes.readGoal("release")).revision;
    expect(seen).toBe("");
    const before = server.requests.length;

    await hermes.setGoal("release", DRAFT, seen);

    expect(server.requests.slice(before).map((r) => [r.method, r.params])).toEqual([
      ["session.control.read", { session_id: runtime }],
      ["command.dispatch", { name: "goal", arg: "-- Ship release 2.4 to the stable channel\nmust not: the public API", session_id: runtime }],
      ["command.dispatch", { name: "goal", arg: "gate add npm test", session_id: runtime }],
      ["session.control.read", { session_id: runtime }],
      ["prompt.submit", expect.objectContaining({ session_id: runtime, text: "Ship release 2.4 to the stable channel" })],
    ]);
    expect(goal()).toMatchObject({
      title: "Ship release 2.4 to the stable channel",
      status: "active",
      turnsUsed: 0,
      maxTurns: 20,
      contract: { constraints: "the public API", outcome: "" },
      checks: [{ command: "npm test", timeoutSeconds: 300, maxRetries: 3, attempts: 0, lastExitCode: null }],
    });
    expect(chat().items.at(-1)).toMatchObject({ kind: "user", text: "Ship release 2.4 to the stable channel" });
  });

  it("is refused, with nothing sent, when the goal changed since the owner looked", async () => {
    const { server, hermes } = await opened();
    const seen = (await hermes.readGoal("release")).revision;
    server.goals.command(server.runtime.get(server.runtimeIdOf("release")!)!, "-- Someone else's goal");
    const before = server.requests.length;
    await expect(hermes.setGoal("release", DRAFT, seen)).rejects.toThrow(/changed since you opened Set a goal/);
    expect(server.requests.slice(before).map((r) => r.method)).toEqual(["session.control.read"]);
    expect(hermes.goals.get("release")?.goal?.title).toBe("Someone else's goal");
  });

  it("starts nothing when the read back isn't what was sent", async () => {
    const server = new FakeHermes();
    const command = server.goals.command.bind(server.goals);
    // A Hermes that keeps the check otherwise than as typed.
    server.goals.command = (stored, arg) => command(stored, arg.replace("npm test", "npm test --bail"));
    const { hermes } = await opened(server);
    const seen = (await hermes.readGoal("release")).revision;
    await expect(hermes.setGoal("release", DRAFT, seen)).rejects.toThrow("Hermes saved the check as “npm test --bail”, not as you wrote it. Nothing was started.");
    expect(server.last("prompt.submit")).toBeUndefined();
    expect(hermes.goals.get("release")?.goal?.checks[0].command).toBe("npm test --bail");
  });

  it("starts nothing when Hermes refuses the check, and shows the goal it did set", async () => {
    const server = new FakeHermes();
    const command = server.goals.command.bind(server.goals);
    server.goals.command = (stored, arg) => (arg.startsWith("gate") ? { error: { code: 4004, message: "/goal gate add: no active goal" } } : command(stored, arg));
    const { hermes, goal } = await opened(server);
    await expect(hermes.setGoal("release", DRAFT, "")).rejects.toThrow("Hermes set the goal but didn't add its check: /goal gate add: no active goal. Nothing was started.");
    expect(server.last("prompt.submit")).toBeUndefined();
    expect(goal()?.checks).toEqual([]);
  });

  it("is refused, with nothing sent, while a reply runs or where /goal isn't Hermes's own", async () => {
    const { server, hermes, runtime } = await opened();
    server.event(runtime, "message.start");
    await hermes.idle();
    await expect(hermes.setGoal("release", DRAFT, "")).rejects.toThrow("A reply is running. Set the goal once it ends.");

    const quick = new FakeHermes();
    quick.quickCommands = { goal: "exec: ./ship.sh" };
    const b = await opened(quick);
    await expect(b.hermes.setGoal("release", DRAFT, "")).rejects.toThrow(/can't run goals here/);
    expect([server, quick].flatMap((s) => s.requests).some((r) => r.method === "command.dispatch")).toBe(false);
  });

  it("writes nothing once a reply starts after the goal was read", async () => {
    const calls: string[] = [];
    const rpc = async (method: string) => {
      calls.push(method);
      return { control: { goal: null, revision: "" } };
    };
    let reads = 0;
    const refusal = () => (reads++ ? "A reply is running. Set the goal once it ends." : undefined);
    await expect(setGoal(rpc, "rt", DRAFT, "", refusal)).rejects.toThrow("A reply is running. Set the goal once it ends. Nothing was saved.");
    expect(calls).toEqual(["session.control.read"]);
  });

  it("reads back a goal with no check as having none", () => {
    const control = controlOf({ control: { goal: { title: "x", status: "active", turns_used: 0, max_turns: 20, contract: {}, subgoals: [], gates: [] }, revision: "r" } })!;
    expect(readBackProblem(control, { outcome: "x", mustNot: "", check: "" })).toBeUndefined();
    expect(readBackProblem(control, { outcome: "x", mustNot: "", check: "true" })).toBe("Hermes saved the goal without its check.");
  });
});

describe("The goal bar's goal", () => {
  it("reaches done once the check passes and the judge agrees", async () => {
    const { server, hermes, runtime, goal } = await opened();
    await hermes.setGoal("release", DRAFT, "");
    await finishTurn(server, hermes, runtime);
    expect(goal()).toMatchObject({ status: "done", turnsUsed: 1, lastVerdict: "done", checks: [{ lastExitCode: 0, attempts: 0 }] });
  });

  it("keeps running on a failing check until the third retry, and the fourth failure pauses it, saying why", async () => {
    const { server, hermes, runtime, goal } = await opened();
    const continued: string[] = [];
    server.goalTurn = (_sid, prompt) => continued.push(prompt);
    await hermes.setGoal("release", { ...DRAFT, check: "npm test || false" }, "");
    for (const attempt of [1, 2, 3]) {
      await finishTurn(server, hermes, runtime);
      expect(goal()).toMatchObject({ status: "active", turnsUsed: attempt, checks: [{ lastExitCode: 1, attempts: attempt }] });
    }
    expect(continued).toHaveLength(3);
    await finishTurn(server, hermes, runtime);
    expect(goal()).toMatchObject({ status: "paused", pausedReason: "quality gate exhausted 3 retries: $ npm test || false", checks: [{ attempts: 4 }] });
    expect(continued).toHaveLength(3);
  });

  it("pauses, resumes with the turn Hermes asks for, and clears, each read back", async () => {
    const { server, hermes, runtime, goal } = await opened();
    await hermes.setGoal("release", DRAFT, "");
    await hermes.controlGoal("release", "goal.pause");
    expect(goal()).toMatchObject({ status: "paused", pausedReason: "user-paused" });
    expect(server.last("session.control")?.params).toEqual({ session_id: runtime, action: "goal.pause" });
    expect(server.last("session.control.read")?.params).toEqual({ session_id: runtime });

    const sent = server.requests.filter((r) => r.method === "prompt.submit").length;
    await hermes.controlGoal("release", "goal.resume");
    expect(goal()?.status).toBe("active");
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(sent + 1);
    expect(server.last("prompt.submit")?.params.text).toBe("[Continuing toward your standing goal] Ship release 2.4 to the stable channel");

    await hermes.controlGoal("release", "goal.clear");
    expect(hermes.goals.get("release")).toEqual({ goal: null, revision: "" });
  });

  it("sends no Pause, Resume or Clear after a reconnect until /goal is found Hermes's own again", async () => {
    const { server, hermes } = await opened();
    await hermes.setGoal("release", DRAFT, "");
    server.drop();
    await vi.waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
    await hermes.open("release");
    expect(hermes.capabilities.get("standingMissions").state).toBe("unknown");
    for (const action of ["goal.pause", "goal.resume", "goal.clear"] as const)
      await expect(hermes.controlGoal("release", action)).rejects.toThrow("Checking that /goal is Hermes's own on this connection… Nothing was sent.");
    expect(server.requests.some((r) => r.method === "session.control")).toBe(false);
    await hermes.capabilities.refresh();
    await hermes.controlGoal("release", "goal.pause");
    expect(hermes.goals.get("release")?.goal?.status).toBe("paused");
  });

  it("follows session.control.update from another client, and reads again after a reconnect", async () => {
    const { server, hermes, runtime, goal } = await opened();
    const stored = server.runtime.get(runtime)!;
    server.goals.command(stored, "-- Set in the TUI");
    server.event(runtime, "session.control.update", { control: server.goals.control(stored) });
    await hermes.idle();
    expect(goal()?.title).toBe("Set in the TUI");

    server.goals.action(stored, "goal.pause");
    server.drop();
    expect(hermes.getSnapshot().status).not.toBe("connected");
    await vi.waitFor(() => expect(hermes.getSnapshot().status).toBe("connected"), { timeout: 5_000 });
    await hermes.open("release");
    await hermes.readGoal("release");
    expect(goal()?.status).toBe("paused");
  });
});

describe("Reading Hermes's snapshot", () => {
  it("takes each field the bar shows, and nothing it can't read", () => {
    const control = controlOf({
      control: {
        goal: {
          title: "Green CI",
          status: "paused",
          turns_used: 4,
          max_turns: 20,
          contract: { outcome: "", verification: "", constraints: "no force-push", boundaries: "", stop_when: "" },
          subgoals: ["lint passes"],
          gates: [{ command: "npm test", timeout_seconds: 300, max_retries: 3, attempts: 2, last_exit_code: 1 }],
          paused_reason: "user-paused",
          last_verdict: "continue",
          last_reason: "Two tests still fail.",
          wait_barrier: { type: "until", until_at: 1_800_000_000, reason: "CI is running" },
        },
        loop: null,
        heartbeat: null,
        revision: "abc",
      },
    });
    expect(control).toEqual<Control>({
      revision: "abc",
      goal: {
        title: "Green CI",
        status: "paused",
        turnsUsed: 4,
        maxTurns: 20,
        contract: { outcome: "", verification: "", constraints: "no force-push", boundaries: "", stop_when: "" },
        subgoals: ["lint passes"],
        checks: [{ command: "npm test", timeoutSeconds: 300, maxRetries: 3, attempts: 2, lastExitCode: 1 }],
        pausedReason: "user-paused",
        lastVerdict: "continue",
        lastReason: "Two tests still fail.",
        waitBarrier: { kind: "until", until: 1_800_000_000_000, reason: "CI is running" },
      },
    });
    expect(controlOf({ control: { goal: { title: "x", status: "cleared" }, revision: "r" } })).toBeUndefined();
    expect(controlOf({ control: { goal: null, revision: "" } })).toEqual({ goal: null, revision: "" });
    expect(controlOf({})).toBeUndefined();
  });
});

describe("The standing missions check", () => {
  it("finds the method by Hermes's refusal of a made-up chat, and /goal its own", async () => {
    const { server, hermes } = await opened();
    await hermes.capabilities.refresh();
    expect(hermes.capabilities.get("standingMissions")).toMatchObject({ state: "supported", why: expect.stringMatching(/\/goal is its own command/) });
    expect(server.requests.find((r) => r.method === "session.control.read" && r.params.session_id === "__hermes_chat_probe__")).toBeDefined();
  });

  it("is not supported on a Hermes without session.control, or where a quick command takes /goal", async () => {
    const old = new FakeHermes();
    old.standingMissions = false;
    const a = await opened(old);
    await a.hermes.capabilities.refresh();
    expect(a.hermes.capabilities.get("standingMissions")).toMatchObject({ state: "unsupported", why: "Hermes has no such method." });

    const quick = new FakeHermes();
    quick.quickCommands = { goal: "exec: ./ship.sh" };
    const b = await opened(quick);
    await b.hermes.capabilities.refresh();
    expect(b.hermes.capabilities.get("standingMissions")).toMatchObject({ state: "unsupported", why: expect.stringMatching(/quick or plugin command called \/goal/) });
    // Pause, Resume and Clear would run the quick command too, so they go nowhere.
    await expect(b.hermes.controlGoal("release", "goal.pause")).rejects.toThrow(/can't run goals here.*quick or plugin command called \/goal.*Nothing was sent/);
  });

  it("reads the profile's turn budget", async () => {
    const server = new FakeHermes();
    server.goals.maxTurns = 35;
    const { hermes } = await opened(server);
    expect(await hermes.goalBudget()).toBe(35);
  });
});
