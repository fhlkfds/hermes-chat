# Seeds a throwaway HERMES_HOME with synthetic chats for issue #63's checks. Nothing here is real data.
import json, os, time
from pathlib import Path
from hermes_state import SessionDB
home = Path(os.environ["HERMES_HOME"]); files = Path(os.environ["DEMO_FILES"])
db = SessionDB(home / "state.db")
now = time.time()
def chat(sid, title, rows, ago):
    db.create_session(sid, source="gui", model="stub-model")
    t = now - ago
    for role, content, kw in rows:
        t += 30
        db.append_message(sid, role, content, timestamp=t, **kw)
    db.set_session_title(sid, title)
tc = lambda i, name, args: [{"id": i, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]
chat("20261103_090000_aaaa01", "Backup plan", [
    ("user", "Instructions for this chat from the project \"Homelab\":\nKeep answers short.", {"display_kind": "hidden"}),
    ("user", "Which folders should the nightly backup cover?", {}),
    ("assistant", "Cover /srv/photos, /srv/documents and /etc. Skip caches and /tmp.", {}),
    ("user", "How long should we keep the nightly snapshots?", {}),
    ("assistant", "Keep 14 daily, 8 weekly and 12 monthly snapshots.", {}),
    ("user", "Check how big /srv/photos is", {}),
    ("assistant", "Let me check.", {"tool_calls": tc("call_du", "terminal", {"command": "du -sh /srv/photos"})}),
    ("tool", "412G\t/srv/photos", {"tool_call_id": "call_du", "tool_name": "terminal"}),
    ("assistant", "/srv/photos is 412 GB.", {}),
    ("user", f"@file:{files}/backup-policy.md\n\nDoes this policy match what you suggested?", {}),
    ("assistant", "Mostly: the policy keeps 7 daily snapshots instead of 14.", {}),
], 3600)
chat("20261103_080000_bbbb02", "Weekend hike", [
    ("user", "Suggest a short hike near the coast", {}),
    ("assistant", "Try the 6 km cliff path from the harbour to the lighthouse.", {}),
], 7200)
chat("20261103_070000_cccc03", "Photo of the router", [
    ("user", "[image] What model is this router?", {}),
    ("assistant", "It looks like a small four-port home router.", {}),
], 9000)
db.close()
import sqlite3
c = sqlite3.connect(home / "state.db")
c.execute("UPDATE sessions SET last_read_at = ?", (now,))
c.commit(); c.close()
print("seeded")
