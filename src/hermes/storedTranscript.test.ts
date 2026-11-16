import { describe, expect, it } from "vitest";
import { projectStored } from "./storedTranscript";

const call = (id: string, name: string, args: unknown) => ({ id, call_id: id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const row = (id: number, role: string, content: unknown, over: Record<string, unknown> = {}) => ({
  id,
  role,
  content,
  tool_call_id: null,
  tool_calls: null,
  tool_name: null,
  reasoning: null,
  display_kind: null,
  display_metadata: null,
  timestamp: 1_794_840_000 + id,
  ...over,
});

const PREAMBLE = "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user.]\n\nCheck the disk usage.";

describe("projectStored", () => {
  it("shows a job run as its prompt, its tool step named from the call, and its reply", () => {
    const shown = projectStored([
      row(1, "user", PREAMBLE),
      row(2, "assistant", "Checking the root filesystem first.", { tool_calls: [call("call_1", "terminal", { command: "df -h /" })] }),
      row(3, "tool", '{"output": "61% /", "exit_code": 0}', { tool_call_id: "call_1", tool_name: "terminal" }),
      row(4, "assistant", "Nothing needs cleaning tonight."),
    ]);
    expect(shown).toEqual([
      { role: "user", text: PREAMBLE, row_id: 1, timestamp: 1_794_840_001 },
      { role: "assistant", text: "Checking the root filesystem first.", row_id: 2, timestamp: 1_794_840_002 },
      { role: "tool", name: "terminal", context: "df -h /", content: '{"output": "61% /", "exit_code": 0}', tool_call_id: "call_1", args: { command: "df -h /" }, timestamp: 1_794_840_003 },
      { role: "assistant", text: "Nothing needs cleaning tonight.", row_id: 4, timestamp: 1_794_840_004 },
    ]);
  });

  it("reads tool calls stored as JSON text as it reads a list", () => {
    const calls = [call("c1", "read_file", { path: "/etc/hosts" })];
    const rows = (tool_calls: unknown) => [row(1, "assistant", "", { tool_calls }), row(2, "tool", "ok", { tool_call_id: "c1" })];
    expect(projectStored(rows(JSON.stringify(calls)))).toEqual(projectStored(rows(calls)));
    expect(projectStored(rows(calls))[0]).toMatchObject({ role: "tool", name: "read_file", context: "/etc/hosts" });
  });

  it("leaves out hidden rows and [System: rows, and still names a hidden row's tool steps", () => {
    const shown = projectStored([
      row(1, "user", "[System: the gateway restarted]"),
      row(2, "user", "Project instructions", { display_kind: "hidden" }),
      row(3, "assistant", "Held commentary", { display_kind: "hidden", tool_calls: [call("c1", "web_search", { query: "disk usage" })] }),
      row(4, "tool", "results", { tool_call_id: "c1" }),
      row(5, "user", "  [System: indented marker]"),
    ]);
    expect(shown).toEqual([{ role: "tool", name: "web_search", context: "disk usage", content: "results", tool_call_id: "c1", args: { query: "disk usage" }, timestamp: 1_794_840_004 }]);
  });

  it("names a tool step with no call on record by its stored tool name, then as a tool", () => {
    const shown = projectStored([row(1, "tool", "x", { tool_call_id: "lost", tool_name: "memory" }), row(2, "tool", "y")]);
    expect(shown.map((m) => m.name)).toEqual(["memory", "tool"]);
    expect(shown[0].args).toBeUndefined();
  });

  it("names a tool step from a call made on an earlier page of the read", () => {
    const first = [row(1, "user", "go"), row(2, "assistant", "", { tool_calls: [call("c9", "terminal", { command: "uptime" })] })];
    const second = [row(3, "tool", "up 3 days", { tool_call_id: "c9" })];
    expect(projectStored([...first, ...second]).at(-1)).toMatchObject({ name: "terminal", context: "uptime" });
    expect(projectStored(second)[0].name).toBe("tool");
  });

  it("keeps an assistant row that only reasoned, and drops any other row with no text", () => {
    const shown = projectStored([
      row(1, "assistant", "", { reasoning: "The disk looks fine." }),
      row(2, "assistant", "   "),
      row(3, "user", null),
      row(4, "assistant", null, { reasoning_content: "From the provider's own field." }),
    ]);
    expect(shown.map((m) => [m.row_id, m.text, m.reasoning])).toEqual([
      [1, "", "The disk looks fine."],
      [4, "", "From the provider's own field."],
    ]);
  });

  it("reads a parts list as its text, with each image named instead of sent", () => {
    const shown = projectStored([row(1, "user", [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, "plain"])]);
    expect(shown[0].text).toBe("What is this?\n[image]plain");
  });

  it("keeps every tool's stored result, and each row's display facts", () => {
    const meta = '{"tool_result_metadata":{"inline_diff":"--- a\\n+++ b"}}';
    const shown = projectStored([
      row(1, "assistant", "", { tool_calls: [call("w", "write_file", { path: "/tmp/a", content: "x" }), call("t", "terminal", { command: "ls" })] }),
      row(2, "tool", '{"bytes_written": 1}', { tool_call_id: "w", display_metadata: meta }),
      row(3, "tool", "a", { tool_call_id: "t" }),
      row(4, "user", "Result of the delegated task", { display_kind: "returned" }),
    ]);
    expect(shown[0]).toMatchObject({ name: "write_file", content: '{"bytes_written": 1}', display_metadata: meta });
    expect(shown[1]).toMatchObject({ name: "terminal", content: "a" });
    expect(shown[2]).toMatchObject({ role: "user", display_kind: "returned" });
  });

  it("cuts a long argument to one 80-character line, and shows arguments that aren't JSON as written", () => {
    const long = `echo ${"x".repeat(100)}\nsecond line`;
    const shown = projectStored([
      row(1, "assistant", "", { tool_calls: [call("a", "terminal", { command: long }), call("b", "terminal", "not json")] }),
      row(2, "tool", "", { tool_call_id: "a" }),
      row(3, "tool", "", { tool_call_id: "b" }),
    ]);
    expect(shown[0].context).toHaveLength(80);
    expect(shown[0].context).toMatch(/^echo x+\.\.\.$/);
    expect(shown[1].args).toEqual({ arguments: "not json" });
  });

  it("skips what isn't a row, and roles the transcript has no place for", () => {
    expect(projectStored([null, "text", { role: "developer", content: "x" }, { content: "no role" }, row(1, "system", "Model changed")])).toEqual([
      { role: "system", text: "Model changed", row_id: 1, timestamp: 1_794_840_001 },
    ]);
  });
});
