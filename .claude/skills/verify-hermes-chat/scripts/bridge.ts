// The verification stand-in Hermes dashboard: the HTTP/WebSocket boundary the Rust side talks to, answered by the
// tests' FakeHermes (src/hermes/fakeHermes.ts) with fixed synthetic chats. Loopback only. `hv up` bundles and starts it.
//   node bridge.mjs <port> <state-file>
// Sign-in: username `verify`, password `verify-pass`; anything else is 401 "Invalid credentials", as Hermes answers.
// Every prompt gets a short streamed reply that starts `Stand-in reply to:` and is stored in the chat's history.
// HV_DELAY_MS=<ms> holds each /api/ answer that long, as a distant server's round trip would.
// Read-only check of what the server holds (the side-effect proof): `GET /__state` returns sessions and transcripts.
// The same JSON is rewritten to <state-file> after every change, so it survives the bridge being stopped.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47990);
const stateFile = process.argv[3];
const USER = "verify";
const PASSWORD = "verify-pass";
const server = new FakeHermes();
const delayMs = Number(process.env.HV_DELAY_MS ?? 0);

// Synthetic seed data. Feature recipes in ../features/ name these titles; change both together.
server.sessions = [
  row("backup", 0.02, { title: "Nightly backup failing", message_count: 2 }),
  row("nginx", 0.5, { title: "Rotate nginx logs", message_count: 2 }),
  row("vpn", 2, { title: "Why is the VPN slow", message_count: 2 }),
  row("trip", 6, { title: "Plan a weekend in Lisbon", message_count: 2 }),
];
server.storeMessage("backup", { role: "user", text: "Why did the nightly backup fail?" });
server.storeMessage("backup", { role: "assistant", text: "The restic repository was still **locked** from a killed prune. Run `restic unlock`, then re-run the backup." });
server.storeMessage("nginx", { role: "user", text: "Keep 14 days of nginx logs." });
server.storeMessage("nginx", { role: "assistant", text: "Done: `rotate 14`, `daily`, `compress`." });
server.storeMessage("vpn", { role: "user", text: "Why is the VPN slow tonight?" });
server.storeMessage("vpn", { role: "assistant", text: "MTU 1500 on a 1420 tunnel: packets fragment. Set `MTU = 1380`." });
server.storeMessage("trip", { role: "user", text: "Plan a weekend in Lisbon." });
server.storeMessage("trip", { role: "assistant", text: "Day 1: Alfama and the castle. Day 2: Belém and the LX Factory." });

// Settings → MCP servers (ADR 0068): a second profile, servers of each kind, one from a plugin, Test results and a catalog.
server.otherProfiles = { work: [] };
server.mcp.servers.default = {
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"] },
  github: { url: "https://mcp.example.com/github", headers: { Authorization: "Bearer ${MCP_GITHUB_API_KEY}" } },
  linear: { url: "https://mcp.example.com/linear/sse", auth: "oauth" },
  weather: { command: "uvx", args: ["weather-mcp"], env: { WEATHER_API_KEY: "wk-synthetic-0123456789" }, enabled: false },
};
server.mcp.env.default = { MCP_GITHUB_API_KEY: "ghp-synthetic-token" };
server.mcp.plugins.default = { kanban: { plugin: "kanban-board", cfg: { command: "kanban-mcp", args: ["--stdio"] } } };
server.mcp.servers.work = { calendar: { command: "cal-mcp" } };
server.mcp.probes = {
  filesystem: { tools: ["read_file", "write_file", "list_directory", "search_files"].map((name) => ({ name, description: `Synthetic ${name.replace("_", " ")}` })) },
  github: { error: "HTTP 401 from POST https://mcp.example.com/github: Bearer token rejected" },
};
server.mcp.catalogEntries = [
  { name: "context7", description: "Up-to-date library docs for the model", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  { name: "brave-search", description: "Web search through the Brave Search API", transport: "stdio", command: "npx", args: ["-y", "brave-search-mcp"], env: [{ name: "BRAVE_API_KEY", prompt: "Brave Search API key" }] },
];

// Clone a profile (ADR 0074): `default` has a persona and own skills to copy.
server.souls.default = "You are Hermes, the house's ops assistant. Answer briefly and name the command to run.\n";
for (const name of ["restic-unlock", "nginx-rotate", "vpn-mtu", "trip-planner", "disk-usage", "cert-renew"])
  server.skills.add("default", { dir: `/home/liam/.hermes/skills/ops/${name}`, source: "agent", category: "ops" }, `---\nname: ${name}\ndescription: Synthetic ${name} skill.\n---\n\n## When to Use\n\nWhen asked about ${name}.\n`);

// MCP servers as each profile's config holds them; the `.env` (tokens) stays out.
const dump = () => JSON.stringify({ sessions: server.sessions, transcripts: server.transcripts, mcp: server.mcp.servers }, null, 2);
const save = () => stateFile && writeFileSync(stateFile, dump());
save();

function replyTo(sessionId: string, prompt: string) {
  const text = `Stand-in reply to: ${prompt.slice(0, 80)}`;
  server.event(sessionId, "message.start");
  const words = text.split(" ");
  let at = 0;
  const step = () => {
    const from = at;
    at = Math.min(words.length, at + 3);
    server.event(sessionId, "message.delta", { text: words.slice(from, at).join(" ") + (at < words.length ? " " : "") });
    if (at < words.length) return void setTimeout(step, 120);
    const stored = server.runtime.get(sessionId);
    if (stored) server.storeMessage(stored, { role: "assistant", text });
    setTimeout(() => {
      server.event(sessionId, "message.complete", { text, status: "complete" });
      save();
    }, 120);
  };
  setTimeout(step, 400);
}

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

// The smallest WebSocket server the Rust client needs: text frames, client frames masked, no extensions.
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(body.length), 2);
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
      let len = buf[1] & 127,
        off = 2;
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
  if (delayMs && url.pathname.startsWith("/api/")) await new Promise((r) => setTimeout(r, delayMs));
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof v === "string" ? v : JSON.stringify(v));
  };
  console.log(new Date().toISOString(), req.method, url.pathname);
  if (url.pathname === "/__state") return json(200, dump());
  if (url.pathname === "/auth/password-login") {
    const b = JSON.parse(body ?? "{}");
    if (b.username !== USER || b.password !== PASSWORD) return json(401, { detail: "Invalid credentials" });
    return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  }
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  try {
    const text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    json(200, text);
    if (req.method !== "GET") save();
  } catch (e) {
    const m = /answered (\d+): (.*)$/s.exec((e as Error).message);
    json(m ? Number(m[1]) : 500, m ? m[2] : { detail: (e as Error).message });
  }
});
http.on("upgrade", async (req, sock: Socket) => {
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => {
    try {
      const msg = JSON.parse(t) as { method?: string; params?: { session_id?: string; text?: string } };
      if (msg.method === "prompt.submit" && msg.params?.session_id) {
        const { session_id, text } = msg.params;
        setTimeout(() => (save(), replyTo(session_id, String(text ?? ""))), 0);
      }
    } catch {
      // Not JSON: FakeHermes answers it as it would.
    }
    void pipe!.send(t);
  });
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`stand-in dashboard ready on http://127.0.0.1:${port}`));
