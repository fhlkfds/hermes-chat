import asyncio, json, sys
sys.path.insert(0, "/tmp/hc63"); from probe import *
P = "20261103_090000_aaaa01"
async def main():
    w = WS(); await w.open()
    r = await w.call("session.resume", {"session_id": P, "profile": "default", "inline_images": False})
    sid = r["result"]["session_id"]; print("resumed", sid)
    before = rows(P); print("parent rows:", len(before))
    # Edit "How long should we keep..." (spine index 3): branch THROUGH it (count 4), then cut before the branch's copy.
    b = await w.call("session.branch", {"session_id": sid, "count": 4, "idempotency_key": "probe-edit-1"})
    br = b["result"]; print("branch:", br["stored_session_id"], br["title"], br["message_count"])
    brows = rows(br["stored_session_id"]); print("branch rows:", brows)
    target = brows[-1][0]
    s = await w.call("prompt.submit", {"session_id": br["session_id"], "profile": "default", "text": "How long should we keep the WEEKLY snapshots?",
                                       "truncate_before_row_id": target, "confirm_truncate": True})
    print("submit:", json.dumps(s)[:400])
    e = await w.until("message.complete"); print("complete:", json.dumps(e)[:300])
    print("branch rows after:", rows(br["stored_session_id"]))
    print("parent unchanged:", rows(P) == before)
    # First message, no hidden row before it: count 1 + empty cut.
    H = "20261103_080000_bbbb02"
    r = await w.call("session.resume", {"session_id": H, "profile": "default", "inline_images": False}); hs = r["result"]["session_id"]
    b = await w.call("session.branch", {"session_id": hs, "count": 1, "idempotency_key": "probe-edit-2"}); br2 = b["result"]
    t2 = rows(br2["stored_session_id"]); print("hike branch rows:", t2)
    s = await w.call("prompt.submit", {"session_id": br2["session_id"], "profile": "default", "text": "Suggest a short hike near the coast", "truncate_before_row_id": t2[-1][0], "confirm_truncate": True})
    print("no empty-confirm:", json.dumps(s)[:300])
    s = await w.call("prompt.submit", {"session_id": br2["session_id"], "profile": "default", "text": "Suggest a short hike near the coast", "truncate_before_row_id": t2[-1][0], "confirm_truncate": True, "confirm_empty_truncate": True})
    print("with empty-confirm:", json.dumps(s)[:300])
    await w.until("message.complete")
    print("hike branch after:", rows(br2["stored_session_id"]))
    print("hike row:", json.dumps(rest("GET", f"api/sessions/{br2['stored_session_id']}?profile=default"))[:600])
asyncio.run(main())
