"""Reads the instrumented app's BENCH lines (app-trace.patch): how long the stream's bytes take inside the app.

`rx` is when Rust got a chunk from /api/display/ws, `js` when the webview's handler got it, `flip` when noVNC drew to
the visible canvas; all wall-clock ms on one machine. A change is the chunks after a quiet gap of over 150 ms.

    python3 app_trace.py runs/app-stream.log.xz
"""
import lzma
import sys

rx, js, flips = [], [], []
for line in (lzma.open if sys.argv[1].endswith(".xz") else open)(sys.argv[1], "rt"):
    p = line.split()
    if p[1] == "rx":
        rx.append((float(p[2]), int(p[3])))
    elif p[1] == "js":
        js.append((float(p[2]), int(p[3])))
    elif p[1] == "flip":
        flips.append(float(p[2]))
n = min(len(rx), len(js))
assert all(rx[i][1] == js[i][1] for i in range(n)), "chunks out of order"


def q(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))], 1)


lag = [js[i][0] - rx[i][0] for i in range(n)]
print(f"chunks {n}, {sum(b for _, b in rx[:n]) // 1024} KiB; Rust->JS per chunk p50 {q(lag, .5)} p90 {q(lag, .9)} p99 {q(lag, .99)} max {q(lag, 1)} ms")

changes, cur = [], []
for i in range(n):
    if cur and rx[i][0] - rx[cur[-1]][0] > 150:
        changes.append(cur)
        cur = []
    cur.append(i)
changes.append(cur)
first = []
for c in changes:
    drawn = [f for f in flips if f >= js[c[0]][0]]
    if drawn:
        first.append(drawn[0] - rx[c[0]][0])
print(f"changes {len(changes)}: first byte at Rust -> first frame drawn p50 {q(first, .5)} p90 {q(first, .9)} ms")

# The busy stretch: the longest run of chunks with no gap over 150 ms.
busy = max(changes, key=lambda c: rx[c[-1]][0] - rx[c[0]][0])
t0, t1 = rx[busy[0]][0], rx[busy[-1]][0]
drawn = [f for f in flips if t0 <= f <= t1 + 50]
gaps = [b - a for a, b in zip(drawn, drawn[1:])]
print(f"busy {t1 - t0:.0f} ms: Rust->JS p50 {q([lag[i] for i in busy], .5)} max {q([lag[i] for i in busy], 1)} ms; "
      f"drawn {len(drawn) / (t1 - t0) * 1000:.1f} frames/s, gap p50 {q(gaps, .5)} p90 {q(gaps, .9)} max {q(gaps, 1)} ms")
