"""Splits recorded turns (turn.mjs output) into model round trips and tool times.

A model round trip is from the turn's start, or a tool's end, to the next tool's start or the reply's end: the
model's answer plus Hermes's own work between calls. Usage: python3 loop.py runs/turn-*.txt
"""
import collections
import json
import statistics
import sys

model, tools = [], collections.defaultdict(list)
for path in sys.argv[1:]:
    events = [json.loads(line) for line in open(path) if line.startswith("{")]
    last = next(e["t"] for e in events if e["type"] == "message.start")
    for e in events:
        if e["type"] == "tool.start":
            model.append(e["t"] - last)
        elif e["type"] == "tool.complete":
            args = json.loads(e["args"]) if e.get("args") else {}
            key = e["name"] + (":" + args.get("action", "") if e["name"] == "computer_use" else "")
            tools[key].append(e.get("dur") or 0)
            last = e["t"]
        elif e["type"] == "message.complete":
            model.append(e["t"] - last)


def summary(xs):
    return f"n={len(xs)} p50={statistics.median(xs):.2f} max={max(xs):.2f}"


print("model round trips (s):", summary([m / 1000 for m in model]))
for key, durations in sorted(tools.items()):
    print(f"tool {key} (s):", summary(durations))
