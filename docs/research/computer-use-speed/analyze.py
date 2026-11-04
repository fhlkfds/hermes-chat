#!/usr/bin/env python3
"""Summarises x11bench.py runs: per frame, the time from Xvnc having the frame to both its markers showing in the app.

  analyze.py RUN.json [RUN.json ...]
"""
import json
import statistics
import sys


def pct(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def summarise(path):
    run = json.load(open(path))
    drawn, seen = run["drawn"], run["seen"]
    # When each spot first showed each code, after the frame was drawn.
    shown = []
    for i, d in enumerate(drawn):
        code = d["n"] % 64
        # The same code comes back 64 frames later: a sighting after that frame is drawn is that frame's, not this one's.
        reuse = drawn[i + 64]["start"] if i + 64 < len(drawn) else float("inf")
        times = []
        for spot in (0, 1):
            t = next((s[0] for s in seen if s[1] == spot and s[2] == code and d["start"] <= s[0] < reuse), None)
            times.append(t)
        if None in times:
            shown.append(None)
            continue
        t = max(times)
        shown.append((t - d["done"]) * 1000)
    lat = [s for s in shown if s is not None]
    span = drawn[-1]["done"] - drawn[0]["start"]
    return {
        "file": path,
        "scenario": run["scenario"],
        "frames": len(drawn),
        "shown": len(lat),
        "drawn_per_s": round(len(drawn) / span, 2) if span > 0 else None,
        "shown_per_s": round(len(lat) / span, 2) if span > 0 else None,
        "median_ms": round(statistics.median(lat), 1) if lat else None,
        "p90_ms": round(pct(lat, 0.9), 1) if lat else None,
        "max_ms": round(max(lat), 1) if lat else None,
        "min_ms": round(min(lat), 1) if lat else None,
        "last5_ms": [round(x, 1) if x is not None else None for x in shown[-5:]],
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(summarise(p)))
