// A stand-in Hermes dashboard for screenshots of the Settings screen in the real Tauri app: sign-in, the WS ticket,
// `/api/ws` and dashboard REST, all answered by the tests' FakeHermes seeded with synthetic profiles, skills, memory,
// memory providers and a persona. Loopback only.
//   npx rolldown docs/screenshots/settings-redesign/bridge.ts --platform node -o /tmp/settings-bridge.mjs && node /tmp/settings-bridge.mjs 47898
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row, type SessionRow } from "../../../src/hermes/fakeHermes";
import { BYTEROVER, HONCHO, RETAINDB } from "../../../src/hermes/fakeMemoryProviders";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47898);
const server = new FakeHermes();
let failWork = false;

// Deterministic synthetic data: nothing here came from a real chat, skill or memory.
const TITLES = [
  "Rotate nginx logs", "NAS disk usage", "Draft the backup runbook", "Why is the VPN slow", "Grafana alert noise", "Plan the Postgres upgrade",
  "Nightly report", "Clean up old Docker images", "Fix the cron mailer", "Write the onboarding checklist", "Check certificate expiry", "Size the new VM",
];
const chat = (i: number, profile = "default"): SessionRow =>
  row(`${profile}-${i}`, 0.3 + i * 1.7, { title: TITLES[i % TITLES.length], source: ["gui", "desktop", "telegram", "cron"][i % 4], pinned: i < 3 });
server.sessions = Array.from({ length: 12 }, (_, i) => chat(i));
server.otherProfiles = {
  work: Array.from({ length: 6 }, (_, i) => chat(i, "work")),
  research: Array.from({ length: 4 }, (_, i) => chat(i, "research")),
  aegis: [chat(0, "aegis")],
  scribe: [chat(1, "scribe")],
};
server.storeMessage("default-0", { role: "user", text: "Can you rotate the nginx logs and keep 14 days?" });
server.storeMessage("default-0", { role: "assistant", text: "Done. `logrotate` now keeps **14** daily archives." });

const HOME = "/home/liam/.hermes";
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
const SKILLS: [string, string, string, string, string?][] = [
  ["code-review", "agent", "coding", "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to review since X."],
  ["bro", "agent", "writing", "Restate the last message in plain human language, with no jargon."],
  ["release-notes", "agent", "writing", "Use when asked for release notes. Writes them from merged pull requests."],
  ["grill-me", "agent", "planning", "Interview the user in rounds until a loose idea is sharp enough to commit to. Stateless: writes no files."],
  ["deploy-checklist", "agent", "ops", "Walk the deploy checklist for a service: migrations, feature flags, rollback plan, and the on-call handoff note."],
  ["incident-report", "agent", "ops", "Write a blameless incident report from a timeline: impact, detection, root cause, and follow-ups with owners."],
  ["sql-tuning", "agent", "coding", "Explain a slow Postgres query from EXPLAIN ANALYZE output and propose indexes or rewrites, with the trade-offs of each."],
  ["house-style", "external", "writing", "Use for any document. The team house style, shared between profiles."],
  ["architecture-diagram", "bundled", "creative", "Dark-themed SVG architecture/cloud/infra diagrams as HTML."],
  ["arxiv", "bundled", "research", "Search arXiv papers by keyword, author, category, or ID."],
  ["ascii-video", "bundled", "creative", "ASCII video: convert video/audio to colored ASCII MP4/GIF."],
  ["github", "bundled", "coding", "Work with GitHub: issues, pull requests and checks through the gh CLI."],
  ["hermes-agent", "bundled", "", "Hermes itself: how the agent, its gateway and its tools fit together."],
  ["spreadsheet", "hub", "data", "Read, clean and chart tabular data from CSV or XLSX files."],
];
for (const [name, source, category, description] of SKILLS) {
  const dir = source === "external" ? `/srv/shared-skills/${name}` : source === "agent" ? `${HOME}/skills/${category}/${name}` : `${HOME}/skills/${name}`;
  server.skills.add("default", { dir, source, ...(category ? { category } : {}) } as never, skill(name, description, "## When to use\n\nFollow the steps below.\n"));
}
server.skills.add("work", { dir: `${HOME}/profiles/work/skills/standup`, source: "agent", category: "writing" } as never, skill("standup", "Write the daily standup note from yesterday's commits.", "Body.\n"));

server.memory = {
  default: {
    memory: [
      "Owner runs Arch Linux with sway; prefers keyboard shortcuts over menus.",
      "The NAS is at nas.lan; backups run nightly at 02:00 through restic.",
      "Owner prefers short answers and code blocks over prose.",
      "Grafana alerts go to the #ops channel; the noisy one is disk-io-latency.",
      "The Postgres upgrade to 17 is planned for the first weekend of December.",
    ],
    profile: ["Name: Liam. Timezone: America/Chicago.", "Works in IT at a school; also runs a home lab.", "Likes terse, factual replies."],
  },
  work: { memory: ["Work profile: the ticket queue lives in GitHub Issues.", "Standup is at 09:15."], profile: ["Role: sysadmin."] },
  research: { memory: ["Research profile: cite sources as numbered footnotes."], profile: [] },
  aegis: { memory: [], profile: [] },
  scribe: { memory: ["Scribe profile: meeting notes go to the Notes folder."], profile: [] },
};
const providers = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "aegis", "research", "scribe"] } as never, { ...RETAINDB } as never, { ...BYTEROVER } as never);
providers.active = { default: "honcho", aegis: "honcho", research: "honcho", scribe: "honcho", work: "" };
providers.set("default", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
providers.set("aegis", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
providers.set("research", "honcho", { workspace: "hermes_research", aiPeer: "hermes_research", peerName: "owner" });
providers.set("scribe", "honcho", { workspace: "hermes_scribe", aiPeer: "hermes_scribe", peerName: "owner" });
providers.setSecret("default", "honcho", "apiKey");
providers.setSecret("aegis", "honcho", "apiKey");

server.souls.default = "# SOUL.md\n\nYou are Hermes, a calm and precise assistant for a sysadmin who runs a home lab.\n\n## Voice\n\n- Short sentences. Facts first.\n- Code in fenced blocks, never inline for commands.\n- Ask one question at a time when something is unclear.\n\n## Boundaries\n\n- Never run destructive commands without confirming.\n- Say when you are unsure.\n";

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

// The smallest WebSocket server the Rust client needs: text frames, client frames masked, no extensions.
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2);
    return h;
  })();
  return Buffer.concat([head, body]);
}
function readFrames(sock: Socket, onText: (t: string) => void) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127, off = 2;
      if (buf.length < (len === 126 ? 4 : len === 127 ? 10 : 2)) return;
      if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
      else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if (op === 1) onText(data.toString());
      else if (op === 8) sock.end();
      else if (op === 9) sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
    }
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString() || undefined;
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(v));
  };
  if (url.pathname === "/auth/password-login") return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  // `GET /__fail-work` makes the work profile's list answer 503 from then on, as a busy store does.
  if (url.pathname === "/__fail-work") {
    failWork = true;
    return json(200, { ok: true });
  }
  if (failWork && url.pathname === "/api/sessions" && url.searchParams.get("profile") === "work")
    return json(503, { detail: "Session store is busy (disk I/O or lock). Retry; the list was not cleared." });
  try {
    const text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(text);
  } catch (e) {
    const m = /answered (\d+): (.*)$/s.exec((e as Error).message);
    res.writeHead(m ? Number(m[1]) : 500, { "content-type": "application/json" });
    res.end(m ? m[2] : JSON.stringify({ detail: (e as Error).message }));
  }
});
http.on("upgrade", async (req, sock: Socket) => {
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => void pipe!.send(t));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));
