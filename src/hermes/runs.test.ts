import { describe, expect, it } from "vitest";
import { judgeFailure, record, storedRun, watchedRun, type Recording } from "./runs";
import type { ChatUsage } from "./usage";

const usage = (calls: number, prompt: number, output: number) => ({ calls, prompt, input: prompt, output, reasoning: 0 });

function recordTurn(events: [number, string, Record<string, unknown>][], extra: Partial<Recording> = {}): Recording {
  let rec: Recording = { startedAt: 1000, events: [], from: usage(0, 0, 0), ...extra };
  for (const [at, type, p] of events) rec = record(rec, type, at, p);
  return rec;
}

describe("watchedRun", () => {
  it("draws a model call, a tool call Hermes timed, and the model call after it, pairing events by order", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1200, "message.delta", { text: "Let me " }],
      [1300, "message.delta", { text: "look." }],
      [1500, "session.usage", { usage: usage(1, 100, 10) }],
      [2000, "tool.start", { tool_id: "c1", name: "terminal", args: { command: "ls" } }],
      [5000, "tool.complete", { tool_id: "c1", name: "terminal", duration_s: 2.5, result: '{"output":"a b","exit_code":0}' }],
      [5600, "message.delta", { text: "Done." }],
      [6000, "message.complete", { usage: usage(2, 250, 30), status: "complete" }],
    ]);
    const run = watchedRun({ ...rec, endedAt: 6000 });
    expect(run.steps.map((s) => [s.kind, s.name, s.start, s.end])).toEqual([
      ["model", "Model call", 1000, 2000],
      ["tool", "terminal", 2000, 5000],
      ["model", "Model call", 5000, 6000],
    ]);
    expect(run.steps[0]).toMatchObject({ text: "Let me look.", length: { ms: 1000, measured: false }, tokens: { prompt: 100, output: 10, calls: 1 } });
    expect(run.steps[1]).toMatchObject({ length: { ms: 2500, measured: true }, args: { command: "ls" } });
    expect(run.steps[1].failed).toBeUndefined();
    expect(run.steps[2]).toMatchObject({ text: "Done.", tokens: { prompt: 150, output: 20, calls: 1 } });
    expect(run.turnIds).toBe(false);
    expect(run.outcome).toBeUndefined();
  });

  it("draws a turn as a throwaway Hermes bf0203a sent it, its usage ticks arriving after the next tool started", () => {
    // Arrival times and payloads from a "check disk" turn on Hermes bf0203a with a stub model (three model calls).
    const u = (calls: number, input: number, output: number) => ({ calls, input, prompt: input, output, reasoning: 0 });
    const rec = recordTurn(
      [
        [2450, "message.start", {}],
        [2730, "thinking.delta", { text: "Checking" }],
        [3800, "tool.start", { tool_id: "c1", name: "terminal", args: { command: "sleep 1; df -h /tmp | tail -1" } }],
        [4460, "session.usage", { usage: u(1, 1800, 40) }],
        [5240, "tool.complete", { tool_id: "c1", name: "terminal", duration_s: 1.44, result: '{"output":"tmpfs 32G 11G 21G 34% /tmp","exit_code":0,"error":null}' }],
        [5280, "thinking.delta", { text: "Now the log" }],
        [6080, "tool.start", { tool_id: "c2", name: "read_file", args: { path: "/tmp/backup-last-run.log" } }],
        [6280, "tool.complete", { tool_id: "c2", name: "read_file", duration_s: 0.196, result: '{"content":"","error":"File not found: /tmp/backup-last-run.log"}' }],
        [6460, "session.usage", { usage: u(2, 4200, 80) }],
        [7350, "reasoning.available", { text: "Answer now." }],
        [7380, "message.complete", { status: "complete", usage: u(3, 6900, 120) }],
      ],
      { from: u(0, 0, 0) },
    );
    const run = watchedRun({ ...rec, endedAt: 7380 });
    expect(run.steps.map((s) => [s.kind, s.name, s.tokens && [s.tokens.prompt, s.tokens.output]])).toEqual([
      ["model", "Model call", [1800, 40]],
      ["tool", "terminal", undefined],
      ["model", "Model call", [2400, 40]],
      ["tool", "read_file", undefined],
      ["model", "Model call", [2700, 40]],
    ]);
    expect(run.steps[1]).toMatchObject({ length: { ms: 1440, measured: true } });
    expect(run.steps[3]).toMatchObject({ failed: "File not found: /tmp/backup-last-run.log", judged: true });
    expect(run.tokens).toMatchObject({ prompt: 6900, output: 120, calls: 3 });
    expect(run.turnIds).toBe(false);
  });

  it("ends the model call where a tool began when Hermes sent the tool's completion without its start", () => {
    // f0d9488 with display.tool_progress off: only the failed read_file's tool.complete arrives.
    const rec = recordTurn([
      [1000, "message.start", { turn_id: "t1" }],
      [5000, "tool.complete", { tool_id: "c2", name: "read_file", duration_s: 0.5, result: '{"error":"File not found: x"}' }],
      [6000, "message.complete", { usage: usage(3, 900, 60) }],
    ]);
    const run = watchedRun({ ...rec, endedAt: 6000 });
    expect(run.steps.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["model", 1000, 4500],
      ["tool", 4500, 5000],
      ["model", 5000, 6000],
    ]);
    expect(run.steps[0].note).toMatch(/counted 3 model calls in this reply, and this app saw 2/);
  });

  it("gives no tokens per call when the calls Hermes counted don't match the gaps between tool calls", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1500, "message.delta", { text: "Hi" }],
      [2000, "message.complete", { usage: usage(2, 300, 20) }],
    ]);
    const [step] = watchedRun({ ...rec, endedAt: 2000 }).steps;
    expect(step.tokens).toBeUndefined();
    expect(step.note).toMatch(/counted 2 model calls in this reply, and this app saw 1/);
  });

  it("keeps one event per run of streamed text", () => {
    const rec = recordTurn([
      [1000, "message.start", { turn_id: "t1" }],
      ...Array.from({ length: 500 }, (_, i): [number, string, Record<string, unknown>] => [1001 + i, "message.delta", { text: "x" }]),
    ]);
    expect(rec.events).toHaveLength(2);
    expect(rec.events[1]).toMatchObject({ at: 1001, until: 1500 });
    expect(watchedRun(rec).turnIds).toBe(true);
  });

  it("measures a tool by its arrival times when Hermes sent no duration, and judges a failed result", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1100, "tool.start", { tool_id: "c1", name: "read_file", args: { path: "/x" } }],
      [1400, "tool.complete", { tool_id: "c1", name: "read_file", result: '{"error":"No such file: /x"}' }],
    ]);
    const tool = watchedRun({ ...rec, endedAt: 2000 }).steps.find((s) => s.kind === "tool")!;
    expect(tool).toMatchObject({ length: { ms: 300, measured: false }, failed: "No such file: /x", judged: true });
  });

  it("draws an Approval from its request to the owner's answer, and an unanswered one to Hermes's cancel", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1100, "tool.start", { tool_id: "c1", name: "terminal" }],
      [1200, "request", { id: "r1", kind: "approval", name: "Approval: rm -rf build" }],
      [3200, "answer", { id: "r1", answer: "once" }],
      [3300, "request", { id: "r2", kind: "clarify" }],
      [4300, "request.cancel", { id: "r2", reason: "timeout" }],
      [4400, "tool.complete", { tool_id: "c1", name: "terminal", duration_s: 3.2 }],
    ]);
    const questions = watchedRun({ ...rec, endedAt: 5000 }).steps.filter((s) => s.kind === "question");
    expect(questions).toMatchObject([
      { name: "Approval: rm -rf build", start: 1200, end: 3200, text: "Answered from here: once" },
      { name: "Question", start: 3300, end: 4300, failed: "Hermes stopped waiting: timeout" },
    ]);
  });

  it("marks compactions, errors and a failed turn", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1500, "status.update", { kind: "compacting", text: "Compacting context…" }],
      [1800, "error", { message: "Provider timed out" }],
      [1900, "message.complete", { status: "error", failure_reason: "provider_timeout" }],
    ]);
    const run = watchedRun({ ...rec, endedAt: 1900 });
    expect(run.steps.map((s) => s.kind)).toEqual(["model", "compaction", "error"]);
    expect(run.outcome).toBe("Failed: provider_timeout");
  });

  it("infers the turn's cost from the chat's cost read before and after it", () => {
    const cost = (usd: number): ChatUsage => ({ cost: { kind: "estimated", usd }, readAt: 0 });
    const rec = recordTurn([[1000, "message.start", {}]], { costBefore: cost(0.5), costAfter: cost(0.62) });
    expect(watchedRun(rec).cost).toBeCloseTo(0.12);
    expect(watchedRun(recordTurn([[1000, "message.start", {}]], { costBefore: cost(0.5) })).costWhy).toMatch(/before and after/);
    const unpriced = recordTurn([[1000, "message.start", {}]], { costBefore: { cost: { kind: "unknown", why: "unpriced" }, readAt: 0 }, costAfter: cost(1) });
    expect(watchedRun(unpriced).costWhy).toMatch(/no price/);
  });

  it("ends a tool Hermes never finished at the end of the turn", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1100, "tool.start", { tool_id: "c1", name: "terminal" }],
    ]);
    const tool = watchedRun({ ...rec, endedAt: 3000 }).steps.find((s) => s.kind === "tool")!;
    expect(tool).toMatchObject({ end: 3000, note: expect.stringMatching(/No tool.complete/) });
  });

  it("keeps a reply's words that weren't streamed, interim text once, and a tool's arguments from its completion", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1100, "message.delta", { text: "Checking. " }],
      [1200, "message.interim", { text: "Checking. ", already_streamed: true }],
      [1500, "tool.complete", { tool_id: "c1", name: "read_file", args: { path: "/x" }, duration_s: 0.2, result: '{"error":"missing"}' }],
      [2000, "message.complete", { text: "Checking. It's missing.", reasoning: "Done." }],
    ]);
    const run = watchedRun({ ...rec, endedAt: 2000 });
    expect(run.steps.map((s) => [s.kind, s.text])).toEqual([
      ["model", "Checking. "],
      ["tool", undefined],
      ["model", undefined],
    ]);
    expect(run.steps[1].args).toEqual({ path: "/x" });
    expect(run.steps[2].reasoning).toBe("Done.");
    const quiet = watchedRun({ ...recordTurn([[1000, "message.start", {}], [2000, "message.complete", { text: "Whole reply." }]]), endedAt: 2000 });
    expect(quiet.steps[0].text).toBe("Whole reply.");
  });

  it("draws a compaction's repeated progress lines as one span, ended by compacted when Hermes sends it", () => {
    const rec = recordTurn([
      [1000, "message.start", {}],
      [1500, "status.update", { kind: "compacting", text: "Compacting 40 messages" }],
      [2500, "status.update", { kind: "compacting", text: "Still compacting" }],
      [3500, "status.update", { kind: "compacted", text: "Context compression complete" }],
      [3600, "status.update", { kind: "compacting", text: "Compacting again" }],
    ]);
    const compactions = watchedRun({ ...rec, endedAt: 4000 }).steps.filter((s) => s.kind === "compaction");
    expect(compactions.map((s) => [s.start, s.end, s.length?.ms])).toEqual([
      [1500, 3500, 2000],
      [3600, 3600, undefined],
    ]);
  });

  it("ignores events no step is drawn from", () => {
    const rec = recordTurn([[1000, "todo.updated", { todos: [] }]]);
    expect(rec.events).toEqual([]);
  });
});

describe("storedRun", () => {
  const rows = [
    { id: 1, role: "user", content: "earlier", timestamp: 10 },
    { id: 2, role: "assistant", content: "ok", timestamp: 12 },
    { id: 3, role: "user", content: "check the logs", timestamp: 100 },
    {
      id: 4,
      role: "assistant",
      content: "",
      timestamp: 104,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "terminal", arguments: '{"command":"tail log"}' } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"/x"}' } },
      ],
    },
    { id: 5, role: "tool", tool_call_id: "c1", content: '{"output":"fine","exit_code":0}', timestamp: 109 },
    { id: 6, role: "tool", tool_call_id: "c2", content: "Error: no such file", timestamp: 109.5 },
    { id: 7, role: "assistant", content: "The logs are fine.", timestamp: 115 },
    { id: 8, role: "user", content: "next", timestamp: 200 },
  ];

  it("draws the turn holding the row, each step as the gap since the row before it, pairing tools by call id", () => {
    const run = storedRun(rows, 7)!;
    expect(run.start).toBe(100_000);
    expect(run.end).toBe(115_000);
    expect(run.steps.map((s) => [s.kind, s.name, s.start, s.end])).toEqual([
      ["model", "Model call", 100_000, 104_000],
      ["tool", "terminal", 104_000, 109_000],
      ["tool", "read_file", 109_000, 109_500],
      ["model", "Model call", 109_500, 115_000],
    ]);
    expect(run.steps.every((s) => s.length?.measured === false)).toBe(true);
    expect(run.steps[0].note).toBe("Asked for terminal, read_file.");
    expect(run.steps[1]).toMatchObject({ args: { command: "tail log" }, note: expect.stringMatching(/Run together with 1 other tool call:/) });
    expect(run.steps[2]).toMatchObject({ failed: "Error: no such file", judged: true });
    expect(run.steps[3].text).toBe("The logs are fine.");
    expect(run.cost).toBeUndefined();
  });

  it("finds the whole turn from any of its rows, and nothing for a row it doesn't hold", () => {
    expect(storedRun(rows, 4)!.steps).toHaveLength(4);
    expect(storedRun(rows, 99)).toBeUndefined();
  });

  it("reads tool calls stored as JSON text", () => {
    const text = rows.map((r) => (r.id === 4 ? { ...r, tool_calls: JSON.stringify(r.tool_calls) } : r));
    expect(storedRun(text, 7)!.steps[1].args).toEqual({ command: "tail log" });
  });
});

describe("judgeFailure", () => {
  it.each([
    ['{"success": false}', "The result says success: false."],
    ['{"exit_code": 2, "output": ""}', "It exited with code 2."],
    ['{"status": "error"}', "The result says status: error."],
    ["Traceback (most recent call last):\n  ...", "Traceback (most recent call last):"],
  ])("judges %s failed", (result, why) => expect(judgeFailure(result)).toBe(why));

  it.each(['{"output": "error: none found"}', "All good", '{"exit_code": 0}', undefined])("judges %s not failed", (result) => expect(judgeFailure(result)).toBeUndefined());
});
