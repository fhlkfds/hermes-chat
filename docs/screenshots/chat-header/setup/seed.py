# Seeds a throwaway HERMES_HOME with synthetic chats for the chat header screenshots. Nothing here is real data.
import os, sqlite3, time
from pathlib import Path
from hermes_state import SessionDB
home = Path(os.environ["HERMES_HOME"])
db = SessionDB(home / "state.db")
now = time.time()
def chat(sid, title, rows, ago):
    db.create_session(sid, source="gui", model="stub-model")
    t = now - ago
    for role, content in rows:
        t += 30
        db.append_message(sid, role, content, timestamp=t)
    db.set_session_title(sid, title)
chat("20261103_090000_aaaa01", "NAS disk usage", [
    ("user", "How full is the NAS?"),
    ("assistant", "The NAS is **81% full**: 5.9 TB of 7.3 TB used on `/srv`."),
    ("user", "Delete the snapshots older than 90 days"),
    ("assistant", "Deleted 3 restic snapshots older than 90 days and pruned the repository. The NAS is now 74% full."),
], 3600)
chat("20261103_080000_bbbb02", "Rotate nginx logs", [
    ("user", "Rotate the nginx logs and restart it"),
    ("assistant", "Done: the logs are rotated and nginx restarted cleanly."),
], 7200)
db.close()
c = sqlite3.connect(home / "state.db")
c.execute("UPDATE sessions SET last_read_at = ?", (now,))
c.commit(); c.close()
print("seeded")
