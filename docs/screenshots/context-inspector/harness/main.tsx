// The context inspector's screenshots: the real ChatPane, StatusBar and transport, talking to the tests' fake Hermes
// in the page. Every chat, message, path and figure is synthetic, shaped like what the live `bf0203a` server stores
// (see ../README.md). `?shot=` picks the scene; `window.ready` is set once it is on screen. Built and driven by shoot.mjs.
import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import "../../../../src/styles.css";
import { FakeHermes, row, type TranscriptMessage } from "../../../../src/hermes/fakeHermes";
import { connect } from "../../../../src/hermes/transport";
import { ChatPane } from "../../../../src/ui/ChatPane";
import { StatusBar } from "../../../../src/ui/StatusBar";
import { PreviewContext } from "../../../../src/ui/previewContext";

const shot = new URLSearchParams(location.search).get("shot") ?? "window";
const T0 = Math.floor(Date.parse("2026-11-03T09:12:00Z") / 1000);

const server = new FakeHermes();
server.sessions = [
  row("nas", 0.01, {
    title: "Nightly NAS backup check",
    source: "gui",
    // The chat's stored usage, which the cache section reads (ADR 0008).
    ...({ input_tokens: 41_200, cache_read_tokens: 1_486_300, cache_write_tokens: 96_400, output_tokens: 18_900, reasoning_tokens: 6_100, api_call_count: 38, estimated_cost_usd: 1.92, cost_status: "estimated", cost_source: "provider_models_api" } as object),
  }),
];

const said = (role: "user" | "assistant", text: string, minutes: number, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ role, text, timestamp: T0 + minutes * 60, ...extra });
const summary = (minutes: number, body: string) =>
  said(
    "assistant",
    `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions.\n\n${body}\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---`,
    minutes,
    { summary: true },
  );
const old = (n: number, from: number) =>
  Array.from({ length: n }, (_, i) => said(i % 2 ? "assistant" : "user", i % 2 ? "Checked; details above." : `Step ${i / 2 + 1}`, from + i, { compacted: true }));

const history: TranscriptMessage[] = [
  ...old(24, 0),
  summary(
    30,
    "## Goal\nKeep the NAS's nightly restic backup healthy.\n\n## Done so far\n- Snapshot 2026-11-02 finished at 03:12, 41.2 GB added, no errors.\n- Pruned snapshots older than 90 days (kept 14 daily, 8 weekly).\n\n## Open\n- The 03:00 job overlaps the scrub; move one of them.",
  ),
  ...old(12, 31).map((m) => ({ ...m })),
  summary(50, "## Goal\nKeep the NAS's nightly restic backup healthy.\n\n## Done so far\n- Moved the scrub to Sundays 05:00.\n- Restore test of /etc from last night: 1,204 files, all match.\n\n## Open\n- Rotate the nginx logs on the same box."),
  said("user", "Good. Now rotate the nginx logs on the NAS, keeping 14 days.", 52),
  said("assistant", "Done. `/etc/logrotate.d/nginx` now keeps **14** daily files, compressed, and I ran it once to check:\n\n```\nrotating log /var/log/nginx/access.log, log->rotateCount is 14\n```", 54),
  said("user", "And how full is the disk now?", 60),
  said("assistant", "`/srv` is at **71%** (5.1 TB of 7.2 TB). At the current rate of about 40 GB a night it reaches 90% in roughly five weeks.", 61),
];
if (shot !== "no-compactions") for (const m of history) server.storeMessage("nas", m);
else for (const m of history.filter((m) => !m.compacted && !m.summary)) server.storeMessage("nas", m);

const BREAKDOWN = {
  categories: [
    { color: "var(--context-usage-system)", id: "system_prompt", label: "System prompt", tokens: 6_210 },
    { color: "var(--context-usage-tools)", id: "tool_definitions", label: "Tool definitions", tokens: 14_904 },
    { color: "var(--context-usage-rules)", id: "rules", label: "Context files", tokens: 1_350 },
    { color: "var(--context-usage-skills)", id: "skills", label: "Skills", tokens: 2_118 },
    { color: "var(--context-usage-memory)", id: "memory", label: "Memory", tokens: 912 },
    { color: "var(--context-usage-conversation)", id: "conversation", label: "Conversation", tokens: 31_640 },
  ],
  context_max: 200_000,
  context_percent: 29,
  context_used: 57_420,
  context_source: "provider_usage_plus_estimate",
  context_estimated: true,
  estimated_total: 57_134,
  model: "claude-opus-5-5",
  context_files: [
    { label: "AGENTS.md", path: "/srv/nas-ops/AGENTS.md", chars: 5_200, est_tokens: 1_300, loaded: true, status: "loaded" },
    { label: "CLAUDE.md", path: "/srv/nas-ops/CLAUDE.md", chars: 180, est_tokens: 45, loaded: false, status: "shadowed" },
    { label: "SOUL.md", path: "/home/hermes/.hermes/SOUL.md", chars: 210, est_tokens: 53, loaded: true, status: "loaded" },
  ],
};
server.contextBreakdown =
  shot === "empty"
    ? { categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0, context_estimated: false, context_source: "provider_usage", model: "", context_files: [] }
    : BREAKDOWN;
server.compressResult = { status: "compressed", removed: 6, before_messages: 9, after_messages: 3, before_tokens: 33_800, after_tokens: 9_400, summary: { headline: "Compressed: 9 → 3 messages", token_line: "~33,800 → ~9,400 tokens" } };

const hermes = await connect(server.openPipe);
await hermes.sync();
await hermes.open("nas");
const runtime = server.runtimeIdOf("nas")!;
server.event(runtime, "session.info", { model: "claude-opus-5-5", provider: "anthropic", yolo: false, approval_mode: "manual" });
// "empty": a chat reopened on Hermes and not yet sent to, as the live server answers it: no usage frame has arrived,
// and its agent isn't built, so Hermes's breakdown is all zeros.
if (shot !== "empty") server.event(runtime, "session.usage", {
  usage: { model: "claude-opus-5-5", input: 41_200, output: 18_900, calls: 38, context_used: 57_420, context_max: 200_000, context_percent: 29, context_source: "provider_usage", context_estimated: false, compressions: shot === "no-compactions" ? 0 : 2 },
});
await hermes.idle();

function Host() {
  const snap = useSyncExternalStore(hermes.subscribe, hermes.getSnapshot);
  const chat = snap.chats.find((c) => c.id === "nas")!;
  return (
    <PreviewContext.Provider value={() => {}}>
      <div className="app">
        <main className="main">
          <ChatPane
            chat={chat}
            status={snap.status}
            draft=""
            onDraft={() => {}}
            onRetry={() => {}}
            onEdit={() => {}}
            onDismiss={() => {}}
            onAttach={async () => ({ attachments: [], refused: [] })}
            onSend={() => {}}
            onStop={() => {}}
            onAnswer={() => {}}
            footer={
              <StatusBar
                chat={chat}
                status={snap.status}
                context={{
                  inspect: () => hermes.inspectContext("nas"),
                  history: () => hermes.compactionHistory("nas"),
                  compact: () => hermes.compact("nas"),
                  cannotCompact: () => hermes.cannotCompact(),
                  openMemory: () => {},
                }}
              />
            }
          />
        </main>
      </div>
    </PreviewContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Host />);

const wait = async (find: () => Element | null | undefined, what: string) => {
  for (let i = 0; i < 200; i++) {
    const el = find();
    if (el) return el as HTMLElement;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never found ${what}`);
};
const button = (text: string | RegExp) => () =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
const settle = () => new Promise((r) => setTimeout(r, 400));

(await wait(button(shot === "empty" ? "Context not measured" : /% full/), "meter")).click();
if (shot === "window" || shot === "empty") await wait(() => document.querySelector(".inspector-section[aria-label=Total]"), "total");
if (shot === "compactions" || shot === "no-compactions" || shot === "confirm" || shot === "compacted" || shot === "narrow") {
  (await wait(() => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent === "Compactions"), "tab")).click();
  await wait(() => document.querySelector(".compactions, .inspector-note"), "history");
}
if (shot === "compactions" || shot === "narrow") (await wait(button("Show summary"), "summary")).click();
if (shot === "confirm" || shot === "compacted") (await wait(button("Compact now…"), "compact")).click();
if (shot === "compacted") {
  (await wait(button("Compact"), "confirm")).click();
  await wait(() => document.querySelector(".inspector-note[role=status]"), "result");
}
await settle();
(window as unknown as { ready: boolean }).ready = true;
