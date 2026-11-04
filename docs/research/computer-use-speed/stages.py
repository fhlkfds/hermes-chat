#!/usr/bin/env python3
"""Splits each frame of an x11bench.py run into stages, using the log of an app built with instrument.patch.

  stages.py RUN.json APP.log LABEL

Stages, from Xvnc having the frame ("draw done", x11bench.py's clock, CLOCK_MONOTONIC):
  first tx / last tx   Rust hands the first / last of the frame's bytes to the Tauri channel (`BENCH tx`, monotonic)
  last JS              the webview's channel handler has the last of them (`BENCH js`, wall clock, mapped to monotonic
                       with the `BENCH clock` pairs Rust logs)
  glass                both markers show in the app's window (x11bench.py's poller)
"tx" includes Xvnc's encoding, Hermes's bridge and the link; "channel" is last JS - last tx; "noVNC+paint" is glass -
last JS.
"""
import json
import statistics
import sys


def main(run_path, log_path, label):
    run = json.load(open(run_path))
    tx, js, offs = [], [], []
    for line in open(log_path).read().splitlines():
        p = line.split()
        if line.startswith("BENCH tx"):
            tx.append(float(p[2]))
        elif line.startswith("BENCH clock"):
            offs.append(float(p[3]) - float(p[2]) * 1000)
        elif line.startswith("BENCH js"):
            js.append(float(p[2]))
    off = statistics.median(offs)
    js = [(w - off) / 1000 for w in js]
    seen, drawn = run["seen"], run["drawn"]
    rows = []
    for i, d in enumerate(drawn):
        lo = d["start"]
        hi = drawn[i + 1]["start"] if i + 1 < len(drawn) else d["start"] + 1.5
        code = d["n"] % 64
        g = [next((s[0] for s in seen if s[1] == spot and s[2] == code and lo <= s[0] < hi), None) for spot in (0, 1)]
        if None in g:
            continue
        glass = max(g)
        t = [x for x in tx if lo <= x < glass]
        j = [x for x in js if lo <= x < glass]
        if not t or not j:
            continue
        ms = lambda x: (x - d["done"]) * 1000
        rows.append({"msgs": len(t), "first_tx": ms(t[0]), "last_tx": ms(t[-1]), "last_js": ms(j[-1]), "glass": ms(glass)})
    if not rows:
        print(f"{label}: no frame with all stages")
        return
    med = lambda k: statistics.median(r[k] for r in rows)
    print(
        f"{label}: n={len(rows)} channel msgs/frame {med('msgs'):.0f} | draw->first tx {med('first_tx'):.0f} ms | ->last tx {med('last_tx'):.0f}"
        f" | ->last JS {med('last_js'):.0f} | ->glass {med('glass'):.0f}  (medians; channel {med('last_js') - med('last_tx'):.0f},"
        f" noVNC+paint {med('glass') - med('last_js'):.0f})"
    )


if __name__ == "__main__":
    main(*sys.argv[1:4])
