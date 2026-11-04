# Calls the throwaway Hermes dashboard (run.sh dashboard, loopback only) as its fixture user, and prints each answer
# with any route secret redacted. The session cookie is kept in $W/cookies.txt so repeated calls sign in once.
#   probe.py "METHOD /path?query [json body]" ...
import http.cookiejar
import json
import os
import re
import sys
import urllib.request

BASE = f"http://127.0.0.2:{os.environ.get('DASH_PORT', '19083')}"
jar = http.cookiejar.MozillaCookieJar(os.path.join(os.environ.get("W", "/tmp/hc-wh"), "cookies.txt"))
try:
    jar.load(ignore_discard=True)
except OSError:
    pass
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def login():
    status = call("POST", "/auth/password-login", {"provider": "basic", "username": "fixture", "password": "fixture-pass-123"})[0]
    jar.save(ignore_discard=True)
    return status


for line in sys.argv[1:]:
    m, p, *b = line.split(" ", 2)
    out = call(m, p, json.loads(b[0]) if b else None)
    if out[0] == 401:
        login()
        out = call(m, p, json.loads(b[0]) if b else None)
    text = re.sub(r'"secret": "[^"]+"', '"secret": "<shown once; redacted here>"', json.dumps(out, indent=1))
    print(m, p, "->", text)
