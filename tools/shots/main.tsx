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

const hermes = await connect(server.openPipe);
(window as unknown as { shots: unknown }).shots = { server, hermes };
createRoot(document.getElementById("root")!).render(
  <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />,
);
