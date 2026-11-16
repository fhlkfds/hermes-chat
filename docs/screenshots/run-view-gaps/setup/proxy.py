"""A TCP proxy between the app and a throwaway Hermes dashboard, to drop the app's connection without stopping Hermes.

    python proxy.py <listen host> <listen port> <target host> <target port>

SIGUSR1 closes every connection it carries; it keeps listening, so the app reconnects through it. While a file named
`<listen port>.hold` exists beside this script's working directory, new connections are refused, so the drop lasts.
"""
import asyncio, os, signal, sys

LHOST, LPORT, THOST, TPORT = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
HOLD = f"{LPORT}.hold"
live: set[asyncio.StreamWriter] = set()

async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter):
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        w.close()

async def serve(cr: asyncio.StreamReader, cw: asyncio.StreamWriter):
    if os.path.exists(HOLD):
        cw.close()
        return
    try:
        tr, tw = await asyncio.open_connection(THOST, TPORT)
    except OSError:
        cw.close()
        return
    live.update((cw, tw))
    await asyncio.gather(pipe(cr, tw), pipe(tr, cw))
    live.difference_update((cw, tw))

def drop():
    print(f"dropping {len(live)} sockets", flush=True)
    for w in list(live):
        w.transport.abort()

async def main():
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, drop)
    server = await asyncio.start_server(serve, LHOST, LPORT)
    print(f"proxy {LHOST}:{LPORT} -> {THOST}:{TPORT}", flush=True)
    await server.serve_forever()

asyncio.run(main())
