"""OpenAI-compatible stub model for a throwaway Hermes: one scripted tool call, no real model.

A prompt containing `disk` makes one step that runs `df -h /` in the terminal; the tool result then gets a
short report. Any other prompt gets a plain answer.
    python stub_model.py <host> <port>
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def text_of(m):
    t = m.get("content")
    if isinstance(t, list):
        t = " ".join(p.get("text", "") for p in t if isinstance(p, dict))
    return str(t or "")

def plan(messages):
    last = messages[-1]
    if last.get("role") == "tool":
        return {"content": "Disk check done. The root filesystem has room to spare, so nothing needs cleaning tonight."}
    if "disk" in text_of(last):
        args = {"command": "df -h /"}
        return {"content": "Checking the root filesystem first.",
                "tool_calls": [{"id": f"call_{int(time.time()*1000)}", "type": "function",
                                "function": {"name": "terminal", "arguments": json.dumps(args)}}]}
    return {"content": "Stub answer: " + text_of(last)[-60:]}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "stub-model", "object": "model", "context_length": 128000}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        out = plan(req.get("messages", []))
        finish = "tool_calls" if "tool_calls" in out else "stop"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if not req.get("stream"):
            msg = {"role": "assistant", "content": out.get("content"), **({"tool_calls": out["tool_calls"]} if "tool_calls" in out else {})}
            body = json.dumps({"id": "stub", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
                               "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def chunk(delta, fin=None, extra=None):
            c = {"id": "stub", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": fin}], **(extra or {})}
            self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n"); self.wfile.flush()
        if out.get("content"):
            chunk({"role": "assistant", "content": out["content"]})
        if "tool_calls" in out:
            chunk({"role": "assistant", "tool_calls": [{**tc, "index": i} for i, tc in enumerate(out["tool_calls"])]})
        chunk({}, finish, {"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), H).serve_forever()
