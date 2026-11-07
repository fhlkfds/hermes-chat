# steal-focus.py <seconds>: maps a small X window on $DISPLAY, gives it the input focus and holds it that long, so the
# app loses focus as when the owner switches to another app. This box has no X clients to do it with; libX11 is enough.
import ctypes, sys, time
x = ctypes.cdll.LoadLibrary("libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XCreateSimpleWindow.restype = ctypes.c_ulong
x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_int] * 2 + [ctypes.c_uint] * 3 + [ctypes.c_ulong] * 2
x.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(None)
if not d:
    sys.exit("steal-focus: can't open the display")
w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 1100, 700, 200, 120, 1, 0, 0xffffff)
x.XMapRaised(d, w); x.XFlush(d); time.sleep(0.5)
x.XSetInputFocus(d, w, 1, 0); x.XFlush(d)
print("focus taken", flush=True)
time.sleep(float(sys.argv[1]))
