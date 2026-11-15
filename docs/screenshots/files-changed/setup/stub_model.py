"""OpenAI-compatible stub model for a throwaway Hermes: scripted file edits, no real model.

A user message containing `edit two` makes one step that patches a.txt and b.txt.
`create` writes a new file c.txt. `again` patches a.txt a second time. Any other prompt, or a tool
result, gets a plain text answer.
    python stub_model.py <host> <port>
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def plan(messages):
    last = messages[-1]
    if last.get("role") == "tool":
        return {"content": "Done editing the files."}
    text = last.get("content")
    if isinstance(text, list):
        text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
    text = str(text or "")
    calls = []
    if "edit two" in text:
        calls = [("patch", {"path": "a.txt", "old_string": "alpha original", "new_string": "alpha changed by the bot"}),
                 ("patch", {"path": "b.txt", "old_string": "beta original", "new_string": "beta changed by the bot"})]
    elif "create" in text:
        calls = [("write_file", {"path": "c.txt", "content": "a file the bot created\n"})]
    elif "again" in text:
        calls = [("patch", {"path": "a.txt", "old_string": "alpha changed by the bot", "new_string": "alpha changed again by a later reply"})]
    if not calls:
        return {"content": "Stub answer: " + text[:60]}
    return {"tool_calls": [{"id": f"call_{int(time.time()*1000)}_{i}", "type": "function",
                            "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(calls)]}

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
        if "tool_calls" in out:
            chunk({"role": "assistant", "tool_calls": [{**tc, "index": i} for i, tc in enumerate(out["tool_calls"])]})
        else:
            chunk({"role": "assistant", "content": out["content"]})
        chunk({}, finish, {"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), H).serve_forever()
