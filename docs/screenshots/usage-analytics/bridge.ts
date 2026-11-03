// A stand-in Hermes dashboard for screenshots of Usage analytics in the real Tauri app: sign-in, the WS ticket,
// `/api/ws` and dashboard REST, all answered by the tests' FakeHermes with synthetic chats and usage. Loopback only.
//   npx rolldown docs/screenshots/usage-analytics/bridge.ts --platform node -o /tmp/usage-bridge.mjs && node /tmp/usage-bridge.mjs 47810
// `GET /__fail-work` makes the `work` profile's chat list answer 503, for the partial-failure screenshot.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row, type SessionRow } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47810);
const server = new FakeHermes();
let failWork = false;

// Deterministic synthetic data: nothing here came from a real chat.
let seed = 74;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const MODELS: [string, string, (input: number) => [string | null, number | null, number | null]][] = [
  ["z-ai/glm-5.3-flash", "openrouter", (i) => ["estimated", i * 6.2e-8, null]],
  ["gpt-6.1-terra", "openai", (i) => ["actual", i * 2.5e-7, i * 2.5e-7]],
  ["claude-sonnet-5.5", "anthropic", () => ["included", 0, null]],
  ["deepseek/deepseek-v4-flash", "openrouter", (i) => (rand() < 0.5 ? ["unknown", i * 1.4e-7, null] : [null, null, null])],
];
const SOURCES = ["gui", "gui", "desktop", "telegram", "cron", "cli"];
const TITLES = [
  "Rotate nginx logs", "NAS disk usage", "Draft the backup runbook", "Why is the VPN slow", "Grafana alert noise", "Plan the Postgres upgrade",
  "Nightly report", "Summarise the Wazuh alerts", "Clean up old Docker images", "Fix the cron mailer", "Write the onboarding checklist",
  "Compare UPS battery logs", "Rename the media folders", "Check certificate expiry", "Tidy the Ansible inventory", "Size the new VM",
];
function chat(i: number, profile = "default"): SessionRow {
  const [model, provider, price] = MODELS[Math.floor(rand() * MODELS.length)];
  const input = Math.round(2_000 + rand() * 180_000);
  const cacheRead = rand() < 0.7 ? Math.round(input * (1 + rand() * 4)) : 0;
  const cacheWrite = provider === "anthropic" ? Math.round(input * 0.3) : 0;
  const output = Math.round(300 + rand() * 9_000);
  const [status, est, actual] = price(input);
  return row(`${profile}-${i}`, rand() * 29.5, {
    title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (${Math.floor(i / TITLES.length) + 1})` : ""}`,
    source: SOURCES[Math.floor(rand() * SOURCES.length)],
    model, billing_provider: provider,
    input_tokens: input, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, output_tokens: output,
    reasoning_tokens: Math.round(output * rand() * 0.4), api_call_count: 1 + Math.floor(rand() * 14),
    cost_status: status, estimated_cost_usd: est, actual_cost_usd: actual, cost_source: status === "estimated" ? "provider_models_api" : null,
    pinned: rand() < 0.3, archived: rand() < 0.1,
  });
}
server.sessions = Array.from({ length: 42 }, (_, i) => chat(i));
// A compressed chat: listed once under its last segment, with its first segment's counts; the later one read by id.
server.sessions.push(
  row("long-root", 6, {
    title: "Migrate the mail server", source: "desktop", model: "gpt-6.1-terra", billing_provider: "openai", _lineage_ids: ["long-root", "long-tip"],
    listedAs: { id: "long-tip", model: "gpt-6.1-terra" }, input_tokens: 610_000, cache_read_tokens: 1_900_000, cache_write_tokens: 0, output_tokens: 31_000,
    reasoning_tokens: 9_000, api_call_count: 54, cost_status: "actual", estimated_cost_usd: 0.1525, actual_cost_usd: 0.1525,
  }),
  row("long-tip", 5.9, {
    unlisted: true, model: "gpt-6.1-terra", input_tokens: 420_000, cache_read_tokens: 800_000, cache_write_tokens: 0, output_tokens: 12_000,
    reasoning_tokens: 4_000, api_call_count: 41, cost_status: "estimated", estimated_cost_usd: 0.105, actual_cost_usd: null,
  }),
);
// Subagent runs: Hermes counts them, no chat list shows them.
for (let i = 0; i < 6; i++)
  server.sessions.push(row(`delegate-${i}`, rand() * 20, { unlisted: true, source: "desktop", model: "z-ai/glm-5.3-flash", input_tokens: 90_000, output_tokens: 2_000, cache_read_tokens: 0, api_call_count: 6, cost_status: "estimated", estimated_cost_usd: 0.0056 }));
server.otherProfiles = { work: Array.from({ length: 12 }, (_, i) => chat(i, "work")) };
server.helperUsage.default = [
  { task: "background_review", input_tokens: 1_204_000, output_tokens: 31_200, estimated_cost: 0.1742, api_calls: 61, models: ["deepseek/deepseek-v4-flash"] },
  { task: "title_generation", input_tokens: 18_400, output_tokens: 820, estimated_cost: 0.0021, api_calls: 44, models: ["deepseek/deepseek-v4-flash"] },
  { task: "compression", input_tokens: 43_385, output_tokens: 12_323, estimated_cost: 0.0062, api_calls: 1, models: ["deepseek/deepseek-v4-flash"] },
];
server.storeMessage("default-0", { role: "user", text: "Can you rotate the nginx logs and keep 14 days?" });
server.storeMessage("default-0", { role: "assistant", text: "Done. `logrotate` now keeps **14** daily archives, compressed after a day." });

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
