# Another Hermes client adds a turn to "Weekend hike" while the app's Edit dialog is open.
import asyncio, sys
sys.path.insert(0, "/tmp/hc63"); from probe import *
async def main():
    w = WS(); await w.open()
    r = await w.call("session.resume", {"session_id": "20261103_080000_bbbb02", "profile": "default", "inline_images": False})
    s = await w.call("prompt.submit", {"session_id": r["result"]["session_id"], "profile": "default", "text": "Another client adds this"})
    print("other client submit:", s.get("result") or s.get("error"))
    await w.until("message.complete"); print("rows now:", len(rows("20261103_080000_bbbb02")))
asyncio.run(main())
