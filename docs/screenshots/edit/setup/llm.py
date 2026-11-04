# A stand-in OpenAI-compatible model for screenshots, loopback only; no real model is called. Each answer is the next
# of a fixed list of synthetic replies, so regenerated answers differ. A message asking for "the long disk check" gets
# a `terminal` tool call that sleeps, so a running tool can be shown.
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
REPLIES = [
    "Last week's report says 79%, so the NAS gained about 150 GB. `restic` snapshots account for 120 GB of it.",
    "Compared with week 44 it is 2 points fuller: 81% now against 79%. The growth is almost all in `backups/restic`.",
    "About 150 GB more is used than last week. If snapshots keep growing at this rate, the NAS reaches 90% in about six weeks.",
]
n = 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): sys.stderr.write("llm: " + (a[0] % a[1:]) + "\n")
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"): return self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        global n
        size = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(size) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"): return self._json(404, {"error": "not found"})
        msgs = body.get("messages") or []
        last = msgs[-1] if msgs else {}
        text = last.get("content") if isinstance(last.get("content"), str) else json.dumps(last.get("content"))
        sys.stderr.write(f"llm: {len(msgs)} messages in, last {last.get('role')}: {text!r:.100}\n")
        tool = None
        if last.get("role") == "user" and "long disk check" in (text or ""):
            tool = {"id": "call_long", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "sleep 240; df -h /srv"})}}
            reply = "Running the long check now."
        elif last.get("role") == "tool":
            reply = "The long check finished: `/srv` is 81% full."
        else:
            reply = REPLIES[n % len(REPLIES)]; n += 1
        usage = {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940}
        created = int(time.time())
        if not body.get("stream"):
            msg = {"role": "assistant", "content": reply, **({"tool_calls": [tool]} if tool else {})}
            return self._json(200, {"id": "stub", "object": "chat.completion", "created": created, "model": "stub-model",
                "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tool else "stop"}], "usage": usage})
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        def chunk(delta, finish=None, use=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": created, "model": "stub-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if use: c["usage"] = use
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode()); self.wfile.flush()
        chunk({"role": "assistant"})
        for w in reply.split(" "):
            chunk({"content": w + " "}); time.sleep(0.03)
        if tool:
            chunk({"tool_calls": [{"index": 0, **tool}]})
        chunk({}, "tool_calls" if tool else "stop", usage)
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.2", int(sys.argv[1])), H).serve_forever()
