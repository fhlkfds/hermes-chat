// A stand-in Hermes dashboard for screenshots of tags and filters in the real Tauri app, the slash-commands bridge with
// other synthetic chats: sources, models, one older than the list's month and one archived. Loopback only. Build and run:
//   npx rolldown docs/screenshots/tags/bridge.ts --platform node -o /tmp/tags-bridge.mjs && node /tmp/tags-bridge.mjs 47800
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47800);
const server = new FakeHermes();
const opus = "claude-opus-5-5", sonnet = "claude-sonnet-5-5", gpt = "gpt-6.1";
server.sessions = [
  row("backup", 0.02, { pinned: true, title: "Nightly backup check", model: opus }),
  row("nginx", 0.3, { pinned: true, title: "Rotate nginx logs", model: sonnet }),
  row("nas", 1.2, { pinned: true, source: "telegram", title: "NAS disk usage", model: sonnet }),
  row("vpn", 2, { title: "WireGuard peer for the laptop", model: gpt }),
  row("dns", 4, { source: "discord", title: "Pi-hole blocklist update", model: opus }),
  row("certs", 9, { title: "Renew TLS certificates", model: opus }),
  row("budget", 15, { title: "Grocery budget spreadsheet", model: gpt }),
  row("restic", 48, { title: "restic retention policy", model: opus }),
  row("printer", 6, { archived: true, title: "Printer driver on Arch", model: sonnet }),
];
server.transcripts = {
  backup: [
    { role: "user", text: "Did last night's restic backup finish?" },
    { role: "assistant", text: "Yes. The snapshot finished at 03:12 with 41.2 GB added and no errors." },
  ],
  nas: [{ role: "user", text: "How full are the NAS disks? The backup lands there." }],
  restic: [{ role: "assistant", text: "Keep 7 daily, 4 weekly and 12 monthly backup snapshots." }],
  certs: [{ role: "user", text: "Renew the certificates for the backup server too." }],
};

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
