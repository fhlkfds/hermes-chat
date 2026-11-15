import { describe, expect, it } from "vitest";
import { returnedItem } from "./returned";

// Shaped as `tools/process_registry_notifications.py` at `bf0203a` writes them.
const SINGLE = [
  "[ASYNC DELEGATION COMPLETE — deleg_1]",
  "A background subagent you dispatched earlier has finished. You may have moved on since dispatching it.",
  "Goal: audit backups",
  "Status: completed   API calls: 4   Duration: 31s",
  "--- RESULT ---",
  "Backups fail because the NAS share is read-only.",
  "Full live transcript (complete tool/assistant trace): /home/h/.hermes/subagents/deleg_1.jsonl",
].join("\n");

const BATCH = [
  "[ASYNC DELEGATION BATCH COMPLETE — deleg_2]",
  "A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished.",
  "Dispatched at 10:00   Total duration: 40s",
  "",
  "--- ✓ TASK 1/2: check the NAS",
  "and its shares  (status=completed, api_calls=3, 12s) ---",
  "NAS is fine.",
  "Full live transcript (complete tool/assistant trace): /tmp/t1.jsonl",
  "",
  "--- ✗ TASK 2/2: check the cron job  (status=failed) ---",
  "(no summary — status=failed: timed out)",
].join("\n");

describe("A stored row that brings back handed-off work", () => {
  it("shows a subagent's result under Hermes's title, without the notice around it", () => {
    expect(returnedItem(SINGLE, "async_delegation_complete", { display_text: "Subagent Task Completed: audit backups" })).toEqual({
      title: "Subagent Task Completed: audit backups",
      body: "Backups fail because the NAS share is read-only.",
      process: false,
    });
  });

  it("reads the title from the metadata's JSON text, as a stored row keeps it", () => {
    expect(returnedItem(SINGLE, "async_delegation_complete", JSON.stringify({ display_text: "Subagent Task Completed: x" }))?.title).toBe("Subagent Task Completed: x");
  });

  it("keeps every task of a batch, each under its number and goal", () => {
    const { body } = returnedItem(BATCH, "async_delegation_complete", { display_text: "Subagent Tasks Finished (2 tasks)" })!;
    expect(body).toBe("**✓ Task 1/2: check the NAS and its shares**\n\nNAS is fine.\n\n**✗ Task 2/2: check the cron job**\n\n(no summary — status=failed: timed out)");
  });

  it("shows a process's output as a process result", () => {
    const text = "[IMPORTANT: Background process proc_1 completed (exit code 0).\nCommand: npm test\nOutput:\nhello-from-proc]";
    expect(returnedItem(text, "process_complete", { display_text: "Background Process Finished: npm test" })).toEqual({
      title: "Background Process Finished: npm test",
      body: "Background process proc_1 completed (exit code 0).\nCommand: npm test\nOutput:\nhello-from-proc",
      process: true,
    });
  });

  it("drops the batch header of several processes and keeps each one's block", () => {
    const text = [
      "[IMPORTANT: 2 background processes completed. Treat these results as one batch.]",
      "[IMPORTANT: Background process proc_1 completed.\nOutput:\none]",
      "[IMPORTANT: Background process proc_2 completed.\nOutput:\ntwo]",
    ].join("\n\n");
    expect(returnedItem(text, "process_complete", undefined)?.body).toBe("Background process proc_1 completed.\nOutput:\none\n\nBackground process proc_2 completed.\nOutput:\ntwo");
  });

  it("shows a cron job's output only", () => {
    const text = "[IMPORTANT: Cron job nightly finished.\n--- JOB OUTPUT ---\nall green]";
    expect(returnedItem(text, "process_complete", undefined)?.body).toBe("all green");
  });

  it("has no title of its own when Hermes sent none, and still shows the result", () => {
    expect(returnedItem(SINGLE, "async_delegation_complete", "not json")).toEqual({ body: "Backups fail because the NAS share is read-only.", process: false });
  });

  it("shows the whole text when nothing is left once the notice goes", () => {
    const text = "[ASYNC DELEGATION COMPLETE — deleg_3]\nStatus: unknown";
    expect(returnedItem(text, "async_delegation_complete", undefined)?.body).toBe(text);
    expect(returnedItem("  An older Hermes's plain result  ", "async_delegation_complete", undefined)?.body).toBe("An older Hermes's plain result");
  });

  it("is no Returned result for any other row", () => {
    for (const kind of [undefined, "steer", "hidden", "model_switch", 3]) expect(returnedItem(SINGLE, kind, undefined)).toBeUndefined();
  });
});
