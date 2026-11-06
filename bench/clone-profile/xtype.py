# Types <text> as real X key presses (XTest) on $DISPLAY, one press and release every <interval> ms, and prints the
# wall-clock ms at which each key reached the X server, as a JSON list. Unlike `wd.mjs keys`, it never waits for the
# app to take a key before sending the next one, the way a person types.
#   python3 -I xtype.py <text> <interval ms>
import ctypes, json, sys, time

text, interval = sys.argv[1], float(sys.argv[2])
x = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XStringToKeysym.restype = ctypes.c_ulong
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x.XOpenDisplay(None)
assert display, "no X display"
codes = [x.XKeysymToKeycode(display, x.XStringToKeysym({"-": "minus"}.get(c, c).encode())) for c in text]
sent = []
start = time.monotonic()
for i, code in enumerate(codes):
    due = start + i * interval / 1000
    while (now := time.monotonic()) < due:
        time.sleep(min(0.002, due - now))
    xtst.XTestFakeKeyEvent(display, code, 1, 0)
    xtst.XTestFakeKeyEvent(display, code, 0, 0)
    x.XSync(display, 0)
    sent.append(time.time() * 1000)
print(json.dumps(sent))
