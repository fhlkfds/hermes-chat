// @vitest-environment jsdom
// The flight recorder (ADR 0178): a reply's turn as steps, from the events the app heard or from Hermes's stored rows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type ToolTurnPlan } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";
import type { Item } from "./model";
import { FlightRecorder, judgeFailure, storedRun, toolProgressOf, turnRows, watchedRun, type Heard, type RunRow, type Step, type WatchedTurn } from "./flightRecorder";

const P = "default";
const counters = (calls: number, prompt: number, output: number) => ({ prompt, output, reasoning: 0, calls });
const lastReply = (items: Item[]) => [...items].reverse().find((i) => i.kind === "assistant")!;
const kinds = (steps: Step[]) => steps.map((s) => (s.kind === "tool" ? `tool:${s.name}` : s.kind));

describe("A watched run", () => {
  const T = 1_000_000;
  const turn = (heard: Heard[], over: Partial<WatchedTurn> = {}): WatchedTurn => ({ heard, from: counters(4, 1000, 100), replies: ["a1"], ...over });

  it("draws model calls between tool calls, each tool with the length Hermes measured", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "text", at: T + 300, last: T + 900, chars: 40, reasoning: true },
        { kind: "tool.start", at: T + 1000, id: "c1", name: "terminal", args: { command: "df -h" } },
        { kind: "usage", at: T + 1200, counters: counters(5, 1500, 130) },
        { kind: "tool.complete", at: T + 3100, id: "c1", name: "terminal", durationS: 2.04, result: '{"output":"92% used","exit_code":0}' },
        { kind: "text", at: T + 4000, last: T + 4500, chars: 120, reasoning: false },
        { kind: "end", at: T + 4600, status: "complete", counters: counters(6, 2200, 190) },
      ]),
      T + 10_000,
    );
    expect(kinds(run.steps)).toEqual(["model", "tool:terminal", "model"]);
    const [first, tool, last] = run.steps;
    expect(first).toMatchObject({ start: T, end: T + 1000, length: { ms: 1000, measured: false }, calls: 1, tokens: { prompt: 500, output: 30 } });
    expect(tool).toMatchObject({ start: T + 1000, end: T + 3100, length: { ms: 2040, measured: true }, args: { command: "df -h" } });
    expect(tool.failed).toBeUndefined();
    expect(last).toMatchObject({ start: T + 3100, end: T + 4600, calls: 1, tokens: { prompt: 700, output: 60 } });
    expect(run).toMatchObject({ source: "watched", start: T, end: T + 4600, outcome: "complete", calls: 2 });
  });

  it("counts a call in the step it ended, though Hermes's counters for it arrive after the next tool finished", () => {
    // The arrival times a throwaway Hermes bf0203a gave, in ms after `message.start`.
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "tool.start", at: T + 1350, id: "c1", name: "terminal" },
        { kind: "usage", at: T + 2010, counters: counters(5, 1800, 140) },
        { kind: "tool.complete", at: T + 2790, id: "c1", name: "terminal", durationS: 1.44 },
        { kind: "tool.start", at: T + 3630, id: "c2", name: "read_file" },
        { kind: "tool.complete", at: T + 3830, id: "c2", name: "read_file", durationS: 0.2 },
        { kind: "usage", at: T + 4010, counters: counters(6, 4200, 180) },
        { kind: "end", at: T + 4930, status: "complete", counters: counters(7, 6900, 220) },
      ]),
      T + 10_000,
    );
    expect(run.steps.filter((s) => s.kind === "model").map((s) => s.kind === "model" && [s.calls, s.tokens?.prompt])).toEqual([
      [1, 800],
      [1, 2400],
      [1, 2700],
    ]);
  });

  it("counts a call in the step it ended when Hermes's counters for it arrive before the step's tool starts", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "usage", at: T + 900, counters: counters(5, 1800, 140) },
        { kind: "tool.start", at: T + 1000, id: "c1", name: "terminal" },
        { kind: "tool.complete", at: T + 2000, id: "c1", name: "terminal", durationS: 1 },
        { kind: "usage", at: T + 2900, counters: counters(6, 4200, 180) },
        { kind: "tool.start", at: T + 3000, id: "c2", name: "read_file" },
        { kind: "tool.complete", at: T + 3200, id: "c2", name: "read_file", durationS: 0.2 },
        { kind: "usage", at: T + 4100, counters: counters(7, 6900, 220) },
        { kind: "end", at: T + 4200, status: "complete", counters: counters(7, 6900, 220) },
      ]),
      T + 10_000,
    );
    expect(run.steps.filter((s) => s.kind === "model").map((s) => s.kind === "model" && s.calls)).toEqual([1, 1, 1]);
  });

  it("judges a failed tool from its result, as Hermes does, and keeps a status warning and an error as failed", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "tool.start", at: T + 100, id: "c1", name: "terminal" },
        { kind: "tool.complete", at: T + 200, id: "c1", name: "terminal", durationS: 0.1, result: '{"output":"","exit_code":2,"error":null}' },
        { kind: "status", at: T + 300, status: "warn", text: "API call failed after 3 retries" },
        { kind: "error", at: T + 400, message: "Provider unavailable" },
      ]),
      T + 1000,
    );
    expect(run.steps.filter((s) => s.failed).map((s) => [s.kind, s.failed])).toEqual([
      ["tool", "Exit code 2."],
      ["status", "API call failed after 3 retries"],
      ["error", "Provider unavailable"],
    ]);
    expect(run.outcome).toBe("failed");
  });

  it("draws a compaction's repeated progress lines as one span, ended by compacted when Hermes sends it", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "status", at: T + 500, status: "compacting", text: "Compacting 40 messages" },
        { kind: "usage", at: T + 900, counters: counters(5, 1500, 120) },
        { kind: "status", at: T + 1500, status: "compacting", text: "Still compacting" },
        { kind: "status", at: T + 2500, status: "compacted", text: "Context compression complete" },
        { kind: "status", at: T + 2600, status: "compacting", text: "Compacting again" },
        { kind: "text", at: T + 2700, last: T + 2700, chars: 13, reasoning: false },
        { kind: "status", at: T + 2800, status: "compacting", text: "And again" },
        { kind: "end", at: T + 3000, status: "complete" },
      ]),
      T + 4000,
    );
    const compactions = run.steps.filter((s) => s.kind === "status");
    // Model text between two compactions keeps them apart.
    expect(compactions.map((s) => [s.start - T, s.end - T, s.kind === "status" && !!s.done])).toEqual([
      [500, 2500, true],
      [2600, 2600, false],
      [2800, 2800, false],
    ]);
    expect(compactions[0].kind === "status" && compactions[0].text).toBe("Compacting 40 messages\nStill compacting\nContext compression complete");
  });

  it("draws an Approval from when it was asked to when it was answered, matched by either of its ids", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "tool.start", at: T + 100, id: "c1", name: "terminal" },
        { kind: "ask", at: T + 200, id: "frame-1", requestId: "apr-1", what: "approval", summary: "rm -rf build" },
        { kind: "ask", at: T + 250, id: "frame-2", what: "clarify", summary: "Which folder?" },
        { kind: "settled", at: T + 900, ids: ["apr-1"], how: "Hermes stopped waiting: timeout" },
        { kind: "end", at: T + 1000, status: "interrupted" },
      ]),
      T + 2000,
    );
    const asked = run.steps.filter((s) => s.kind === "question");
    expect(asked).toMatchObject([
      { what: "approval", summary: "rm -rf build", start: T + 200, end: T + 900, outcome: "Hermes stopped waiting: timeout" },
      { what: "clarify", end: T + 1000, outcome: "The turn ended" },
    ]);
    expect(run.outcome).toBe("interrupted");
  });

  it("shows why a turn failed when its end says so, as a failed step", () => {
    const run = watchedRun(turn([{ kind: "start", at: T }, { kind: "end", at: T + 500, status: "error", failure: "Context window exceeded" }]), T + 1000);
    expect(run.steps.at(-1)).toMatchObject({ kind: "error", text: "Context window exceeded", failed: "Context window exceeded" });
    expect(run.outcome).toBe("failed");
  });

  it("places a tool sent with no start, as with tool progress off, back from its measured length", () => {
    const run = watchedRun(turn([{ kind: "start", at: T }, { kind: "tool.complete", at: T + 5000, id: "c1", name: "patch", durationS: 1.5, result: "ok" }]), T + 6000);
    expect(run.steps.find((s) => s.kind === "tool")).toMatchObject({ start: T + 3500, end: T + 5000, length: { ms: 1500, measured: true }, placed: true });
    expect(run.steps[0]).toMatchObject({ kind: "model", start: T, end: T + 3500 });
    expect(run.outcome).toBe("running");
  });

  it("can't tell two turns' costs apart when the second starts before the first's cost is read", () => {
    const recorder = new FlightRecorder();
    const cost = (usd: number) => ({ kind: "estimated" as const, usd });
    recorder.begin(P, "c", T, undefined, cost(0.01));
    recorder.end(P, "c", { kind: "end", at: T + 10, status: "complete" }, ["a1"], undefined);
    recorder.begin(P, "c", T + 20, undefined, cost(0.01));
    recorder.end(P, "c", { kind: "end", at: T + 30, status: "complete" }, ["a2"], undefined);
    for (const reply of ["a1", "a2"]) {
      const turn = recorder.find(P, "c", { id: reply })!;
      turn.costAfter = cost(0.03);
      expect(watchedRun(turn, T).cost).toMatchObject({ why: expect.stringContaining("can't be told apart") });
    }
  });

  it("gives an answer Hermes acknowledged after the turn ended to the turn that asked, at the turn's end at the latest", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "c", T, undefined, undefined);
    recorder.hear(P, "c", { kind: "ask", at: T + 100, id: "q1", requestId: "apr-1", what: "approval", summary: "rm -rf build" });
    recorder.hear(P, "c", { kind: "settled", at: T + 200, ids: ["q1"], how: "Hermes stopped waiting: resolved" });
    recorder.end(P, "c", { kind: "end", at: T + 300, status: "complete" }, ["a1"], undefined);
    recorder.settled(P, "c", { kind: "settled", at: T + 900, ids: ["q1"], how: "Denied from this app", answered: true });
    const step = watchedRun(recorder.find(P, "c", { id: "a1" })!, T).steps.find((s) => s.kind === "question");
    expect(step).toMatchObject({ outcome: "Denied from this app", end: T + 200 });
  });

  it("doesn't measure a turn from a cost read that failed after the turn before it", () => {
    const recorder = new FlightRecorder();
    const cost = (usd: number) => ({ kind: "estimated" as const, usd });
    recorder.begin(P, "c", T, undefined, cost(0.01));
    const first = recorder.end(P, "c", { kind: "error", at: T + 10, message: "Provider unavailable" }, [], undefined)!;
    first.costRead = true;
    recorder.begin(P, "c", T + 20, undefined, cost(0.01));
    const second = recorder.end(P, "c", { kind: "end", at: T + 30, status: "complete" }, ["a2"], undefined)!;
    second.costAfter = cost(0.023);
    expect(watchedRun(second, T).cost).toEqual({ why: "The chat's cost wasn't read before this turn." });
  });

  it("says a recording was cut short once a turn sends more events than it keeps", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "c", T, undefined, undefined);
    for (let n = 0; n < 2500; n++) {
      recorder.hear(P, "c", { kind: "tool.start", at: T + n, id: `t${n}`, name: "terminal" });
      recorder.hear(P, "c", { kind: "tool.complete", at: T + n, id: `t${n}`, name: "terminal", durationS: 0 });
    }
    recorder.end(P, "c", { kind: "end", at: T + 3000, status: "complete" }, ["a1"], undefined);
    expect(watchedRun(recorder.find(P, "c", { id: "a1" })!, T).truncated).toBe(true);
  });

  it("keeps the most recent chats' recordings and forgets a deleted chat's", () => {
    const recorder = new FlightRecorder();
    for (let n = 0; n <= 40; n++) {
      recorder.begin(P, `c${n}`, T, undefined, undefined);
      recorder.end(P, `c${n}`, { kind: "end", at: T + 1, status: "complete" }, [`a${n}`], undefined);
    }
    expect(recorder.find(P, "c0", { id: "a0" })).toBeUndefined();
    expect(recorder.find(P, "c1", { id: "a1" })).toBeDefined();
    recorder.forget(P, "c1");
    expect(recorder.find(P, "c1", { id: "a1" })).toBeUndefined();
  });

  it("keeps each profile's recordings apart, though two profiles have a chat with the same id", () => {
    const recorder = new FlightRecorder();
    for (const profile of ["work", "home"]) {
      recorder.begin(profile, "room_1", T, undefined, undefined);
      recorder.hear(profile, "room_1", { kind: "status", at: T + 1, status: "info", text: profile });
      recorder.end(profile, "room_1", { kind: "end", at: T + 2, status: "complete" }, ["a1"], undefined);
    }
    const said = (profile: string) => recorder.find(profile, "room_1", { id: "a1" })?.heard.flatMap((h) => (h.kind === "status" ? [h.text] : []));
    expect(said("work")).toEqual(["work"]);
    expect(said("home")).toEqual(["home"]);
    recorder.forget("work", "room_1");
    expect(said("work")).toBeUndefined();
    expect(said("home")).toEqual(["home"]);
  });

  it("hears a Question once, though Hermes lists it again after a reconnect", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "c", T, undefined, undefined);
    recorder.hear(P, "c", { kind: "ask", at: T + 100, id: "q1", what: "clarify", summary: "Which logs?" });
    recorder.hear(P, "c", { kind: "ask", at: T + 900, id: "q1", what: "clarify", summary: "Which logs?", late: true });
    recorder.end(P, "c", { kind: "end", at: T + 1000, status: "complete" }, ["a1"], undefined);
    expect(recorder.find(P, "c", { id: "a1" })!.heard.filter((h) => h.kind === "ask")).toEqual([{ kind: "ask", at: T + 100, id: "q1", what: "clarify", summary: "Which logs?" }]);
  });

  it("keeps a Question that outlived its turn with the turn that asked it, though Hermes lists it again in a later one", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "c", T, undefined, undefined);
    recorder.hear(P, "c", { kind: "ask", at: T + 100, id: "s1", what: "secret", summary: "OPENWEATHER_API_KEY" });
    recorder.end(P, "c", { kind: "end", at: T + 200, status: "complete" }, ["a1"], undefined);
    recorder.begin(P, "c", T + 300, undefined, undefined);
    recorder.drop(T + 400);
    recorder.rejoin(P, "c", T + 500, true);
    recorder.hear(P, "c", { kind: "ask", at: T + 500, id: "s1", what: "secret", summary: "OPENWEATHER_API_KEY", late: true });
    recorder.settled(P, "c", { kind: "settled", at: T + 600, ids: ["s1"], how: "Answered from this app", answered: true });
    recorder.end(P, "c", { kind: "end", at: T + 700, status: "complete" }, ["a2"], undefined);
    const asked = (reply: string) => recorder.find(P, "c", { id: reply })!.heard.filter((h) => h.kind === "ask" || h.kind === "settled").map((h) => h.kind);
    expect(asked("a1")).toEqual(["ask", "settled"]);
    expect(asked("a2")).toEqual([]);
  });

  it("gives Hermes's cancel of a Question that outlived its turn to the turn that asked it", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "c", T, undefined, undefined);
    recorder.hear(P, "c", { kind: "ask", at: T + 100, id: "s1", what: "sudo", summary: "sudo apt-get install -y ripgrep" });
    recorder.end(P, "c", { kind: "end", at: T + 200, status: "complete" }, ["a1"], undefined);
    recorder.begin(P, "c", T + 300, undefined, undefined);
    recorder.hear(P, "c", { kind: "settled", at: T + 400, ids: ["s1"], how: "Timed out without an answer" });
    recorder.end(P, "c", { kind: "end", at: T + 500, status: "complete" }, ["a2"], undefined);
    const step = watchedRun(recorder.find(P, "c", { id: "a1" })!, T).steps.find((s) => s.kind === "question");
    expect(step).toMatchObject({ outcome: "Timed out without an answer", end: T + 200 });
    expect(recorder.find(P, "c", { id: "a2" })!.heard.map((h) => h.kind)).toEqual(["start", "end"]);
  });

  it("marks a drop once on each running turn, goes on with one still running after it, and ends one that finished unheard", () => {
    const recorder = new FlightRecorder();
    recorder.begin(P, "a", T, undefined, undefined);
    recorder.begin(P, "b", T, undefined, undefined);
    recorder.drop(T + 10);
    recorder.drop(T + 20);
    expect(recorder.rejoin(P, "a", T + 30, true)).toBeUndefined();
    const unheard = recorder.rejoin(P, "b", T + 30, false);
    expect(unheard?.heard.map((h) => h.kind)).toEqual(["start", "dropped", "rejoined"]);
    // A chat opened with no drop before it has nothing to rejoin.
    expect(recorder.rejoin(P, "b", T + 40, false)).toBeUndefined();
    recorder.end(P, "a", { kind: "end", at: T + 50, status: "complete" }, ["a1"], undefined);
    expect(recorder.end(P, "b", { kind: "end", at: T + 50, status: "complete" }, ["b1"], undefined)).toBeUndefined();
    expect(recorder.find(P, "a", { id: "a1" })!.heard.map((h) => h.kind)).toEqual(["start", "dropped", "rejoined", "end"]);
    expect(recorder.find(P, "b", { id: "b1" })).toBeUndefined();
  });

  it("measures the turn after one that finished unheard from the cost read after it", () => {
    const recorder = new FlightRecorder();
    const cost = (usd: number) => ({ kind: "estimated" as const, usd });
    recorder.begin(P, "c", T, undefined, cost(0.01));
    recorder.drop(T + 10);
    const unheard = recorder.rejoin(P, "c", T + 20, false)!;
    unheard.costRead = true;
    unheard.costAfter = cost(0.02);
    recorder.begin(P, "c", T + 30, undefined, cost(0.02));
    const next = recorder.end(P, "c", { kind: "end", at: T + 40, status: "complete" }, ["a2"], undefined)!;
    next.costRead = true;
    next.costAfter = cost(0.025);
    expect(watchedRun(next, T).cost).toEqual({ usd: expect.closeTo(0.005, 9) });
  });

  it("draws the time the app was disconnected as a step it heard nothing of, and gives no step the calls made in it", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "text", at: T + 100, last: T + 500, chars: 30, reasoning: false },
        { kind: "usage", at: T + 600, counters: counters(5, 1500, 130) },
        { kind: "dropped", at: T + 1000 },
        { kind: "rejoined", at: T + 5000 },
        { kind: "usage", at: T + 5200, counters: counters(8, 4000, 300) },
        { kind: "ask", at: T + 5000, id: "q1", what: "clarify", summary: "Which logs?", late: true },
        { kind: "text", at: T + 5300, last: T + 5800, chars: 60, reasoning: false },
        { kind: "end", at: T + 6000, status: "complete", counters: counters(9, 4800, 340) },
      ]),
      T + 10_000,
    );
    expect(kinds(run.steps)).toEqual(["model", "gap", "model", "question"]);
    const [before, gap, after, asked] = run.steps;
    expect(before).toMatchObject({ start: T, end: T + 1000, calls: 1, tokens: { prompt: 500, output: 30 } });
    expect(gap).toMatchObject({ start: T + 1000, end: T + 5000, length: { ms: 4000, measured: false } });
    expect(asked).toMatchObject({ late: true, start: T + 5000, end: T + 6000 });
    expect(after).toMatchObject({ start: T + 5000, end: T + 6000 });
    expect(after.kind === "model" && after.tokens).toBeUndefined();
    expect(run.calls).toBe(5);
  });

  it("ends a tool it never heard end once the model is heard again after a drop, and measures no step across the drop", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "text", at: T + 100, last: T + 400, chars: 20, reasoning: false },
        { kind: "usage", at: T + 500, counters: counters(5, 1500, 130) },
        { kind: "tool.start", at: T + 600, id: "c1", name: "terminal" },
        { kind: "dropped", at: T + 1000 },
        { kind: "rejoined", at: T + 4000 },
        { kind: "text", at: T + 4200, last: T + 4600, chars: 50, reasoning: false },
        { kind: "end", at: T + 5000, status: "complete", counters: counters(7, 3000, 200) },
      ]),
      T + 10_000,
    );
    expect(kinds(run.steps)).toEqual(["model", "tool:terminal", "gap", "model"]);
    const [before, tool, , after] = run.steps;
    expect(before).toMatchObject({ calls: 1, tokens: { prompt: 500, output: 30 } });
    expect(tool).toMatchObject({ end: T + 4200, length: { ms: 3600, measured: false }, endUnheard: true });
    expect(after).toMatchObject({ start: T + 4200, end: T + 5000, chars: 50 });
    expect(after.kind === "model" && after.tokens).toBeUndefined();
    expect(run.calls).toBe(3);
  });

  it("says when the app never heard a tool end, as across a drop", () => {
    const run = watchedRun(
      turn([
        { kind: "start", at: T },
        { kind: "tool.start", at: T + 100, id: "c1", name: "terminal" },
        { kind: "dropped", at: T + 200 },
        { kind: "rejoined", at: T + 900 },
        { kind: "end", at: T + 1000, status: "complete" },
      ]),
      T + 2000,
    );
    expect(kinds(run.steps)).toEqual(["model", "tool:terminal", "gap"]);
    expect(run.steps[1]).toMatchObject({ end: T + 1000, length: { ms: 900, measured: false }, endUnheard: true });
  });

  it("works a turn's cost out from the chat's cost before and after it, or says why it can't", () => {
    const end: Heard = { kind: "end", at: T + 10, status: "complete" };
    const at = (before?: number, after?: number) =>
      watchedRun(turn([{ kind: "start", at: T }, end], { costBefore: before === undefined ? undefined : { kind: "estimated", usd: before }, costAfter: after === undefined ? undefined : { kind: "estimated", usd: after } }), T).cost;
    expect(at(0.01, 0.035)).toEqual({ usd: expect.closeTo(0.025, 9) });
    expect(at(undefined, 0.035)).toEqual({ why: "The chat's cost wasn't read before this turn." });
    expect(at(0.01, undefined)).toEqual({ why: "The chat's cost wasn't read after this turn." });
    expect(at(0.05, 0.01)).toMatchObject({ why: expect.stringContaining("went down") });
  });
});

describe("A stored run", () => {
  const rows: RunRow[] = [
    { id: 1, role: "user", content: "earlier", timestamp: 90 },
    { id: 2, role: "assistant", content: "earlier reply", timestamp: 95 },
    { id: 10, role: "user", content: "Check the NAS", timestamp: 100 },
    {
      id: 11,
      role: "assistant",
      content: "",
      timestamp: 103.5,
      tool_calls: JSON.stringify([
        { id: "c1", type: "function", function: { name: "terminal", arguments: '{"command":"df -h"}' } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"/etc/fstab"}' } },
      ]),
    },
    { id: 12, role: "tool", tool_call_id: "c1", content: '{"output":"92% used","exit_code":0}', timestamp: 105 },
    { id: 13, role: "tool", tool_call_id: "c2", content: '{"error":"File not found: /etc/fstab"}', timestamp: 105.25 },
    { id: 14, role: "assistant", content: "The NAS is 92% full.", timestamp: 109 },
    { id: 15, role: "user", content: "next", timestamp: 200 },
  ];

  it("finds the rows of a reply's turn, from the message that began it to the next one", () => {
    expect(turnRows(rows, 14)?.map((r) => r.id)).toEqual([10, 11, 12, 13, 14]);
    expect(turnRows(rows, 11)?.map((r) => r.id)).toEqual([10, 11, 12, 13, 14]);
    expect(turnRows(rows.slice(3), 14)).toBeUndefined();
    expect(turnRows(rows, 99)).toBeUndefined();
  });

  it("draws each step as the gap since the row before, all inferred, with tools paired to their calls", () => {
    const run = storedRun(turnRows(rows, 14)!);
    expect(kinds(run.steps)).toEqual(["model", "tool:terminal", "tool:read_file", "model"]);
    expect(run.steps.every((s) => !s.length.measured)).toBe(true);
    expect(run.steps.map((s) => s.length.ms)).toEqual([3500, 1500, 250, 3750]);
    expect(run.steps[1]).toMatchObject({ args: { command: "df -h" }, together: true });
    expect(run.steps[2]).toMatchObject({ args: { path: "/etc/fstab" }, failed: "File not found: /etc/fstab", together: true });
    expect(run.steps[3]).toMatchObject({ text: "The NAS is 92% full." });
    expect(run).toMatchObject({ source: "stored", start: 100_000, end: 109_000 });
  });
});

describe("Judging a tool's failure", () => {
  it("follows Hermes's rule for a failure the owner must see", () => {
    expect(judgeFailure('{"success": false}')).toBe("The result says it didn't succeed.");
    expect(judgeFailure('{"ok": false}')).toBe("The result says it didn't succeed.");
    expect(judgeFailure('{"error": "  "}')).toBeUndefined();
    expect(judgeFailure('{"exit_code": 0, "output": "fine"}')).toBeUndefined();
    expect(judgeFailure('{"result": {"error": "nested"}}')).toBeUndefined();
    expect(judgeFailure("Error: plain text")).toBeUndefined();
    expect(judgeFailure("[1, 2]")).toBeUndefined();
  });
});

describe("display.tool_progress", () => {
  it("reads it as Hermes does, YAML booleans and unknown values included", () => {
    expect(toolProgressOf({ display: { tool_progress: "off" } })).toBe("off");
    expect(toolProgressOf({ display: { tool_progress: false } })).toBe("off");
    expect(toolProgressOf({ display: { tool_progress: true } })).toBe("all");
    expect(toolProgressOf({ display: { tool_progress: " Verbose " } })).toBe("verbose");
    expect(toolProgressOf({ display: { tool_progress: "loud" } })).toBe("all");
    expect(toolProgressOf({})).toBe("all");
  });
});

describe("The Run view against FakeHermes", () => {
  const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };
  const running: Hermes[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((h) => h.close()));
    localStorage.clear();
  });

  const PLAN: ToolTurnPlan = {
    calls: [[{ name: "terminal", args: { command: "df -h" }, result: { output: "92% used", exit_code: 0 }, seconds: 2.5 }], [{ name: "read_file", args: { path: "/etc/fstab" }, result: { error: "File not found" }, seconds: 0.5 }]],
    reply: "The NAS is 92% full.",
    modelSeconds: 1,
    tokens: { prompt: 800, output: 40 },
    costUsd: 0.002,
  };

  async function connected(server: FakeHermes) {
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    await hermes.sync();
    await hermes.open("nas");
    const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "nas")!;
    return { hermes, chat };
  }

  it("draws a watched reply from what the app heard, and an unwatched one from the stored rows", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 0, { title: "NAS", estimated_cost_usd: 0.01, cost_status: "estimated", input_tokens: 0, output_tokens: 0, api_call_count: 0 })];
    server.transcripts = { nas: [] };
    const { hermes, chat } = await connected(server);
    await hermes.refreshUsage("nas");
    await hermes.send("nas", "How full is the NAS?");
    // Each step takes some time, as a real one does: at one millisecond for all, which reading falls in which step is chance.
    await server.toolTurn(server.runtimeIdOf("nas")!, PLAN, () => new Promise((r) => setTimeout(r, 2)));
    await hermes.idle();
    const reply = lastReply(chat().items);

    const { run } = await hermes.run("nas", reply.id);
    expect(run.source).toBe("watched");
    expect(kinds(run.steps)).toEqual(["model", "tool:terminal", "model", "tool:read_file", "model"]);
    expect(run.steps.filter((s) => s.kind === "tool").map((s) => s.length)).toEqual([
      { ms: 2500, measured: true },
      { ms: 500, measured: true },
    ]);
    expect(run.steps.find((s) => s.kind === "tool" && s.name === "read_file")?.failed).toBe("File not found");
    expect(run.calls).toBe(3);
    expect(run.cost).toEqual({ usd: expect.closeTo(0.006, 9) });
    expect(hermes.capabilities.getSnapshot().facts.turnIds).toBe(false);

    const later = await connected(server);
    const stored = lastReply(later.chat().items);
    const { run: again } = await later.hermes.run("nas", stored.id);
    expect(again.source).toBe("stored");
    expect(kinds(again.steps)).toEqual(["model", "tool:terminal", "model", "tool:read_file", "model"]);
    expect(again.steps.map((s) => s.length.ms)).toEqual([1000, 2500, 1000, 500, 1000]);
    expect(again.steps[1]).toMatchObject({ args: { command: "df -h" }, length: { measured: false } });
    expect(again.cost).toBeUndefined();
  });

  it("measures a new chat's first turn from no cost", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    await hermes.sync();
    const chatId = await hermes.newChat();
    await hermes.send(chatId, "How full is the NAS?");
    await server.toolTurn(server.runtimeIdOf(chatId)!, { ...PLAN, calls: [] });
    await hermes.idle();
    const reply = lastReply(hermes.getSnapshot().chats.find((c) => c.id === chatId)!.items);
    expect((await hermes.run(chatId, reply.id)).run.cost).toEqual({ usd: expect.closeTo(0.002, 9) });
  });

  it("keeps the owner's answers on Question steps, a Clarify's only once its last question is locked", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    const chatId = await hermes.newChat();
    await hermes.send(chatId, "Clear the logs");
    const runtime = server.runtimeIdOf(chatId)!;
    server.event(runtime, "message.start");
    const asked = server.askClarify(runtime, [{ question: "Which logs?" }, { question: "When?" }])!;
    await hermes.idle();
    await hermes.answerQuestion(chatId, asked, { kind: "lock", qid: "q0", answer: "Old ones" });
    await hermes.answerQuestion(chatId, asked, { kind: "lock", qid: "q1", answer: "Tonight" });
    const approval = server.askApproval(runtime)!.id!;
    await hermes.idle();
    await hermes.answerApproval(chatId, approval, "once");
    server.event(runtime, "message.delta", { text: "Cleared." });
    server.event(runtime, "message.complete", { text: "Cleared.", status: "complete" });
    await hermes.idle();
    const reply = lastReply(hermes.getSnapshot().chats.find((c) => c.id === chatId)!.items);
    const questions = (await hermes.run(chatId, reply.id)).run.steps.filter((s) => s.kind === "question");
    expect(questions.map((s) => s.kind === "question" && s.outcome)).toEqual(["Answered from this app: Which logs? → Old ones; When? → Tonight", "Allowed once from this app"]);
  });

  it("measures the turn after a failed one from the cost read after the failure", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 0, { estimated_cost_usd: 0.01, cost_status: "estimated", input_tokens: 0, output_tokens: 0, api_call_count: 0 })];
    server.transcripts = { nas: [] };
    const { hermes, chat } = await connected(server);
    await hermes.refreshUsage("nas");
    await hermes.send("nas", "one");
    const runtime = server.runtimeIdOf("nas")!;
    server.event(runtime, "message.start");
    server.sessions[0].estimated_cost_usd = 0.02;
    server.event(runtime, "error", { message: "Provider unavailable" });
    await hermes.idle();
    await hermes.send("nas", "two");
    await server.toolTurn(runtime, { ...PLAN, calls: [] });
    await hermes.idle();
    const { run } = await hermes.run("nas", lastReply(chat().items).id);
    expect(run.cost).toEqual({ usd: expect.closeTo(0.002, 9) });
  });

  it("keeps a recording cut short, with its warning, when the stored rows can't be read back to the turn", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 0)];
    server.transcripts = { nas: [] };
    server.userRowId = 5;
    const { hermes, chat } = await connected(server);
    await hermes.send("nas", "go");
    const runtime = server.runtimeIdOf("nas")!;
    server.event(runtime, "message.start");
    for (let n = 0; n < 2100; n++) {
      server.event(runtime, "tool.start", { tool_id: `t${n}`, name: "terminal" });
      server.event(runtime, "tool.complete", { tool_id: `t${n}`, name: "terminal", duration_s: 0.01, result: "ok" });
    }
    server.event(runtime, "message.delta", { text: "Done." });
    server.event(runtime, "message.complete", { text: "Done.", status: "complete", persisted_turn: { user_row_id: 5, final_assistant_row_id: 999_999 } });
    await hermes.idle();
    const reply = lastReply(chat().items);
    expect(reply.kind === "assistant" && reply.rowId).toBe(999_999);
    const { run } = await hermes.run("nas", reply.id);
    expect(run).toMatchObject({ source: "watched", truncated: true });
  });

  it("notes that message.start carries turn ids when Hermes sends them", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 0)];
    server.transcripts = { nas: [] };
    const { hermes } = await connected(server);
    await hermes.send("nas", "hi");
    await server.toolTurn(server.runtimeIdOf("nas")!, { ...PLAN, calls: [], turnId: "turn-1" });
    await hermes.idle();
    expect(hermes.capabilities.getSnapshot().facts.turnIds).toBe(true);
  });

  it("says a Question answered in another Hermes client was answered there", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    const chatId = await hermes.newChat();
    await hermes.send(chatId, "Clear the logs");
    const runtime = server.runtimeIdOf(chatId)!;
    server.event(runtime, "message.start");
    const asked = server.askClarify(runtime, [{ question: "Which logs?" }])!;
    await hermes.idle();
    // An older client answers in a response frame, and Hermes tells no other client.
    server.answerElsewhere(asked, "response");
    server.event(runtime, "message.delta", { text: "Cleared." });
    server.event(runtime, "message.complete", { text: "Cleared.", status: "complete" });
    await hermes.idle();
    const reply = lastReply(hermes.getSnapshot().chats.find((c) => c.id === chatId)!.items);
    const questions = (await hermes.run(chatId, reply.id)).run.steps.filter((s) => s.kind === "question");
    expect(questions.map((s) => s.kind === "question" && s.outcome)).toEqual(["Answered in another Hermes client"]);
  });

  it("says an Approval answered in another Hermes client ended once Hermes listed its chat as not waiting", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
    running.push(hermes);
    const chatId = await hermes.newChat();
    await hermes.open(chatId);
    await hermes.send(chatId, "Clear the logs");
    const runtime = server.runtimeIdOf(chatId)!;
    server.event(runtime, "message.start");
    const { id } = server.askApproval(runtime);
    await hermes.idle();
    server.answerElsewhere(id!, "response");
    await hermes.checkLive();
    server.event(runtime, "message.delta", { text: "Cleared." });
    server.event(runtime, "message.complete", { text: "Cleared.", status: "complete" });
    await hermes.idle();
    const reply = lastReply(hermes.getSnapshot().chats.find((c) => c.id === chatId)!.items);
    const questions = (await hermes.run(chatId, reply.id)).run.steps.filter((s) => s.kind === "question");
    expect(questions.map((s) => s.kind === "question" && s.outcome)).toEqual(["Hermes stopped waiting for an answer"]);
  });

  it("draws a drop mid-turn as a gap, with the Questions Hermes asked and dropped while the app couldn't hear", async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
      running.push(hermes);
      const chatId = await hermes.newChat();
      await hermes.send(chatId, "Clear the logs");
      const runtime = server.runtimeIdOf(chatId)!;
      server.event(runtime, "message.start");
      const { id: approval } = server.askApproval(runtime);
      await vi.advanceTimersByTimeAsync(10);
      server.drop();
      // While the app is away, Hermes stops waiting on the Approval and asks a Question instead.
      server.openRequests.delete(approval!);
      server.askClarify(runtime, [{ question: "Which logs?" }]);
      await vi.advanceTimersByTimeAsync(1_000);
      await hermes.idle();
      server.event(runtime, "message.delta", { text: "Cleared." });
      server.event(runtime, "message.complete", { text: "Cleared.", status: "complete" });
      await hermes.idle();
      const reply = lastReply(hermes.getSnapshot().chats.find((c) => c.id === chatId)!.items);
      const { run } = await hermes.run(chatId, reply.id);
      expect(run.source).toBe("watched");
      expect(kinds(run.steps)).toEqual(["model", "question", "gap", "model", "question"]);
      expect(run.steps[1]).toMatchObject({ what: "approval", outcome: "Hermes stopped waiting for an answer" });
      expect(run.steps[4]).toMatchObject({ what: "clarify", late: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a turn that finished while the app couldn't hear from the stored rows, and measures the next from the cost read after it", async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeHermes();
      server.sessions = [row("nas", 0, { estimated_cost_usd: 0.01, cost_status: "estimated", input_tokens: 0, output_tokens: 0, api_call_count: 0 })];
      server.transcripts = { nas: [] };
      const { hermes, chat } = await connected(server);
      await hermes.refreshUsage("nas");
      await hermes.send("nas", "How full is the NAS?");
      const runtime = server.runtimeIdOf("nas")!;
      server.event(runtime, "message.start");
      await hermes.idle();
      server.drop();
      await server.toolTurn(runtime, { ...PLAN, calls: [] });
      await vi.advanceTimersByTimeAsync(1_000);
      await hermes.idle();
      const unheard = lastReply(chat().items);
      expect((await hermes.run("nas", unheard.id)).run.source).toBe("stored");

      await hermes.send("nas", "And the backups?");
      await server.toolTurn(server.runtimeIdOf("nas")!, { ...PLAN, calls: [] });
      await hermes.idle();
      const { run } = await hermes.run("nas", lastReply(chat().items).id);
      expect(run).toMatchObject({ source: "watched", cost: { usd: expect.closeTo(0.002, 9) } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the profile's tool progress with the run", async () => {
    const server = new FakeHermes();
    server.sessions = [row("nas", 0)];
    server.transcripts = { nas: [] };
    server.toolProgress = { default: false };
    const { hermes, chat } = await connected(server);
    await hermes.send("nas", "hi");
    await server.toolTurn(server.runtimeIdOf("nas")!, { ...PLAN, calls: [] });
    await hermes.idle();
    const reply = lastReply(chat().items);
    expect((await hermes.run("nas", reply.id)).toolProgress).toBe("off");
  });
});
