import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import golden from "./kanbanRunsGolden.json";
import { KanbanApi, parseRuns } from "./kanban";
import { NOTHING_SENT, liveRun, previewOf, type RunAction, type RunOrder } from "./taskRuns";
import { connect, type Hermes } from "./transport";

const open: Hermes[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

describe("a task's runs, read from real answers", () => {
  const CHAT = "local-a182a60c90b9ee95fad76affb0c5ce2ab37e0dea778d9b39dab8bc4c9dbadf6b";

  it("reads a running card's run with its bot's chat and its heartbeat", () => {
    const { runs, events } = golden.taskRunning;
    expect(parseRuns(runs, events)).toEqual([{ id: 3, profile: "default", startedAt: 1_794_864_860_000, heartbeatAt: 1_794_864_863_000, chat: CHAT }]);
  });

  it("takes the heartbeat from the run's events when its row has none", () => {
    const { runs, events } = golden.taskRunning;
    const rowless = runs.map((r) => ({ ...r, last_heartbeat_at: null }));
    expect(parseRuns(rowless, events)[0].heartbeatAt).toBe(1_794_864_863_000);
    expect(parseRuns(rowless, events.filter((e) => e.kind !== "heartbeat"))[0].heartbeatAt).toBeUndefined();
  });

  it("keeps a run with a worker pid on a Hermes that sends no events, without a chat", () => {
    expect(parseRuns(golden.taskRunning.runs, undefined)).toEqual([{ id: 3, profile: "default", startedAt: 1_794_864_860_000, heartbeatAt: 1_794_864_863_000 }]);
  });

  it("leaves out the row a block writes, which no bot ran, so a stopped card has no live run", () => {
    const { runs, events } = golden.taskStopped;
    expect(runs).toHaveLength(2);
    const read = parseRuns(runs, events);
    expect(read).toEqual([
      {
        id: 1,
        profile: "default",
        startedAt: 1_794_864_715_000,
        heartbeatAt: 1_794_864_719_000,
        ended: { at: 1_794_864_723_000, outcome: "reclaimed" },
        chat: "local-e7d5c4ab58c30aee308922f72f4de2708f9bb5e26535693fdc48b01dc0b0f71a",
      },
    ]);
    expect(liveRun(read)).toBeUndefined();
  });

  it("reads the bot's chat under the run's profile: its counts, and its last rows only when the message count moved", async () => {
    const asked: string[] = [];
    const api = new KanbanApi(async (_method, path) => {
      asked.push(path);
      return path.includes("/messages?") ? golden.sessionMessages : golden.session;
    });
    const [run] = parseRuns(golden.taskRunning.runs, golden.taskRunning.events);
    const chat = await api.runChat({ ...run, chat: run.chat! });
    expect(chat).toMatchObject({ usage: { input: 1000, output: 50 }, messages: 2 });
    expect(chat.latest).toEqual([{ role: "user", text: expect.stringMatching(/^# Kanban task t_461bfbf0: Fixture: running Assignee: default .* work kanban task t_461bfbf0$/) }]);
    expect(asked).toEqual([`api/sessions/${CHAT}?profile=default`, `api/sessions/${CHAT}/messages?profile=default&order=latest&limit=6&inline_images=false`]);
    const again = await api.runChat({ ...run, chat: run.chat! }, chat);
    expect(again.latest).toBe(chat.latest);
    expect(asked).toHaveLength(3);
  });

  it("reads the configured default assignee, not the one Hermes resolves for other uses", async () => {
    expect(golden.orchestration).toMatchObject({ default_assignee: "", resolved_default_assignee: "default" });
    expect((await new KanbanApi(async () => golden.orchestration).orchestration()).defaultAssignee).toBe("");
  });
});

async function atWork(server = new FakeHermes()) {
  const hermes = await connect(server.openPipe);
  open.push(hermes);
  const api = hermes.kanban;
  const k = server.kanban;
  const task = k.add("default", { title: "Research the API", assignee: "researcher", status: "running" });
  const run = liveRun((await api.loadTask(task.id)).runs)!;
  const order = (action: RunAction): RunOrder => ({ task: task.id, action, seen: { run: run.id, assignee: "researcher" }, progress: NOTHING_SENT });
  const change = (o: RunOrder) => api.changeRun(o, () => {});
  const chat = (profile: string, n = 0) => server.otherProfiles[profile].filter((s) => s.source === "kanban")[n];
  return { server, api, k, task, run, order, change, chat, card: () => k.find(task.id)! };
}

const STOP: RunAction = { kind: "stop", reason: "wrong repo" };
const park = (id: string) => `POST ${id}/reassign {"profile":"","reclaim_first":true,"reason":"wrong repo"}`;
const block = (id: string) => [`PATCH ${id} {"status":"blocked","block_reason":"wrong repo"}`, `POST ${id}/comments {"body":"BLOCKED: wrong repo"}`];
const giveBack = (id: string) => `PATCH ${id} {"assignee":"researcher"}`;

describe("Reclaim", () => {
  it("stops the run the owner saw, and the card runs again on the next tick", async () => {
    const { k, task, run, order, change, card, chat } = await atWork();
    const { outcome } = await change(order({ kind: "reclaim" }));
    expect(k.writes).toEqual([`POST runs/${run.id}/terminate {"reason":"Reclaimed from Highwing"}`]);
    expect(outcome).toEqual({ kind: "done", note: `Run ${run.id} stopped. The card is ready, and the dispatcher starts it again on its next tick (every 60 s by default).` });
    expect(card()).toMatchObject({ status: "ready", assignee: "researcher" });
    k.work(task.id);
    expect(chat("researcher").input_tokens).toBe(0);
    k.tick();
    expect(card().status).toBe("running");
  });

  it("sends nothing when another run is working by the time it is confirmed", async () => {
    const { k, task, order, change } = await atWork();
    k.move(task.id, "ready");
    k.tick();
    const { outcome } = await change(order({ kind: "reclaim" }));
    expect(outcome).toEqual({ kind: "changed", why: "This card changed since you confirmed, so nothing was sent. Here it is now." });
    expect(k.writes).toEqual([]);
  });

  it("says Hermes refused when it did, having sent the stop once", async () => {
    const { k, order, change, card } = await atWork();
    k.failNext = 409;
    const { outcome, order: after } = await change(order({ kind: "reclaim" }));
    expect(outcome.kind).toBe("failed");
    expect(after.progress.sent).toBe(false);
    expect(k.writes).toHaveLength(1);
    expect(card().status).toBe("running");
  });

  it("after a lost answer, Try again reads first and sends no second stop", async () => {
    const { k, run, order, change } = await atWork();
    k.failNext = "lost";
    const lost = await change(order({ kind: "reclaim" }));
    expect(lost.outcome).toMatchObject({ kind: "unsettled", why: expect.stringContaining("It may have gone through") });
    const again = await change(lost.order);
    expect(again.outcome.kind).toBe("done");
    expect(k.writes).toEqual([`POST runs/${run.id}/terminate {"reason":"Reclaimed from Highwing"}`]);
  });
});

describe("Reassign", () => {
  it("stops the run and gives the card to the other bot in one write", async () => {
    const { k, task, order, change, card } = await atWork();
    const { outcome } = await change(order({ kind: "reassign", bot: "writer" }));
    expect(k.writes).toEqual([`POST ${task.id}/reassign {"profile":"writer","reclaim_first":true,"reason":"Reassigned to writer from Highwing"}`]);
    expect(outcome).toEqual({ kind: "done", note: "It's writer's. The dispatcher starts it on its next tick (every 60 s by default)." });
    expect(card()).toMatchObject({ status: "ready", assignee: "writer" });
  });

  it("sends nothing when the card's bot changed since the confirm", async () => {
    const { k, task, order, change, card } = await atWork();
    k.move(task.id, "ready");
    card().assignee = "writer";
    k.tick();
    const { outcome } = await change(order({ kind: "reassign", bot: "researcher" }));
    expect(outcome.kind).toBe("changed");
    expect(k.writes).toEqual([]);
  });

  it("after a lost answer, Try again doesn't stop the run the new bot has started since", async () => {
    const { k, task, order, change, card } = await atWork();
    k.failNext = "lost";
    const lost = await change(order({ kind: "reassign", bot: "writer" }));
    expect(lost.outcome.kind).toBe("unsettled");
    k.tick();
    const started = card().current_run_id;
    const again = await change(lost.order);
    expect(again.outcome).toEqual({ kind: "done", note: `writer has started it as run ${started}.` });
    expect(k.writes).toHaveLength(1);
    expect(card()).toMatchObject({ status: "running", current_run_id: started });
    expect(k.writes[0]).toContain(`POST ${task.id}/reassign`);
  });
});

describe("Stop", () => {
  it("parks the card, blocks it, and gives it back to its bot, which then stays stopped", async () => {
    const { api, k, task, run, order, card, chat } = await atWork();
    const read: string[] = [];
    const { outcome } = await api.changeRun(order(STOP), (d) => read.push(`${d.task.status} ${d.task.assignee}`));
    expect(k.writes).toEqual([park(task.id), ...block(task.id), giveBack(task.id)]);
    expect(read).toEqual(["running researcher", "ready ", "blocked ", "blocked researcher"]);
    expect(outcome).toEqual({ kind: "done", note: `Run ${run.id} stopped, and the card is blocked.` });
    expect(card()).toMatchObject({ status: "blocked", assignee: "researcher", latest_summary: "wrong repo" });
    k.work(task.id);
    expect(chat("researcher").input_tokens).toBe(0);
    k.tick();
    expect(card().status).toBe("blocked");
  });

  it("sends nothing when the card finished before it was confirmed", async () => {
    const { k, task, order, change } = await atWork();
    k.move(task.id, "review");
    expect((await change(order(STOP))).outcome.kind).toBe("changed");
    expect(k.writes).toEqual([]);
  });

  it("after a lost answer to the first write, Try again blocks and gives back without parking twice", async () => {
    const { k, task, order, change, card } = await atWork();
    k.failNext = "lost";
    const lost = await change(order(STOP));
    expect(lost.outcome.kind).toBe("unsettled");
    expect(card()).toMatchObject({ status: "ready", assignee: null });
    const again = await change(lost.order);
    expect(again.outcome.kind).toBe("done");
    expect(k.writes).toEqual([park(task.id), ...block(task.id), giveBack(task.id)]);
  });

  it("says where the card stands when Hermes refuses the block, and Try again finishes from there", async () => {
    const { k, task, run, order, change, card } = await atWork();
    k.between = (w) => {
      if (w === park(task.id)) k.failNext = 409;
    };
    const stuck = await change(order(STOP));
    expect(stuck.outcome).toMatchObject({ kind: "unsettled", why: expect.stringContaining(`Run ${run.id} stopped, and the card is in ready with no bot, not blocked yet.`) });
    expect(k.writes).toEqual([park(task.id), block(task.id)[0]]);
    k.between = undefined;
    expect((await change(stuck.order)).outcome.kind).toBe("done");
    expect(k.writes).toEqual([park(task.id), block(task.id)[0], ...block(task.id), giveBack(task.id)]);
    expect(card()).toMatchObject({ status: "blocked", assignee: "researcher" });
  });

  it("stops a run the dispatcher starts for the default assignee between its writes", async () => {
    const { k, task, order, change, card, chat } = await atWork();
    k.defaultAssignee = "writer";
    let ticked = false;
    k.between = (w) => {
      if (w === park(task.id) && !ticked) {
        ticked = true;
        k.tick();
      }
    };
    const { outcome } = await change(order(STOP));
    expect(outcome.kind).toBe("done");
    expect(k.writes).toEqual([park(task.id), park(task.id), ...block(task.id), giveBack(task.id)]);
    expect(card()).toMatchObject({ status: "blocked", assignee: "researcher" });
    expect(card().runs.filter((r) => r.worker_pid === null && r.profile).map((r) => r.outcome)).toEqual(["reclaimed", "reclaimed"]);
    k.work(task.id);
    expect(chat("writer").input_tokens).toBe(0);
  });

  it("names the run that got past the block, whose bot works on, and leaves the card blocked", async () => {
    const { k, task, order, change, card, chat } = await atWork();
    k.defaultAssignee = "writer";
    k.before = (w) => {
      if (w === block(task.id)[0]) k.tick();
    };
    const { outcome } = await change(order(STOP));
    const stray = card().runs.find((r) => r.profile === "writer")!;
    expect(outcome).toMatchObject({ kind: "raced", stray: { id: stray.id, profile: "writer", ended: { outcome: "blocked" } } });
    expect(outcome.kind === "raced" && outcome.why).toBe(
      `The card is blocked, but the dispatcher started run ${stray.id} just before the block landed. Its bot works on to the end of its turn, and Hermes can't stop it now. The card stays blocked.`,
    );
    expect(k.writes).toEqual([park(task.id), ...block(task.id), giveBack(task.id)]);
    expect(card()).toMatchObject({ status: "blocked", assignee: "researcher" });
    k.work(task.id);
    expect(chat("writer").input_tokens).toBe(1000);
  });

  it("leaves a reviewer's run's card in Review with no bot, and sends no block", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    open.push(hermes);
    const k = server.kanban;
    const task = k.add("default", { title: "Review the notes", assignee: "researcher", status: "review" });
    k.claim(task.id);
    const run = liveRun((await hermes.kanban.loadTask(task.id)).runs)!;
    const { outcome } = await hermes.kanban.changeRun({ task: task.id, action: STOP, seen: { run: run.id, assignee: "researcher" }, progress: NOTHING_SENT }, () => {});
    expect(outcome).toEqual({ kind: "done", note: `Run ${run.id} stopped. The card waits in Review with no bot, so no bot reviewer takes it. Pick a bot to have it reviewed.` });
    expect(k.writes).toEqual([park(task.id)]);
    expect(k.find(task.id)).toMatchObject({ status: "review", assignee: null });
  });
});

describe("the confirm's words for Stop", () => {
  const task = { id: "t_1", title: "Research the API", body: "", assignee: "researcher", status: "running", priority: 0, comments: 0, links: { parents: 0, children: 0 } };
  const [run] = parseRuns(golden.taskRunning.runs, golden.taskRunning.events);

  it("say whether the dispatcher can start the card between its steps, from the server's default assignee when it is known", () => {
    expect(previewOf(STOP, task, run, "").at(-1)).toBe("This server sets no kanban.default_assignee, so nothing starts the card between those steps.");
    expect(previewOf(STOP, task, run, "writer").at(-1)).toMatch(/^This server gives a card with no bot to writer \(kanban\.default_assignee\), so the dispatcher can start the card between those steps\./);
    expect(previewOf(STOP, task, run).at(-1)).toMatch(/^If this server sets kanban\.default_assignee, the dispatcher can start the card between those steps\./);
  });
});
