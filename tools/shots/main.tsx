// The real signed-in app against the fake Hermes, seeded with a few chats, so `shoot.mjs` can screenshot it.
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { Main } from "../../src/App";
import { FakeHermes, row } from "../../src/hermes/fakeHermes";
import { connect } from "../../src/hermes/transport";
import { appearanceStore } from "../../src/ui/appearance";

const mode = new URLSearchParams(location.search).get("mode") ?? "dark";
localStorage.setItem("hermes-chat.appearance", JSON.stringify({ scheme: mode }));
appearanceStore(localStorage, document.documentElement);

const server = new FakeHermes();
server.sessions = [
  row("backup", 0.02, { pinned: true, title: "Nightly backup failing", message_count: 6 }),
  row("nas", 0.3, { pinned: true, title: "NAS disk usage", source: "telegram" }),
  row("caddy", 1, { title: "Caddy reverse proxy config", last_read_at: 0 }),
  row("rust", 2, { title: "Rust lifetimes question" }),
  row("trip", 4, { title: "Plan a weekend in Lisbon" }),
  row("grafana", 9, { title: "Grafana dashboard for UPS" }),
  row("zfs", 20, { title: "ZFS scrub schedule" }),
];
server.transcripts = {
  backup: [
    { role: "user", text: "Why did the nightly backup fail last night?" },
    {
      role: "assistant",
      text:
        "The restic job exited with **status 1** because the repository was still locked from an earlier run that was killed mid-prune.\n\n" +
        "Here's what I found in the journal:\n\n```bash\n$ journalctl -u restic-backup --since yesterday\nFatal: unable to create lock in backend: repository is already locked by PID 4127\n```\n\n" +
        "To fix it:\n\n1. Make sure no other restic process is running.\n2. Remove the stale lock with `restic unlock`.\n3. Re-run the backup by hand to confirm it completes.\n\nWant me to do steps 1–3 now?",
    },
    { role: "user", text: "Yes, go ahead." },
    { role: "assistant", text: "Done — the lock is cleared and a fresh snapshot `a91f3c2e` finished in 4m 12s. I also added `--retry-lock 10m` to the unit so a short overlap won't fail the job again." },
  ],
  nas: [{ role: "user", text: "How full is the NAS?" }, { role: "assistant", text: "The `tank` pool is at **71%** (5.1 TiB of 7.2 TiB)." }],
};

// Automations (ADR 0033): one GitHub route on a webhooks/1 server, with a made-up delivery history.
server.sessions.push(row("hook-41", 0.05, { source: "webhook", title: "Triage example/fixture#41" }));
server.webhooks.baseUrl = "https://hooks.example.net";
server.webhooks.add("default", "triage-issues", {
  provider: "github",
  events: ["issues"],
  filters: [{ field: "action", equals: "opened" }],
  coalesce: { key: "{repository.full_name}#{issue.number}", window_seconds: 30, max_wait_seconds: 300 },
  prompt: "New issue #{issue.number} on {repository.full_name}: {issue.title}\n\nRead it and suggest labels and a first reply.",
});
server.webhooks.rejections = { default: { "triage-issues": { bad_signature: { count: 3, last_at: Date.now() / 1000 - 5400 } } } };
const ago = (min: number) => Date.now() / 1000 - min * 60;
const issue = (n: number, title: string) => ({ "repository.full_name": "example/fixture", "issue.number": n, "issue.title": title });
for (const d of [
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000001", received_at: ago(180), state: "filtered", reason: "event:push", event: "push", action: null, excerpt: { ref: "refs/heads/main" } },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000002", received_at: ago(150), state: "filtered", reason: "filter", action: "closed", excerpt: issue(38, "[fixture] Typo in the README") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000003", received_at: ago(95), state: "completed", outcome: "completed", session_id: "hook-41", duplicates: 1, excerpt: issue(41, "[fixture] Sync stalls on a slow link") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000004", received_at: ago(40), state: "failed", reason: "failed", outcome: "failed", session_id: "hook-41", retryable: true, retry_needs_confirmation: true, excerpt: issue(42, "[fixture] Crash when the list is empty") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000005", received_at: ago(3), state: "superseded", superseded_by: "4f1c2a90-0000-4000-8000-000000000006", coalesce_key: "example/fixture#43", action: "opened", excerpt: issue(43, "[fixture] Dark mode contrast") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000006", received_at: ago(2), state: "running", session_id: "hook-41", action: "edited", excerpt: issue(43, "[fixture] Dark mode contrast") },
])
  server.webhooks.addDelivery("default", "triage-issues", { updated_at: d.received_at, ...d });

const hermes = await connect(server.openPipe);
(window as unknown as { shots: unknown }).shots = { server, hermes };
createRoot(document.getElementById("root")!).render(
  <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />,
);
