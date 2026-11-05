// A stand-in Hermes dashboard for screenshots of Setup in the real Tauri app (#101): `/api/status`, password sign-in,
// the WS ticket, `/api/ws`, dashboard REST and the provider-key routes, answered by the tests' FakeHermes with
// synthetic data. Loopback only. Username `liam`, password `hunter2`.
//   npx rolldown docs/screenshots/setup-101/bridge.ts --platform node -o <scratch>/bridge.mjs && node <scratch>/bridge.mjs 47901
// Switches, each a plain GET, so a screenshot can show one failure at a time:
//   /__gate on|off       a gateway that refuses requests without CF-Access-Client-Id (403 on everything)
//   /__canonical on|off  gateway.ready says the server speaks the canonical session protocol
//   /__hold on|off       password sign-in waits until switched off, so Save and connect can be stopped
// Provider keys: one containing "good" is accepted; any other is turned down, with a message that quotes it, to show
// Hermes Chat never displays it.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47901);
const server = new FakeHermes();
server.sessions = [row("plan-1", 0.2, { title: "Plan the backup runbook", source: "gui" }), row("nas-2", 1.5, { title: "NAS disk usage", source: "gui" })];
server.storeMessage("plan-1", { role: "user", text: "Draft a backup runbook for the NAS." });
server.storeMessage("plan-1", { role: "assistant", text: "Here's a first draft: nightly snapshots, weekly off-site copies, and a monthly restore test." });
const flags = { gate: false, canonical: false, hold: false };
const held: (() => void)[] = [];

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

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
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(v));
  };
  const sw = /^\/__(gate|canonical|hold) (on|off)$/.exec(`${url.pathname} ${url.search.slice(1)}`);
  if (sw) {
    flags[sw[1] as keyof typeof flags] = sw[2] === "on";
    if (sw[1] === "canonical") server.readyPayload = { ...server.readyPayload, session_authority: flags.canonical ? "server" : undefined };
    if (sw[1] === "hold" && !flags.hold) held.splice(0).forEach((go) => go());
    console.log("flags", flags);
    return json(200, flags);
  }
  console.log(req.method, url.pathname, req.headers["cf-access-client-id"] ? "(with CF-Access-Client-Id)" : "");
  if (flags.gate && !req.headers["cf-access-client-id"]) {
    res.writeHead(403, { "content-type": "text/html" });
    return res.end("<html><body>Forbidden: Cloudflare Access</body></html>");
  }
  if (url.pathname === "/auth/password-login") {
    const b = JSON.parse(body ?? "{}");
    if (b.username !== "liam" || b.password !== "hunter2") return json(401, { detail: "Invalid credentials" });
    if (flags.hold) await new Promise<void>((go) => held.push(go));
    return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  }
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  if (url.pathname === "/api/providers/validate") {
    const b = JSON.parse(body ?? "{}");
    return String(b.value).includes("good")
      ? json(200, { ok: true, reachable: true, message: "Key accepted" })
      : json(200, { ok: false, reachable: true, message: `Invalid API key: ${b.value}` });
  }
  if (req.method === "PUT" && url.pathname === "/api/env") {
    const b = JSON.parse(body ?? "{}");
    const rowFor = server.env?.[b.key];
    if (rowFor) server.env![b.key] = { ...rowFor, is_set: true, redacted_value: `${String(b.value).slice(0, 3)}…${String(b.value).slice(-2)}` };
    return json(200, { ok: true });
  }
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
  if (flags.gate && !req.headers["cf-access-client-id"]) return void sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => void pipe!.send(t));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));
