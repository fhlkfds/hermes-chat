// A stand-in Hermes dashboard for timing the Screen tab in the real Tauri app (issue #172): sign-in, the WS ticket and
// `/api/ws` from the tests' FakeHermes, with a running Bot Desktop, and `/api/display/ws` spliced to a REAL Xvnc's RFB
// Unix socket the way Hermes's own bridge does it (hermes_cli/web_routers/display.py `_bridge`): each read of the RFB
// socket, up to 64 KiB, goes out as one binary WebSocket message, and a full send buffer pauses the reads
// (Hermes awaits `send_bytes`). Loopback only.
//   npx rolldown docs/research/computer-use-speed/bridge.ts --platform node -o <scratch>/bridge.mjs
//   node <scratch>/bridge.mjs <port> <rfb.sock> <stats.jsonl>
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { FakeHermes } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47872);
const rfbPath = process.argv[3];
const statsPath = process.argv[4];
const server = new FakeHermes();
server.display = {
  status: { supported: true, installed: true, missing: [], running: true, geometry: "1440x900", blocker: null, install_command: null },
  lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 1 },
  minted: new Set(),
};

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

function header(op: number, len: number): Buffer {
  if (len < 126) return Buffer.from([0x80 | op, len]);
  if (len < 65536) return Buffer.from([0x80 | op, 126, len >> 8, len & 255]);
  const h = Buffer.alloc(10);
  h[0] = 0x80 | op;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}
const frame = (op: number, body: Buffer) => Buffer.concat([header(op, body.length), body]);

function readFrames(sock: Socket, on: (op: number, data: Buffer) => void) {
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
      if (op === 8) {
        sock.end(frame(8, data.subarray(0, 2)));
        return;
      }
      if (op === 9) sock.write(frame(10, data));
      else on(op, data);
    }
  });
}

// Per-second counts of what the display socket sent: messages, bytes, and the size spread.
const stats = { messages: 0, bytes: 0, small: 0 };
setInterval(() => {
  if (statsPath && stats.messages) appendFileSync(statsPath, JSON.stringify({ t: performance.now() / 1000, ...stats }) + "\n");
  stats.messages = stats.bytes = stats.small = 0;
}, 1000);

function display(ws: Socket) {
  const rfb = connect(rfbPath);
  rfb.setNoDelay?.(true);
  ws.setNoDelay(true);
  rfb.on("data", (chunk: Buffer) => {
    stats.messages++;
    stats.bytes += chunk.length;
    if (chunk.length < 1024) stats.small++;
    if (!ws.write(frame(2, chunk))) {
      rfb.pause();
      ws.once("drain", () => rfb.resume());
    }
  });
  readFrames(ws, (op, data) => {
    if (op === 2 && !rfb.write(data)) {
      ws.pause();
      rfb.once("drain", () => ws.resume());
    }
  });
  const end = () => {
    rfb.destroy();
    ws.destroy();
  };
  rfb.on("close", end);
  rfb.on("error", end);
  ws.on("close", end);
  ws.on("error", end);
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
  if (url.pathname === "/api/display/ws") return display(sock);
  send = (t) => sock.writable && sock.write(frame(1, Buffer.from(t)));
  readFrames(sock, (op, data) => op === 1 && void pipe!.send(data.toString()));
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`bench dashboard on http://127.0.0.1:${port}`));
