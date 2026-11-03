# Seeds a throwaway HERMES_HOME with synthetic chats for the Branch from here screenshots. Nothing here is real data.
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
chat("20261103_090000_aaaa01", "NAS disk usage", [
    ("user", "Instructions for this chat from the project \"Homelab\":\nKeep answers short and use metric units.", {"display_kind": "hidden"}),
    ("user", "How full is the NAS?", {}),
    ("assistant", "Let me check the volumes.", {"tool_calls": tc("call_df", "terminal", {"command": "df -h /srv"})}),
    ("tool", "Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1   7.3T  5.9T  1.4T  81% /srv", {"tool_call_id": "call_df", "tool_name": "terminal"}),
    ("assistant", "The NAS is **81% full**: 5.9 TB of 7.3 TB used on `/srv`.", {"reasoning": "df shows /dev/sda1 at 81%."}),
    ("user", f"@file:{files}/disk-report-week44.csv @file:{files}/old-snapshots.txt\n\nCompare with last week's report", {}),
    ("assistant", "Last week it was 79%, so about 150 GB more is in use. Most of it is new restic snapshots.", {}),
    ("user", "Delete the snapshots older than 90 days", {}),
    ("assistant", "Deleted 3 restic snapshots older than 90 days and pruned the repository. The NAS is now 74% full.", {"tool_calls": None}),
], 3600)
chat("20261103_080000_bbbb02", "Rotate nginx logs", [
    ("user", "Rotate the nginx logs and restart it", {}),
    ("assistant", "Done: the logs are rotated and nginx restarted cleanly.", {}),
], 7200)
chat("20261102_180000_cccc03", "Lisbon trip ideas", [
    ("user", "Three day trip ideas for Lisbon?", {}),
    ("assistant", "Day 1: Alfama and the castle. Day 2: Belém. Day 3: Sintra.", {}),
], 60000)
db.close()
import sqlite3
c = sqlite3.connect(home / "state.db")
c.execute("UPDATE sessions SET pinned = 1, last_read_at = ? WHERE id IN ('20261103_090000_aaaa01', '20261103_080000_bbbb02')", (now,))
c.execute("UPDATE sessions SET last_read_at = ?", (now,))
c.commit(); c.close()
print("seeded")
