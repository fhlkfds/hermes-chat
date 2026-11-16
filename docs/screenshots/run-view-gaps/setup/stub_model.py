"""OpenAI-compatible stub model for a throwaway Hermes, for the Run view's drops: no real model.

A user message containing `check disk` makes two model calls: one asks for `terminal` (sleep 10, then df), long enough
to drop the app's connection while it runs; the last answers. Each call takes 0.8 s. Any other prompt gets a plain answer.
    python stub_model.py <host> <port>
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def plan(messages):
    last = messages[-1]
    if last.get("role") == "tool":
        return {"content": "The disk check ran after a long wait. /tmp has room to spare."}
    text = last.get("content")
    if isinstance(text, list):
        text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
    text = str(text or "")
    if "check disk" in text:
        return {"tool_calls": [("terminal", {"command": "sleep 10; df -h /tmp | tail -1"})]}
    return {"content": "Stub answer: " + text[:60]}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "stub-model", "object": "model", "context_length": 128000}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        out = plan(req.get("messages", []))
        time.sleep(0.8)
        calls = [{"id": f"call_{int(time.time()*1000)}_{i}", "type": "function", "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(out.get("tool_calls", []))]
        finish = "tool_calls" if calls else "stop"
        usage = {"prompt_tokens": 1200 + 300 * len(req.get("messages", [])), "completion_tokens": 40, "total_tokens": 1240 + 300 * len(req.get("messages", []))}
        if not req.get("stream"):
            msg = {"role": "assistant", "content": out.get("content"), **({"tool_calls": calls} if calls else {})}
            body = json.dumps({"id": "stub", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
                               "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def chunk(delta, fin=None, extra=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": fin}], **(extra or {})}
            self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n"); self.wfile.flush()
        if calls:
            chunk({"role": "assistant", "tool_calls": [{**tc, "index": i} for i, tc in enumerate(calls)]})
        else:
            words = out["content"].split(" ")
            for i in range(0, len(words), 4):
                chunk({"role": "assistant", "content": " ".join(words[i:i + 4]) + (" " if i + 4 < len(words) else "")})
                time.sleep(0.05)
        chunk({}, finish, {"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), H).serve_forever()
