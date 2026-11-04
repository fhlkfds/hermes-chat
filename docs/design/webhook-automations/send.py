# Send a GitHub-style webhook delivery to a throwaway Hermes webhook listener, signed the way GitHub signs
# (X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw body). The route's secret is read from the throwaway
# home's subscription store on this machine; it is never printed.
#   send.py ROUTE EVENT DELIVERY_ID [--bad-signature] [--payload FILE] [--port N] [--home DIR] [--profile P]
import argparse, hashlib, hmac, json, os, urllib.request
ap = argparse.ArgumentParser()
ap.add_argument("route"); ap.add_argument("event"); ap.add_argument("delivery")
ap.add_argument("--bad-signature", action="store_true"); ap.add_argument("--payload")
ap.add_argument("--scheme", default="github", choices=["github", "v1"])
ap.add_argument("--port", default=os.environ.get("HOOK_PORT", "18683")); ap.add_argument("--home", default="/tmp/hc-wh/home")
ap.add_argument("--action", default="opened"); ap.add_argument("--number", type=int, default=42)
a = ap.parse_args()
secret = json.load(open(f"{a.home}/webhook_subscriptions.json"))[a.route]["secret"]
if a.payload:
    body = open(a.payload, "rb").read()
else:
    body = json.dumps({"action": a.action, "issue": {"number": a.number, "title": "[fixture] Crash when the list is empty",
        "user": {"login": "octo-fixture"}, "labels": [{"name": "bug"}], "html_url": f"https://github.com/example/fixture/issues/{a.number}"},
        "repository": {"full_name": "example/fixture"}, "sender": {"login": "octo-fixture"}}).encode()
sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
if a.bad_signature:
    sig = "sha256=" + hmac.new(b"not-the-secret", body, hashlib.sha256).hexdigest()
headers = {"Content-Type": "application/json", "X-GitHub-Event": a.event, "X-GitHub-Delivery": a.delivery,
           "X-Hub-Signature-256": sig, "User-Agent": "GitHub-Hookshot/fixture"}
if a.scheme == "v1":  # generic body-only HMAC (no replay protection), as a non-GitHub sender would sign
    del headers["X-Hub-Signature-256"]
    headers["X-Webhook-Signature"] = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
req = urllib.request.Request(f"http://127.0.0.1:{a.port}/webhooks/{a.route}", data=body, method="POST", headers=headers)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
