// A stand-in Hermes dashboard for the Outputs "Missing" screenshots (#223, ADR 0064) in the real Tauri app: sign-in,
// the WS ticket, `/api/ws` and dashboard REST, answered by the tests' FakeHermes. One synthetic chat wrote two files:
// a notes file that is still on the server, and a script its own terminal call deleted right after running it, as
// the chat in #223 did. The sign-in takes only the throwaway password below. Loopback only.
//   npx rolldown docs/screenshots/outputs-missing/bridge.ts --platform node -o /tmp/outputs-bridge.mjs
//   node /tmp/outputs-bridge.mjs 127.0.0.2 19223
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row, type TranscriptMessage } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";

const host = process.argv[2] ?? "127.0.0.2";
const port = Number(process.argv[3] ?? 19223);
const install = "install-home";
const PASSWORD = "fixture-pass-123";
const server = new FakeHermes();

// Synthetic: nothing here came from a real chat.
const at = 1_793_845_000;
const call = (id: string, name: string, args: Record<string, unknown>, result: unknown, rowId: number): TranscriptMessage[] => [
  { role: "assistant", text: "", row_id: rowId, timestamp: at + rowId, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
  { role: "tool", name, tool_call_id: id, args, context: String(args.path ?? args.command ?? ""), row_id: rowId + 1, timestamp: at + rowId, result: JSON.stringify(result) },
];
const written = (path: string, bytes: number) => ({ bytes_written: bytes, dirs_created: true, verified: true, resolved_path: path, files_modified: [path] });
const SCRIPT = "/home/liam/.hermes/cache/scratch/hermes-verify-install.sh";
const NOTES = "/home/liam/notes/install-check.md";
server.sessions = [
  row("verify", 0.01, { title: "Verify the skills installer", pinned: true }),
  row("nas", 1, { title: "NAS disk usage", pinned: true }),
];
server.transcripts.verify = [
  { role: "user", text: "Check that install.sh in ai-skills is idempotent.", row_id: 1, timestamp: at },
  ...call("w1", "write_file", { path: SCRIPT }, written(SCRIPT, 2109), 2),
  ...call("t1", "terminal", { command: `bash ${SCRIPT}; rc=$?; rm -f ${SCRIPT}; exit $rc` }, { output: "PASS 8/8", exit_code: 0 }, 4),
  ...call("w2", "write_file", { path: NOTES }, written(NOTES, 412), 6),
  { role: "assistant", text: "**PASS, 8/8.** The temporary script ran and was deleted; notes are in `install-check.md`.", row_id: 8, timestamp: at + 8 },
];
server.serverFiles["/home/liam/.hermes/cache/scratch/.last_prune"] = "";
server.serverFiles[NOTES] = "# install.sh check\n\nFresh install, rerun and changed skill: all pass.\n";
server.transcripts.nas = [
  { role: "user", text: "How full is the NAS?", row_id: 1, timestamp: at - 100 },
  { role: "assistant", text: "The `tank` pool is at **71%**.", row_id: 2, timestamp: at - 99 },
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
  if (url.pathname === "/auth/password-login")
    return JSON.parse(body ?? "{}").password === PASSWORD
      ? json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" })
      : json(401, { detail: "Invalid credentials" });
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
http.listen(port, host, () => console.log(`fake dashboard ${install} on http://${host}:${port}`));
