# Types text with XTest on $DISPLAY, one key down+up per char, every `interval` ms; prints JSON list of wall-clock ms
# just after each key's down+up was flushed to the X server.  usage: python3 -I xtype.py <text> <interval_ms>
import ctypes, json, sys, time
text, interval = sys.argv[1], float(sys.argv[2])
x = ctypes.CDLL("libX11.so.6"); t = ctypes.CDLL("libXtst.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XStringToKeysym.restype = ctypes.c_ulong
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]; x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
d = x.XOpenDisplay(None)
assert d, "no display"
codes = []
for c in text:
    name = {"-": "minus"}.get(c, c)
    codes.append(x.XKeysymToKeycode(d, x.XStringToKeysym(name.encode())))
sent = []
start = time.monotonic()
for i, kc in enumerate(codes):
    target = start + i * interval / 1000
    while (now := time.monotonic()) < target:
        time.sleep(min(0.002, target - now))
    t.XTestFakeKeyEvent(d, kc, 1, 0); t.XTestFakeKeyEvent(d, kc, 0, 0); x.XSync(d, 0)
    sent.append(time.time() * 1000)
print(json.dumps(sent))
