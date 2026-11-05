// Runs one real chat turn on a Hermes dashboard and records the `/api/ws` events the app would get: when each tool
// started and ended, and how big each event was. Prints the turn's length, then one JSON line per event.
//
// Usage: node turn.mjs <dashboard URL> <username> <password file> "<prompt>"
// `loop.py` splits the output into model round trips and tool times.
import { readFileSync } from "node:fs";
import { signIn, openPipe } from "./rpc.mjs";

const [base, user, pwFile, prompt] = process.argv.slice(2);
const session = await signIn(base, user, readFileSync(pwFile, "utf8").trim());
const t0 = performance.now();
const log = [];
let done;
const finished = new Promise((r) => (done = r));
const quiet = new Set(["message.delta", "reasoning.delta", "thinking.delta", "session.usage", "status.update"]);
const pipe = await openPipe(session, "default", (f, chars, at) => {
  const type = f.params?.type ?? f.method;
  const p = f.params?.payload ?? f.params ?? {};
  if (quiet.has(type)) return;
  log.push({ t: +(at - t0).toFixed(0), type, kB: +(chars / 1024).toFixed(1), name: p.name, args: p.args && JSON.stringify(p.args), dur: p.duration_s && +p.duration_s.toFixed(2) });
  if (type === "message.complete") done();
});
const { session_id } = await pipe.request("session.create", { profile: "default", source: "hermes-chat" });
const started = performance.now();
await pipe.request("prompt.submit", { session_id, profile: "default", text: prompt });
await Promise.race([finished, new Promise((r) => setTimeout(r, 240_000))]);
console.log("turn", ((performance.now() - started) / 1000).toFixed(1), "s");
for (const e of log) console.log(JSON.stringify(e));
process.exit(0);
