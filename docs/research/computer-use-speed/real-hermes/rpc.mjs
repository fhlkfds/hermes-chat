// Signs in to a Hermes dashboard as the app does (transport.rs `Dashboard::sign_in`, `open_pipe`) and speaks JSON-RPC on
// `/api/ws`, for the Screen latency measurements (issue #172). Node's own WebSocket, no Origin header, as Rust sends.

export async function signIn(base, username, password) {
  const login = await fetch(new URL("auth/password-login", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "basic", username, password }),
  });
  if (!login.ok) throw new Error(`sign-in: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { base, cookie };
}

/** Opens `/api/ws` for `profile` and resolves once `gateway.ready` arrives. */
export async function openPipe(session, profile = "default", onEvent = () => {}) {
  const t = await fetch(new URL("api/auth/ws-ticket", session.base), { method: "POST", headers: { cookie: session.cookie } });
  if (!t.ok) throw new Error(`ws-ticket: ${t.status}`);
  const { ticket } = await t.json();
  const url = new URL("api/ws", session.base);
  url.protocol = url.protocol.replace("http", "ws");
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("profile", profile);
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  let ready;
  const readyP = new Promise((r) => (ready = r));
  ws.onmessage = (m) => {
    for (const line of String(m.data).split("\n")) {
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      if (f.method === "gateway.ready" || f.params?.type === "gateway.ready") ready();
      if (f.method) onEvent(f, line.length, performance.now());
      if (f.id != null && pending.has(f.id)) {
        const p = pending.get(f.id);
        pending.delete(f.id);
        f.error ? p.reject(Object.assign(new Error(f.error.message), f.error)) : p.resolve(f.result);
      }
    }
  };
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  await Promise.race([readyP, new Promise((r) => setTimeout(r, 3000))]);
  return {
    request(method, params) {
      const id = next++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}
