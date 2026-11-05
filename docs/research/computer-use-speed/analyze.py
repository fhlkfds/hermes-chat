#!/usr/bin/env python3
"""Summarises x11bench.py runs: per frame, the time from Xvnc having the frame to both its markers showing in the app.

  analyze.py RUN.json [RUN.json ...]

Marker colours encode the frame number modulo 64, so a code alone doesn't name a frame. A VNC viewer shows a spot's
frames in order, though: once frame k is on screen there, no earlier frame can come back to it. So each spot's sightings
are read in time order, and each goes to the oldest frame after the last one attributed there that has its code and was
already drawn. When two or more such frames are drawn (64 frames went by unseen), the sighting is ambiguous: it is
counted in `ambiguous` and goes to no frame, and the run's latencies shouldn't be trusted.
"""
import json
import statistics
import sys


def pct(values, p):
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def attribute(drawn, seen, spot):
    """{frame index: time first shown at `spot`}, and how many sightings were ambiguous."""
    shown, last, ambiguous = {}, -1, 0
    for s in sorted((s for s in seen if s[1] == spot), key=lambda s: s[0]):
        t, code = s[0], s[2]
        candidates = [k for k in range(last + 1, len(drawn)) if drawn[k]["start"] <= t and drawn[k]["n"] % 64 == code]
        if not candidates:
            continue  # a colour from before the run, or one caught mid-repaint
        if len(candidates) > 1:
            ambiguous += 1
            last = candidates[-1]
            continue
        last = candidates[0]
        shown[last] = t
    return shown, ambiguous


def latencies(run):
    """Per drawn frame, ms from Xvnc having it to both markers shown, or None if it never fully showed."""
    drawn = run["drawn"]
    (a, amb_a), (b, amb_b) = attribute(drawn, run["seen"], 0), attribute(drawn, run["seen"], 1)
    out = [((max(a[k], b[k]) - d["done"]) * 1000 if k in a and k in b else None) for k, d in enumerate(drawn)]
    return out, amb_a + amb_b


def summarise(path):
    run = json.load(open(path))
    drawn = run["drawn"]
    shown, ambiguous = latencies(run)
    lat = [s for s in shown if s is not None]
    span = drawn[-1]["done"] - drawn[0]["start"]
    return {
        "file": path,
        "scenario": run["scenario"],
        "frames": len(drawn),
        "shown": len(lat),
        "ambiguous": ambiguous,
        "drawn_per_s": round(len(drawn) / span, 2) if span > 0 else None,
        "shown_per_s": round(len(lat) / span, 2) if span > 0 else None,
        "median_ms": round(statistics.median(lat), 1) if lat else None,
        "p90_ms": round(pct(lat, 0.9), 1) if lat else None,
        "max_ms": round(max(lat), 1) if lat else None,
        "min_ms": round(min(lat), 1) if lat else None,
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(summarise(p)))
