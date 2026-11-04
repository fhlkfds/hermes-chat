# A tiny legacy JSON-RPC client for /api/ws, for probing Hermes's contract by hand. Throwaway dashboard only.
import asyncio, json, sys, urllib.request, http.cookiejar
import websockets
BASE = "http://127.0.0.2:19631"
cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def rest(method, path, body=None):
    req = urllib.request.Request(BASE + "/" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    try:
        with op.open(req) as r: return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return {"_http": e.code, "_body": e.read().decode()[:400]}
rest("POST", "auth/password-login", {"provider": "basic", "username": "fixture", "password": "fixture-pass-63"})
class WS:
    async def open(self, profile="default"):
        t = rest("POST", "api/auth/ws-ticket")["ticket"]
        self.ws = await websockets.connect(f"ws://127.0.0.2:19631/api/ws?ticket={t}&profile={profile}", max_size=None)
        self.n = 0; self.events = []
        print("ready:", (await self.ws.recv())[:200])
    async def call(self, method, params, wait=60):
        self.n += 1; rid = self.n
        await self.ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
        while True:
            for line in (await asyncio.wait_for(self.ws.recv(), wait)).splitlines():
                m = json.loads(line)
                if m.get("id") == rid: return m
                self.events.append(m)
    async def until(self, typ, wait=90):
        while True:
            for i, e in enumerate(self.events):
                if e.get("params", {}).get("type") == typ: return self.events.pop(i)
            for line in (await asyncio.wait_for(self.ws.recv(), wait)).splitlines(): self.events.append(json.loads(line))
def rows(sid):
    r = rest("GET", f"api/sessions/{sid}/messages?profile=default&order=oldest&limit=500&offset=0&inline_images=false")
    return [(m["id"], m["role"], (m.get("content") or "")[:70] if isinstance(m.get("content"), str) else m.get("content"), m.get("display_kind")) for m in r.get("messages", [])]
