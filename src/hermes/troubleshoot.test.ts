// The Troubleshoot hand-off (ADR 0051): the first message built from what the Jobs screen reads, the change list shown
// afterwards, and the store that tells when the chat's reply has ended. Jobs and runs are fixtures.
import { describe, expect, it, vi } from "vitest";
import { type CronJob, type JobRun, type JobsZone, toJob } from "./cronJobs";
import {
  type ChatStarter,
  type ChatsView,
  OUTPUT_LIMIT,
  PROMPT_LIMIT,
  TroubleshootStore,
  clip,
  jobChanges,
  startTroubleshoot,
  troubleshootMessage,
} from "./troubleshoot";

const zone: JobsZone = { zone: "America/Chicago", label: "America/Chicago", named: true };
const targets = [
  { id: "local", name: "Local (save only)", ready: true },
  { id: "telegram", name: "Telegram", ready: true },
  { id: "discord", name: "Discord", ready: false },
];

function job(over: Record<string, unknown> = {}): CronJob {
  return toJob({
    id: "abc123",
    name: "[fixture] Weekday brief",
    prompt: "Summarise my inbox.",
    schedule: { kind: "cron", expr: "0 9 * * 1-5", display: "0 9 * * 1-5" },
    schedule_display: "0 9 * * 1-5",
    enabled: true,
    state: "scheduled",
    next_run_at: "2026-11-05T09:00:00-06:00",
    last_run_at: "2026-11-04T09:00:00-06:00",
    last_status: "error",
    last_error: "RuntimeError: provider timed out",
    deliver: "discord",
    repeat: { times: null, completed: 4 },
    profile: "work",
    scheduler_heartbeat_age_s: 30,
    ...over,
  })!;
}

const at = Date.parse("2026-11-04T15:00:00Z");
const failedScript: JobRun = { id: "cron_output:abc123:2", title: "Script exited with code 3", preview: "Traceback: boom", startedAt: at, state: "failed", error: "Script exited with code 3", script: true };
const okAgent: JobRun = { id: "s-ok", title: "Run", startedAt: at - 86_400_000, endedAt: at - 86_400_000 + 80_000, state: "succeeded", script: false, sessionId: "s-ok" };

describe("the Troubleshoot message", () => {
  it("carries the job's definition, what the Jobs screen flags, and its runs with their output", () => {
    const m = troubleshootMessage({
      profile: "work",
      job: job({ model: "gpt-x", provider: "openrouter", skills: ["inbox"], workdir: "/srv/brief" }),
      zone,
      targets,
      runs: [failedScript, okAgent],
      results: { "s-ok": { reply: "Here is the brief." } },
      picked: failedScript.id,
    });
    const t = m.text;
    expect(t).toMatch(/troubleshoot my scheduled job “\[fixture\] Weekday brief” \(id `abc123`\) in the work profile/);
    expect(t).toMatch(/- Schedule: `0 9 \* \* 1-5` \(On weekdays at 9:00 AM\)/);
    expect(t).toMatch(/- Time zone: America\/Chicago/);
    expect(t).toMatch(/- State: scheduled \(not paused\)/);
    expect(t).toMatch(/- Next run: 2026-11-05T09:00/);
    expect(t).toMatch(/- Delivers to: `discord`/);
    expect(t).toMatch(/- Last run: 2026-11-04T09:00.*failed \(`error`\)/);
    expect(t).toMatch(/- Model: openrouter \/ gpt-x/);
    expect(t).toMatch(/- Skills: inbox/);
    expect(t).toMatch(/- Folder: \/srv\/brief/);
    expect(t).toMatch(/RuntimeError: provider timed out/);
    expect(t).toMatch(/## Prompt\n```text\nSummarise my inbox.\n```/);
    // The delivery problem the screen flags, in its words.
    expect(t).toMatch(/## Problems Hermes Chat flags\n- Discord has no home channel set on the server/);
    expect(t).toMatch(/### 1\. Failed \(the run I picked\)\n- Script run, finished 2026-11-04T09:00/);
    expect(t).toMatch(/- Error:\n```text\nScript exited with code 3\n```/);
    expect(t).toMatch(/- Output \(Hermes serves only the start of it\):\n```text\nTraceback: boom\n```/);
    expect(t).toMatch(/### 2\. Succeeded\n- Agent run, started .*, ended .*\n- Session: `s-ok`/);
    expect(t).toMatch(/- The agent's last reply:\n```text\nHere is the brief.\n```/);
    // What Hermes is asked to do, and not to do.
    expect(t).toMatch(/Don't create, delete or run jobs/);
    expect(t).toMatch(/list every change you made to the job, each with its old and new value/);
    expect(m.cut).toEqual([]);
    expect(m.hidden).toEqual([]);
  });

  it("says a job is paused, and a script job runs a script whose text is on the server", () => {
    const t = troubleshootMessage({ profile: "work", job: job({ enabled: false, state: "paused", paused_reason: "too many failures", no_agent: true, script: "check.py", prompt: "" }), zone, targets, runs: [], results: {} }).text;
    expect(t).toMatch(/- State: paused \(too many failures\)/);
    expect(t).toMatch(/## Script\nIt runs the script `check.py` with no agent/);
    expect(t).not.toMatch(/## Prompt/);
  });

  it("says when the job has no runs, or they couldn't be read, and when delivery couldn't be checked", () => {
    const none = troubleshootMessage({ profile: "work", job: job({ last_run_at: null, last_status: null, last_error: null }), zone, runs: [], results: {} }).text;
    expect(none).toMatch(/- Last run: it hasn't run yet/);
    expect(none).toMatch(/Hermes has no runs of this job on record\./);
    expect(none).toMatch(/couldn't read where this profile can deliver/);
    const unread = troubleshootMessage({ profile: "work", job: job(), zone, targets, runs: "Run history isn't kept yet for this profile.", results: {} }).text;
    expect(unread).toMatch(/couldn't read the run history: Run history isn't kept yet/);
  });

  it("flags a scheduler that isn't running, as the screen does", () => {
    expect(troubleshootMessage({ profile: "work", job: job({ scheduler_heartbeat_age_s: null }), zone, targets, runs: [], results: {} }).text).toMatch(/hasn't recorded its scheduler running/);
    expect(troubleshootMessage({ profile: "work", job: job({ scheduler_heartbeat_age_s: 900 }), zone, targets, runs: [], results: {} }).text).toMatch(/last checked this profile's jobs 15 minutes ago/);
  });

  it("cuts long output and prompts in the middle, and says so", () => {
    const long = `START ${"x".repeat(5000)} END`;
    const m = troubleshootMessage({
      profile: "work",
      job: job({ prompt: `BEGIN ${"p".repeat(9000)} FINISH` }),
      zone,
      targets,
      runs: [{ ...okAgent, id: "s-long", sessionId: "s-long" }],
      results: { "s-long": { reply: long } },
    });
    expect(m.cut).toEqual(["the prompt", "run 1's reply"]);
    expect(m.text).toMatch(/BEGIN p+\n\[… \d+ characters cut by Hermes Chat …\]\np+ FINISH/);
    expect(m.text).toMatch(/START x+\n\[… \d+ characters cut by Hermes Chat …\]\nx+ END/);
    const prompt = /## Prompt\n```text\n([\s\S]*?)\n```/.exec(m.text)![1];
    expect(prompt.replace(/\n\[… \d+ characters cut by Hermes Chat …\]\n/, "")).toHaveLength(PROMPT_LIMIT);
    expect(clip("a".repeat(OUTPUT_LIMIT), OUTPUT_LIMIT)).toEqual({ text: "a".repeat(OUTPUT_LIMIT), cut: false });
  });

  it("hides what looks like a secret in the prompt and output, and lists what it hid", () => {
    const m = troubleshootMessage({
      profile: "work",
      job: job({ prompt: "Call the API with api_key=sk-abcdefghijklmnopqrstuvwxyz123456 and report." }),
      zone,
      targets,
      runs: [{ ...failedScript, error: "401 for Authorization: Bearer abcdef1234567890", preview: "token: hunter2hunter2" }],
      results: {},
    });
    expect(m.text).not.toMatch(/sk-abcdefghijklmnop|abcdef1234567890|hunter2/);
    expect(m.text).toMatch(/api_key=\[redacted key\]/);
    expect(m.hidden).toEqual(expect.arrayContaining(["authorization header", "secret value"]));
    // Hermes is told the markers aren't the job's text.
    expect(m.text).toMatch(/never write a marker back into the job/);
  });

  it("keeps a fence that output with backticks can't close", () => {
    const m = troubleshootMessage({ profile: "work", job: job({ prompt: "Use ```code``` blocks" }), zone, targets, runs: [], results: {} });
    expect(m.text).toMatch(/````text\nUse ```code``` blocks\n````/);
  });
});

describe("what changed on the job", () => {
  it("lists each changed field with its old and new value, and nothing when nothing changed", () => {
    const before = job();
    expect(jobChanges(before, job())).toEqual([]);
    const after = job({ prompt: "Summarise my inbox, briefly.", deliver: "telegram", schedule_display: "0 10 * * 1-5", schedule: { kind: "cron", expr: "0 10 * * 1-5", display: "0 10 * * 1-5" }, enabled: false, state: "paused", last_run_at: "2026-11-05T09:00:00-06:00" });
    expect(jobChanges(before, after)).toEqual([
      { field: "Schedule", before: "0 9 * * 1-5", after: "0 10 * * 1-5" },
      { field: "State", before: "scheduled", after: "paused" },
      { field: "Prompt", before: "Summarise my inbox.", after: "Summarise my inbox, briefly.", long: true },
      { field: "Delivers to", before: "discord", after: "telegram" },
    ]);
  });
});

describe("the troubleshooting store", () => {
  const view = (chats: ChatsView["chats"], profile = "work", status = "connected"): ChatsView => ({ profile, status, chats });

  it("is working while the chat's reply runs, and ended once it stops, in the job's profile only", () => {
    const store = new TroubleshootStore(() => 1000);
    const t = store.start("scope", "work", job());
    store.opened(t.id, "chat-1");
    store.sent(t.id, { delivery: "accepted" }, true);
    expect(store.forJob("scope", "work", "abc123")?.phase).toBe("working");
    store.observe(view([{ id: "chat-1", running: true }]));
    expect(store.forJob("scope", "work", "abc123")?.phase).toBe("working");
    // Another profile showing, or no connection, says nothing about the chat.
    store.observe(view([{ id: "chat-1", running: false }], "default"));
    store.observe(view([{ id: "chat-1", running: false }], "work", "reconnecting"));
    expect(store.forJob("scope", "work", "abc123")?.phase).toBe("working");
    store.observe(view([{ id: "chat-1", running: false }]));
    expect(store.forJob("scope", "work", "abc123")).toMatchObject({ phase: "ended", endedAt: 1000, chatId: "chat-1" });
  });

  it("ends at once when the reply ended before the message's answer, and fails when the message didn't go", () => {
    const store = new TroubleshootStore();
    const a = store.start("scope", "work", job());
    store.sent(a.id, { delivery: "accepted" }, false);
    expect(store.forJob("scope", "work", "abc123")?.phase).toBe("ended");
    const b = store.start("scope", "work", job({ id: "other" }));
    store.sent(b.id, { delivery: "unsent", reason: "Hermes is busy." }, false);
    expect(store.forJob("scope", "work", "other")).toMatchObject({ phase: "failed", reason: "Hermes is busy." });
  });

  it("keeps the newest troubleshooting of a job, apart for each connection and profile", () => {
    const store = new TroubleshootStore();
    store.start("scope", "work", job());
    const again = store.start("scope", "work", job());
    store.start("other-server", "work", job());
    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.forJob("scope", "work", "abc123")?.id).toBe(again.id);
    store.dismiss(again.id);
    expect(store.forJob("scope", "work", "abc123")).toBeUndefined();
  });
});

describe("starting a troubleshooting chat", () => {
  function starter(profile: string) {
    const h = {
      profile,
      chats: [] as { id: string; running?: boolean }[],
      sent: [] as [string, string][],
      newChat: vi.fn(async () => {
        h.chats.push({ id: "new-chat" });
        return "new-chat";
      }),
      send: vi.fn(async (id: string, text: string) => {
        h.sent.push([id, text]);
        h.chats[0].running = true;
        return { delivery: "accepted" as const };
      }),
      getSnapshot: () => ({ profile: h.profile, status: "connected", chats: h.chats }),
    };
    const typed: ChatStarter = h;
    void typed;
    return h;
  }

  it("starts a new chat in the job's profile, opens it, and sends the message as its first", async () => {
    const h = starter("work");
    const store = new TroubleshootStore();
    const open = vi.fn();
    const t = await startTroubleshoot(h, store, "scope", "work", job(), "Please troubleshoot", open);
    expect(h.newChat).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("new-chat");
    expect(h.sent).toEqual([["new-chat", "Please troubleshoot"]]);
    expect(t).toMatchObject({ phase: "working", chatId: "new-chat", profile: "work", jobId: "abc123" });
  });

  it("starts nothing when the app shows another profile than the job's", async () => {
    const h = starter("default");
    const store = new TroubleshootStore();
    await expect(startTroubleshoot(h, store, "scope", "work", job(), "x", () => {})).rejects.toThrow(/shows the default profile now, not work.*Nothing was sent/);
    expect(h.newChat).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("sends nothing when the profile changes while the chat starts", async () => {
    const h = starter("work");
    h.newChat.mockImplementation(async () => {
      h.profile = "default";
      return "new-chat";
    });
    const store = new TroubleshootStore();
    const open = vi.fn();
    await expect(startTroubleshoot(h, store, "scope", "work", job(), "x", open)).rejects.toThrow(/changed to default.*wasn't sent/);
    expect(h.send).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(store.forJob("scope", "work", "abc123")?.phase).toBe("failed");
  });
});
