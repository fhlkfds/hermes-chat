// A stand-in Hermes dashboard for the Troubleshoot screenshots (#175, ADR 0053): sign-in, the WS ticket, `/api/ws` and
// dashboard REST, all answered by the tests' FakeHermes with synthetic `[fixture]` jobs and runs. Loopback only. Build
// and run:
//   npx rolldown docs/screenshots/jobs-troubleshoot/bridge.ts --platform node -o /tmp/bridge.mjs && node /tmp/bridge.mjs 47875
// `GET /__fix` plays Hermes's side of the troubleshooting chat: it shows the agent calling its `cronjob` tool, changes
// the job's delivery and prompt on the stand-in server as that tool would, and ends the reply with what it changed.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FakeHermes, row } from "../../../src/hermes/fakeHermes";
import type { Pipe } from "../../../src/hermes/pipe";
import { isoIn } from "../../../src/hermes/schedule";

const port = Number(process.argv[2] ?? 47875);
const server = new FakeHermes();
server.sessions = [row("notes", 0.3, { pinned: true, title: "Plan the week" })];
server.storeMessage("notes", { role: "user", text: "What's on this week?" });
server.storeMessage("notes", { role: "assistant", text: "Three things: the backup check, the digest, and the release." });
server.cron.jobs = { default: [] };
const digest = server.cron.add("default", {
  name: "[fixture] Morning digest",
  prompt: "Summarise the overnight alerts from the monitoring folder and send me the three that need action today.",
  schedule: "0 7 * * 1-5",
  deliver: "discord",
});
server.cron.add("default", { name: "[fixture] Backup check", prompt: "Check last night's backup log and say if anything failed.", schedule: "0 6 * * *", deliver: "telegram" });
server.cron.add("default", { name: "[fixture] Weekly release notes", prompt: "Draft release notes from this week's merged PRs.", schedule: "0 16 * * 5", paused: true });
const now = Math.floor(Date.now() / 1000);
const day = 86_400;
const lastRun = now - 3 * 3600;
Object.assign(digest, {
  // Stamped with the profile's offset, as Hermes stamps it.
  last_run_at: isoIn(server.cron.timezone, lastRun * 1000),
  last_status: "delivery_failed",
  last_error: null,
  last_delivery_error: "Discord: no home channel is set for this profile (DISCORD_HOME_CHANNEL).",
});
server.cron.runs[digest.id] = [
  { id: "digest-3", source: "cron", started_at: lastRun, ended_at: lastRun + 74, end_reason: "cron_complete", profile: "default" },
  { id: `cron_output:${digest.id}:2`, title: "DELIVERY FAILED · Discord: no home channel is set for this profile (DISCORD_HOME_CHANNEL).", preview: "3 alerts need action today: disk on db-2 at 91%, cert for api expires Friday, nightly ETL retried twice.", source: "cron_output", started_at: lastRun - day + 74 },
  { id: "digest-1", source: "cron", started_at: lastRun - 2 * day, ended_at: lastRun - 2 * day + 41, end_reason: "cron_incomplete_no_output", profile: "default" },
];
server.storeMessage("digest-3", { role: "user", text: "Summarise the overnight alerts…" });
server.storeMessage("digest-3", {
  role: "assistant",
  text: "3 alerts need action today:\n1. Disk on db-2 at 91%.\n2. The TLS certificate for api expires Friday.\n3. The nightly ETL retried twice (token=sk-fixture000000000000000000 in its log).",
});

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

/** Hermes's side of the troubleshooting chat, as the agent's `cronjob` tool would do it. */
function fix() {
  const rt = [...server.runtime.keys()].at(-1);
  if (!rt) return;
  const job = server.cron.jobs.default.find((j) => j.id === digest.id)!;
  server.event(rt, "message.delta", { text: "The runs finish, but delivery fails: Discord has no home channel on this profile, while Telegram has one. " });
  server.event(rt, "tool.start", { tool_id: "t1", name: "cronjob", args: { action: "list" } });
  server.event(rt, "tool.complete", { tool_id: "t1", duration_s: 0.2, summary: "3 jobs" });
  server.event(rt, "message.delta", { text: "I'll switch delivery to Telegram and ask for the list in a plain numbered form.\n\n" });
  const suffix = ' Reply as a numbered list, and say "No alerts" when there are none.';
  const prompt = String(job.prompt).endsWith(suffix) ? String(job.prompt) : `${String(job.prompt)}${suffix}`;
  server.event(rt, "tool.start", { tool_id: "t2", name: "cronjob", args: { action: "update", job_id: digest.id, deliver: "telegram", prompt } });
  job.deliver = "telegram";
  job.prompt = prompt;
  server.event(rt, "tool.complete", { tool_id: "t2", duration_s: 0.3, summary: "updated" });
  // A streamed turn: the summary goes as deltas, and the end repeats nothing (as Hermes does when it streams).
  server.event(rt, "message.delta", {
    text:
      "**Changes to “[fixture] Morning digest”:**\n\n- Delivery: `discord` → `telegram`\n- Prompt: added *Reply as a numbered list, and say \"No alerts\" when there are none.*\n\nUse **Run now** in Hermes Chat to check the fix. To keep Discord instead, set `DISCORD_HOME_CHANNEL` for this profile.",
  });
  server.event(rt, "message.complete", { text: "" });
}

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
  if (url.pathname === "/__fix") {
    fix();
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
