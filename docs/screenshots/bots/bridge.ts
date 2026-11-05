// A stand-in Hermes dashboard for screenshots of the Bots view (ADR 0066) in the real Tauri app: sign-in, the WS ticket,
// `/api/ws` and dashboard REST, all answered by the tests' FakeHermes with synthetic bots and chats. Loopback only.
//   npx rolldown docs/screenshots/bots/bridge.ts --platform node -o /tmp/bots-bridge.mjs && node /tmp/bots-bridge.mjs 47822
// `GET /__bot-mode?none` (or `?no-canonical`, `?full`) switches how much Bot Mode it has.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47822);
const server = new FakeHermes();
const nowS = () => Date.now() / 1000;

/** A 64x64 PNG with a diagonal two-colour gradient, as a data URL: a synthetic bot picture. */
function picture(a: [number, number, number], b: [number, number, number]): string {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
    return out;
  };
  const rows: number[] = [];
  for (let y = 0; y < 64; y++) {
    rows.push(0);
    for (let x = 0; x < 64; x++) for (let i = 0; i < 3; i++) rows.push(Math.round(a[i] + ((b[i] - a[i]) * (x + y)) / 126));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

// Synthetic data only: nothing here came from a real chat. Each profile is a bot; scribe and ops have a Bot Chat,
// which Hermes keeps hidden from every list.
server.sessions = [
  row("disk", 0.2, { pinned: true, title: "NAS disk usage", last_read_at: nowS() }),
  row("vpn", 1.5, { title: "Why is the VPN slow", last_read_at: nowS() }),
  row("backup", 3, { title: "Draft the backup runbook", last_read_at: nowS() }),
];
server.otherProfiles = {
  scribe: [
    row("scribe-bot", 0.003, { title: "Bot Chat", hidden: true, last_read_at: nowS(), message_count: 4 }),
    row("scribe-side", 2, { pinned: true, title: "Changelog wording", last_read_at: nowS() }),
  ],
  ops: [row("ops-bot", 0.02, { title: "Bot Chat", hidden: true, last_read_at: nowS(), message_count: 2 })],
  "night-watch": [],
};
server.transcripts = {
  disk: [{ role: "user", text: "How full is the NAS?" }, { role: "assistant", text: "The pool is at 71%: 5.1 of 7.2 TB." }],
  vpn: [{ role: "user", text: "Why is the VPN slow tonight?" }],
  backup: [{ role: "user", text: "Draft the backup runbook, with the release checklist at the end." }],
  "scribe-bot": [
    { role: "user", text: "Draft the release notes for 0.9." },
    { role: "assistant", text: "Here's a draft: three fixes, the new Bots view, and faster search. Want a shorter version for the changelog?" },
    { role: "user", text: "Yes, and keep the release date out of it." },
    { role: "assistant", text: "Release notes drafted: three fixes and the new Bots view, without the date." },
  ],
  "scribe-side": [{ role: "user", text: "Which release wording reads better?" }],
  "ops-bot": [
    { role: "user", text: "Restart the media stack once the backup finishes." },
    { role: "assistant", text: "The backup finished. Restarting the media stack needs your approval." },
  ],
};
server.profileMeta = {
  scribe: { description: "Writes release notes and changelogs", ui_meta: { "hermes-bots": { title: "Scribe", color: "#3f8f6b", pinned: true } } },
  ops: { description: "Watches the home server", display_name: "Ops", ui_meta: { "hermes-bots": { color: "#b0613a" } } },
  "night-watch": { description: "Checks the logs every night", ui_meta: { "hermes-bots": { title: "Night Watch", color: "#5b5fb0", hidden: true } } },
};
server.botAvatars = { scribe: picture([63, 143, 107], [214, 196, 98]) };
// Scribe is replying in its Bot Chat; Ops waits on an Approval there.
server.liveSessions = [
  { id: "rt-scribe", session_key: "scribe-bot", status: "working", last_active: nowS() - 4 },
  { id: "rt-ops", session_key: "ops-bot", status: "waiting", last_active: nowS() - 60 },
];

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
  // `GET /__bot-mode?none|no-canonical|full` makes it answer as a Hermes without Bot Mode, for that screenshot.
  if (url.pathname === "/__bot-mode") {
    server.botMode = (url.search.slice(1) || "full") as typeof server.botMode;
    return json(200, { botMode: server.botMode });
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
