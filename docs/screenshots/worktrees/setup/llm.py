# A stand-in OpenAI-compatible model for screenshots: answers every chat completion with a fixed synthetic reply,
# streamed or not. Loopback only. No real model is called.
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
REPLY = "I'm working in `/tmp/hc82/srv/weather-api.worktrees/fix-timeout` on `fix/timeout`. The timeout is set in `config/defaults.toml`; I'll raise it there."
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): sys.stderr.write("llm: " + (a[0] % a[1:]) + "\n")
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"): return self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"): return self._json(404, {"error": "not found"})
        msgs = body.get("messages") or []
        sys.stderr.write(f"llm: {len(msgs)} messages in, last user: {next((m.get('content') for m in reversed(msgs) if m.get('role')=='user'), '')!r:.120}\n")
        created = int(time.time())
        if not body.get("stream"):
            return self._json(200, {"id": "stub", "object": "chat.completion", "created": created, "model": "stub-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940}})
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        def chunk(delta, finish=None, usage=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": created, "model": "stub-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage: c["usage"] = usage
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode()); self.wfile.flush()
        chunk({"role": "assistant"})
        for w in REPLY.split(" "):
            chunk({"content": w + " "}); time.sleep(0.03)
        chunk({}, "stop", {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.2", int(sys.argv[1])), H).serve_forever()
