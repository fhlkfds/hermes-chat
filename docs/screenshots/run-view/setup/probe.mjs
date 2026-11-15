// Runs one "check disk" turn on a throwaway Hermes and prints what the Run view builds on (#602): each event with its
// arrival offset, the stored rows of the turn, the session's cost before and after, and display.tool_progress.
import { openPipe, signIn } from "./rpc.mjs";
const base = process.argv[2];
const s = await signIn(base, "fixture", "fixture-pass-123");
const get = async (p) => (await fetch(new URL(p, base), { headers: { cookie: s.cookie } })).json();
const t0 = performance.now();
const seen = [];
let done;
const finished = new Promise((r) => (done = r));
const pipe = await openPipe(s, "default", (f) => {
  const type = f.params?.type ?? f.method;
  if (f.method !== "event" && !f.id) return;
  const p = f.params?.payload ?? f.params ?? {};
  const brief = { "message.start": p, "tool.start": { tool_id: p.tool_id, name: p.name, args: p.args }, "tool.complete": { tool_id: p.tool_id, duration_s: p.duration_s, result: String(JSON.stringify(p.result)).slice(0, 120) }, "session.usage": p.usage && { calls: p.usage.calls, input: p.usage.input, output: p.usage.output }, "message.complete": { status: p.status, usage: p.usage && { calls: p.usage.calls }, persisted_turn: p.persisted_turn }, "status.update": p }[type];
  if (type !== "message.delta" && type !== "gateway.ready") seen.push(`${((performance.now() - t0) / 1000).toFixed(2)}s ${type} ${brief ? JSON.stringify(brief) : ""}`);
  if (type === "message.complete" || type === "error") done();
});
const created = await pipe.request("session.create", { profile: "default" });
const sid = created.session_id;
await pipe.request("prompt.submit", { session_id: sid, text: "check disk please" });
await finished;
await new Promise((r) => setTimeout(r, 1500));
console.log(seen.join("\n"));
const stored = created.stored_session_id ?? created.info?.stored_session_id ?? sid;
const list = await get("api/sessions?profile=default&limit=5");
const id = (list.sessions ?? list)[0]?.id;
const row = await get(`api/sessions/${id}?profile=default`);
console.log("session cost", row.estimated_cost_usd, row.cost_status, "calls", row.api_call_count);
const msgs = await get(`api/sessions/${id}/messages?profile=default&order=latest&limit=100&inline_images=false`);
for (const m of msgs.messages.reverse()) console.log("row", m.id, m.role, m.timestamp, m.tool_call_id ?? "", typeof m.tool_calls, String(m.tool_calls ?? "").slice(0, 110), String(m.content ?? "").slice(0, 60));
const cfg = await get("api/config?profile=default");
console.log("display.tool_progress", JSON.stringify(cfg.display?.tool_progress));
pipe.close();
process.exit(0);
