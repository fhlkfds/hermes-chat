// A stand-in Hermes dashboard for screenshots of where speech to text runs (ADR 0062) in the real Tauri app: sign-in, the
// WS ticket, `/api/ws` and dashboard REST, all answered by the tests' FakeHermes. Speech to text on this computer is the
// real one (Rust and a real whisper.cpp); only Hermes is a stand-in. Loopback only. From voice-providers/bridge.ts.
//   npx rolldown docs/screenshots/speech-to-text/bridge.ts --platform node -o <scratch>/stt-bridge.mjs && node <scratch>/stt-bridge.mjs 47892
// Control routes:
//   GET /__fail   makes Hermes's transcription answer a provider error, as a profile without a working provider does
//   GET /__ok     makes it answer again
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const port = Number(process.argv[2] ?? 47892);
let failing = false;
const server = new FakeHermes();
const voice = server.voiceProviders;

// Synthetic chats and set-up: nothing here came from a real server.
server.sessions = [row("backup", 0.2, { pinned: true, title: "Nightly backup" }), row("nas", 1, { title: "NAS disk usage" })];
server.transcripts = {
  backup: [
    { role: "user", text: "Why did last night's backup fail?" },
    { role: "assistant", text: "The restic repository was still locked from the run before. I removed the stale lock and started it again; it finished at 03:12." },
  ],
  nas: [{ role: "user", text: "How full is the NAS?" }],
};
server.otherProfiles = { work: [] };
server.heard = "Check the backup logs";
voice.env.default = new Set(["GROQ_API_KEY"]);
voice.set("default", "stt.provider", "groq");

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
  const profile = url.searchParams.get("profile") ?? "default";
  if (url.pathname === "/auth/password-login") return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  if (url.pathname === "/__fail" || url.pathname === "/__ok") {
    failing = url.pathname === "/__fail";
    return json(200, { ok: true });
  }
  // What Rust's voice set-up reads: the two audio routes (probed with bodies they refuse) and the profile's config.
  if (url.pathname === "/api/audio/transcribe" || url.pathname === "/api/audio/speak") {
    const sent = JSON.parse(body ?? "{}");
    if (url.pathname.endsWith("transcribe") && failing && sent.data_url)
      return json(400, { detail: "No STT provider available: GROQ_API_KEY is not set" });
    if (url.pathname.endsWith("transcribe"))
      return sent.data_url ? json(200, { ok: true, transcript: server.heard, provider: voice.provider(profile, "stt") }) : json(400, { detail: "Audio recording is empty" });
    return json(400, { detail: sent.text ? "The stand-in dashboard doesn't synthesize speech" : "Text is required" });
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    const c = voice.config(profile);
    return json(200, {
      stt: { enabled: true, provider: voice.provider(profile, "stt"), ...c.stt },
      tts: { provider: voice.provider(profile, "tts"), ...c.tts },
      voice: { silence_duration: 1.5 },
    });
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
