"""OpenAI-compatible stub model for a throwaway Hermes, priced so Hermes records a real cost.

Its `/v1/models` lists `stub-model` with a price per token ($10 per million in, $30 per million out), which Hermes
reads for a custom endpoint (`agent/usage_pricing.py` `_pricing_entry_from_metadata`). A prompt containing `spend N`
reports N thousand input tokens and N hundred output tokens for the call, so `spend 100` costs $1.30. Any other
prompt reports 10 in and 5 out.
    python stub_model.py <host> <port>
"""
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {"object": "list", "data": [{"id": "stub-model", "object": "model", "context_length": 1000000,
                                      "pricing": {"prompt": "0.00001", "completion": "0.00003"}}]}

def text_of(m):
    t = m.get("content")
    if isinstance(t, list):
        t = " ".join(p.get("text", "") for p in t if isinstance(p, dict))
    return str(t or "")

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        # Only the OpenAI route: answering every path makes Hermes take it for LM Studio, whose native list has no prices.
        if self.path.rstrip("/") != "/v1/models":
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        self.send_json(MODELS)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        msgs = req.get("messages", [])
        last = text_of(msgs[-1]) if msgs else ""
        m = re.search(r"spend (\d+)", last)
        k = int(m.group(1)) if m else 0
        usage = {"prompt_tokens": k * 1000 or 10, "completion_tokens": k * 100 or 5}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        content = f"Done: that was about {k * 1000:,} tokens of work." if k else "Stub answer: " + last[-60:]
        if not req.get("stream"):
            self.send_json({"id": "stub", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "usage": usage})
            return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def chunk(delta, fin=None, extra=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": fin}], **(extra or {})}
            self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n"); self.wfile.flush()
        chunk({"role": "assistant", "content": content})
        chunk({}, "stop", {"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), H).serve_forever()
