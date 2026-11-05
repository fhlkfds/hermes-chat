// A stand-in Hermes dashboard for the Follow-up behavior screenshots (#189, ADR 0055): sign-in, the WS ticket, `/api/ws`
// and dashboard REST, all answered by the tests' FakeHermes with synthetic chats. Loopback only. Build and run:
//   npx rolldown docs/screenshots/follow-up/bridge.ts --platform node -o /tmp/follow-up-bridge.mjs && node /tmp/follow-up-bridge.mjs 47810
// NO_STEER=1 serves a Hermes whose `commands.catalog` doesn't list /steer. Hermes's side of the reply is scripted:
// `GET /__stream` starts it with a running tool call, `GET /__continue` ends the tool call and streams more text, and
// `GET /__finish` ends the reply. No model runs.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47810);
const server = new FakeHermes();
if (process.env.NO_STEER) server.commandCatalog = ["context", "help"];
server.sessions = [
  row("backup", 0.02, { pinned: true, title: "Nightly backup check", message_count: 2 }),
  row("nginx", 0.2, { pinned: true, title: "Rotate nginx logs" }),
  row("disk", 2, { title: "NAS disk usage" }),
];
server.storeMessage("backup", { role: "user", text: "Did last night's restic backup finish?" });
server.storeMessage("backup", { role: "assistant", text: "Yes. The snapshot finished at 03:12 with **41.2 GB** added and no errors." });

/** The runtime session of the chat the reply runs in: the last one opened. */
const runtime = () => [...server.runtime.keys()].at(-1);

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
  const rt = runtime();
  if (url.pathname === "/__stream" && rt) {
    server.event(rt, "message.start");
    server.event(rt, "message.delta", { text: "I'll run a restore test of `/etc` from last night's snapshot and compare it with the live folder." });
    server.event(rt, "tool.start", { tool_id: "t1", name: "terminal", preview: "restic restore latest --target /tmp/restore-test --include /etc" });
    return json(200, { ok: true });
  }
  if (url.pathname === "/__continue" && rt) {
    server.event(rt, "tool.complete", { tool_id: "t1", duration_s: 14.2, summary: "Restored 1,284 files" });
    server.event(rt, "message.delta", { text: "Restored. Comparing only `/etc/nginx`, as you asked: 12 files, all identical." });
    return json(200, { ok: true });
  }
  if (url.pathname === "/__finish" && rt) {
    server.event(rt, "message.complete", { status: "complete" });
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
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => sock.writable && sock.write(frame(t));
  readFrames(sock, (t) => void pipe!.send(t));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`fake dashboard on http://127.0.0.1:${port}`));
