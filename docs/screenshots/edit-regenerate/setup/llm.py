# A stand-in OpenAI-compatible model for issue #63's checks: loopback only, no real model. Each completion answers
# "Variant reply #N (model M) to: <last user words>", so regenerated variants are told apart. A last user message
# containing "slowly" streams over ~20 s; one containing "run the long command" first asks for a `terminal` tool call
# (`sleep 25`), so a tool is running while the app is checked.
import json, sys, time, itertools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
N = itertools.count(1)
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): sys.stderr.write("llm: " + (a[0] % a[1:]) + "\n")
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"): return self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}, {"id": "stub-model-large", "object": "model"}]})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"): return self._json(404, {"error": "not found"})
        msgs = body.get("messages") or []
        def text(c): return c if isinstance(c, str) else " ".join(p.get("text", "") for p in c if isinstance(p, dict)) if isinstance(c, list) else ""
        last = next((text(m.get("content")) for m in reversed(msgs) if m.get("role") == "user"), "")
        last_role = msgs[-1].get("role") if msgs else ""
        model = body.get("model", "?")
        sys.stderr.write(f"llm: {len(msgs)} messages in, roles={[m.get('role') for m in msgs]}, model={model}, last user: {last!r:.160}\n")
        created = int(time.time())
        tool = "run the long command" in last and last_role != "tool"
        if tool:
            reply, calls = "", [{"index": 0, "id": f"call_{created}", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "sleep 25 && echo done"})}}]
        else:
            short = " ".join(last.split()[-8:])
            reply, calls = f"Variant reply #{next(N)} (model {model}) to: {short}", None
        slow = "slowly" in last
        if not body.get("stream"):
            msg = {"role": "assistant", "content": reply or None}
            if calls: msg["tool_calls"] = [{k: v for k, v in c.items() if k != "index"} for c in calls]
            return self._json(200, {"id": "stub", "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if calls else "stop"}],
                "usage": {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940}})
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        def chunk(delta, finish=None, usage=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": created, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage: c["usage"] = usage
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode()); self.wfile.flush()
        chunk({"role": "assistant"})
        if calls:
            chunk({"tool_calls": calls}); chunk({}, "tool_calls", {"prompt_tokens": 900, "completion_tokens": 20, "total_tokens": 920})
        else:
            words = reply.split(" ")
            for w in words:
                chunk({"content": w + " "}); time.sleep(20 / len(words) if slow else 0.03)
            chunk({}, "stop", {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.2", int(sys.argv[1])), H).serve_forever()
