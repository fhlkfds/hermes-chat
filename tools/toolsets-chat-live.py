"""Live check for Settings → Toolsets against a throwaway Hermes dashboard: does a toolset change reach an open chat's
next turn, a new chat, and a chat reopened after a reconnect? It answers from what Hermes actually sends the model.

Needs a disposable dashboard (never the owner's) whose profile's model is a stub OpenAI-compatible endpoint that logs
each request's tool names, one JSON line per request (`{"tools": [...]}`), to STUB_LOG. Everything here is Hermes's own
routes, as the app uses them: `PUT /api/tools/toolsets/{name}`, and over `/api/ws` `session.create`, `prompt.submit`,
`tools.show`, `session.status`, `session.resume`. It turns `web` off, then back on at the end.

    ~/.hermes/hermes-agent/venv/bin/python -I tools/toolsets-chat-live.py http://127.0.0.2:9472 tester PASSWORD STUB_LOG
"""
import asyncio
import json
import sys

import httpx
import websockets

BASE, USER, PASSWORD, STUB_LOG = sys.argv[1:5]
GRACE_S = 25  # past Hermes's default 20 s park for a session whose socket closed (HERMES_TUI_WS_ORPHAN_REAP_GRACE_S)


class Socket:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def rpc(self, method, params, wait_event=None):
        self.n += 1
        await self.ws.send(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}))
        answer, seen = None, wait_event is None
        while answer is None or not seen:
            f = json.loads(await asyncio.wait_for(self.ws.recv(), 60))
            if f.get("id") == self.n:
                answer = f
            elif wait_event and f.get("method") == "event" and f["params"].get("type") in (wait_event, "error"):
                seen = True
        return answer


async def socket(http):
    ticket = (await http.post("/api/auth/ws-ticket")).json()["ticket"]
    ws_url = BASE.replace("http", "ws", 1) + f"/api/ws?ticket={ticket}&profile=default"
    return await websockets.connect(ws_url)


def stub_turns():
    open(STUB_LOG, "a").close()
    with open(STUB_LOG) as f:
        return [json.loads(line)["tools"] for line in f if line.strip()]


async def turn(s, sid):
    """One real turn; the tool names Hermes sent the model for it."""
    before = len(stub_turns())
    r = await s.rpc("prompt.submit", {"session_id": sid, "text": "hi"}, wait_event="message.complete")
    assert "error" not in r, r
    # The chat's own request carries its tools; Hermes's title generation, which may run beside it, carries none.
    asked = [tools for tools in stub_turns()[before:] if tools]
    assert asked, "the stub model got no request for the turn"
    return asked[0]


async def chat_has(s, sid):
    shown = (await s.rpc("tools.show", {"session_id": sid}))["result"]
    status = await s.rpc("session.status", {"session_id": sid})
    assert "error" not in status, f"Hermes no longer holds {sid}: tools.show answered for its launch profile"
    return {t["name"] for sec in shown["sections"] for t in sec["tools"]}


async def main():
    results = []

    def check(what, ok):
        results.append((what, ok))
        print(("PASS " if ok else "FAIL ") + what)

    async with httpx.AsyncClient(base_url=BASE) as http:
        r = await http.post("/auth/password-login", json={"provider": "basic", "username": USER, "password": PASSWORD})
        r.raise_for_status()

        async def set_web(on):
            r = await http.put("/api/tools/toolsets/web?profile=default", json={"enabled": on})
            r.raise_for_status()
            listed = {t["name"]: t["enabled"] for t in (await http.get("/api/tools/toolsets?profile=default")).json()}
            assert listed["web"] is on, listed

        await set_web(True)
        ws = await socket(http)
        s = Socket(ws)
        created = (await s.rpc("session.create", {"profile": "default"}))["result"]
        sid, stored = created["session_id"], created["stored_session_id"]
        check("an open chat's first turn offers web_search", "web_search" in await turn(s, sid))
        check("tools.show reads web_search for that chat", "web_search" in await chat_has(s, sid))

        await set_web(False)
        check("after turning web off, the open chat still has web_search (tools.show)", "web_search" in await chat_has(s, sid))
        check("and its next turn still offers web_search", "web_search" in await turn(s, sid))
        other = (await s.rpc("session.create", {"profile": "default"}))["result"]["session_id"]
        check("a chat started after the change doesn't offer web_search on its first turn", "web_search" not in await turn(s, other))

        await ws.close()
        ws = await socket(http)
        s = Socket(ws)
        quick = (await s.rpc("session.resume", {"session_id": stored, "profile": "default"}))["result"]["session_id"]
        check("reopened right after a reconnect, Hermes reattaches the same session", quick == sid)
        check("which keeps web_search (tools.show)", "web_search" in await chat_has(s, quick))

        await ws.close()
        print(f"waiting {GRACE_S} s for Hermes to let the parked session go…")
        await asyncio.sleep(GRACE_S)
        ws = await socket(http)
        s = Socket(ws)
        gone = await s.rpc("session.status", {"session_id": sid})
        check("after the wait, Hermes no longer holds the old session (session.status 4001)", gone.get("error", {}).get("code") == 4001)
        late = (await s.rpc("session.resume", {"session_id": stored, "profile": "default"}))["result"]["session_id"]
        check("reopened after a late reconnect, it is a new session", late != sid)
        check("which doesn't have web_search (tools.show)", "web_search" not in await chat_has(s, late))
        check("and whose next turn doesn't offer web_search", "web_search" not in await turn(s, late))
        await ws.close()
        await set_web(True)

    print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
    sys.exit(0 if all(ok for _, ok in results) else 1)


asyncio.run(main())
