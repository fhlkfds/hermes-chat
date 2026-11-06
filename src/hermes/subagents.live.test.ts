// Subagents against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set. It signs in, starts a chat
// whose model delegates, and folds what Hermes sends through the app's own tree (subagents.ts). Then it steers one
// subagent and stops another with the exact params the transport sends, and checks what a second connection that
// resumes the chat sees. It needs a model that delegates as the fake model at ~/.cache/hermes-live-95/fakemodel.py does:
// three subagents (NEST starts one of its own, SLOW sleeps, FAIL is refused by the model). It starts subagents and a
// chat on the server, so run it only against a throwaway dashboard:
//
//   HERMES_LIVE_DASHBOARD=http://127.0.0.95:47295/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=… \
//   npx vitest run src/hermes/subagents.live.test.ts --disableConsoleIntercept
import { describe, expect, it } from "vitest";
import { RpcError } from "./transport";
import { childrenOf, isFailure, onRoster, onSubagentEvent, parseOutput, type Subagent, type SubagentTree } from "./subagents";

declare const process: { env: Record<string, string | undefined> };
const BASE = process.env.HERMES_LIVE_DASHBOARD;

type Frame = { type: string; session_id?: string; payload: Record<string, unknown> };

async function socket() {
  let cookie = "";
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const login = await send("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
  if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);
  const { ticket } = (await (await send("POST", "api/auth/ws-ticket")).json()) as { ticket: string };
  const url = new URL(`api/ws?ticket=${encodeURIComponent(ticket)}&profile=default`, BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const events: Frame[] = [];
  const waiters: (() => void)[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("the WebSocket failed"));
    ws.onmessage = (m) => {
      for (const line of String(m.data).split("\n").filter((l) => l.trim())) {
        const f = JSON.parse(line);
        if (f.method === "event") {
          if (f.params?.type === "gateway.ready") resolve();
          events.push({ type: f.params.type, session_id: f.params.session_id, payload: f.params.payload ?? {} });
          waiters.splice(0).forEach((w) => w());
        }
        // An Approval or other question: this test answers nothing, as the app never answers for the owner.
        const p = typeof f.id === "number" ? pending.get(f.id) : undefined;
        if (!p) continue;
        pending.delete(f.id);
        if (f.error) p.reject(new RpcError(f.error.code, f.error.message));
        else p.resolve(f.result);
      }
    };
  });
  let id = 0;
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  /** Waits until `done` holds of the events so far, up to `ms`. */
  const until = async (done: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 1000);
      });
    }
  };
  return { rpc, events, until, close: () => ws.close() };
}

const treeOf = (events: Frame[], sid: string) =>
  events.filter((e) => e.session_id === sid && e.type.startsWith("subagent.")).reduce<SubagentTree | undefined>((t, e, i) => onSubagentEvent(t, e.type, e.payload, i), undefined);
const byGoal = (t: SubagentTree | undefined, word: string): Subagent | undefined => t?.subagents.find((s) => s.goal.startsWith(word));
const show = (t?: SubagentTree) => t?.subagents.map((s) => `${"  ".repeat(s.depth)}${s.state.padEnd(11)} ${s.goal} [${s.id}]${s.summary ? ` — ${s.summary.slice(0, 90)}` : ""}`).join("\n");

describe.skipIf(!BASE)("Subagents against a real dashboard", () => {
  it("builds the tree from Hermes's events and roster, and steers and stops one subagent only", { timeout: 600_000 }, async () => {
    const a = await socket();
    const created = await a.rpc("session.create", { profile: "default", source: "gui" });
    const sid: string = created.session_id;
    const stored: string = created.stored_session_id;
    await a.rpc("prompt.submit", { session_id: sid, profile: "default", text: "Please delegate the audit." });
    await a.until(() => {
      const t = treeOf(a.events, sid);
      return !!byGoal(t, "SLOW Check")?.state && !!t && isFailure(byGoal(t, "FAIL")?.state ?? "running") && byGoal(t, "SLOW Run")?.state === "running";
    }, 240_000, "three subagents, a grandchild, and the refused one failing");
    let tree = treeOf(a.events, sid)!;
    console.log(`Events: ${[...new Set(a.events.filter((e) => e.type.startsWith("subagent.")).map((e) => e.type))].join(", ")}\n${show(tree)}`);

    const nest = byGoal(tree, "NEST")!;
    const slow = byGoal(tree, "SLOW Run")!;
    const grandchild = byGoal(tree, "SLOW Check")!;
    expect(childrenOf(tree).map((s) => s.goal.split(" ")[0])).toEqual(["NEST", "SLOW", "FAIL"]);
    expect(childrenOf(tree, nest.id).map((s) => s.id)).toEqual([grandchild.id]);
    // Hermes counts the reply's own subagents as depth 0.
    expect([nest.depth, grandchild.depth, grandchild.parent]).toEqual([0, 1, nest.id]);
    expect(slow).toMatchObject({ state: "running", model: "fake" });

    const roster = await a.rpc("subagent.list", { session_id: sid });
    console.log("subagent.list", JSON.stringify(roster));
    tree = onRoster(tree, roster, Date.now())!;
    expect(tree.sync).toEqual({ kind: "live" });
    expect(byGoal(tree, "SLOW Run")).toMatchObject({ state: "running", acceptingSteer: true });

    const tail = parseOutput(await a.rpc("subagent.tail", { session_id: sid, subagent_id: slow.id }));
    console.log("subagent.tail", JSON.stringify(tail).slice(0, 300));

    // A second connection that resumes the chat while it's live is given the same session, so it lists the subagents
    // and Hermes takes its steer too.
    const b = await socket();
    const resumed = await b.rpc("session.resume", { session_id: stored, profile: "default", inline_images: false });
    const other = await b.rpc("subagent.list", { session_id: resumed.session_id });
    const fromB = await b.rpc("subagent.steer", { session_id: resumed.session_id, subagent_id: slow.id, text: "SECOND: from the other connection" });
    const tailB = parseOutput(await b.rpc("subagent.tail", { session_id: resumed.session_id, subagent_id: slow.id }));
    console.log(`second connection: session ${resumed.session_id} (first: ${sid}) lists ${other.subagents.length}; steer ${fromB.status}; tail available ${tailB.available}`);
    expect(other.subagents.map((r: { subagent_id: string }) => r.subagent_id)).toContain(slow.id);
    b.close();

    expect(await a.rpc("subagent.steer", { session_id: sid, subagent_id: slow.id, text: "STEERED: skip the flaky tests" })).toMatchObject({ status: "queued" });
    expect(await a.rpc("subagent.interrupt", { session_id: sid, subagent_id: nest.id })).toMatchObject({ found: true });
    await a.until(() => {
      const t = treeOf(a.events, sid);
      return byGoal(t, "NEST")?.state === "interrupted" && byGoal(t, "SLOW Run")?.state === "completed";
    }, 240_000, "the stopped one to end, and its sibling to finish with the steer");
    tree = onRoster(treeOf(a.events, sid), await a.rpc("subagent.list", { session_id: sid }), Date.now())!;
    console.log(show(tree));
    expect(byGoal(tree, "NEST")!.state).toBe("interrupted");
    // The stop reached the grandchild under it, and nothing else.
    expect(byGoal(tree, "SLOW Check")!.state).not.toBe("running");
    expect(byGoal(tree, "SLOW Run")).toMatchObject({ state: "completed", summary: expect.stringContaining("STEERED: skip the flaky tests") });
    for (const s of tree.subagents) if (s.id !== slow.id) expect(s.summary ?? "", s.goal).not.toContain("STEERED");
    a.close();
  });
});
