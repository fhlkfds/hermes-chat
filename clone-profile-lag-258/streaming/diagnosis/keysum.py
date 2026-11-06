import json, sys, statistics as st
k = sys.argv[1]
if k == "null": sys.exit()
k = json.loads(k); v = json.loads(k["v"]) if isinstance(k["v"], str) else k["v"]
sent, ins, tog = k["sent"], v["inputs"], v["toggles"]
lat = [i["paint"] - s for i, s in zip(ins, sent) if "paint" in i]
tl = [t["paint"] - t["ts"] for t in tog if "paint" in t]
f = lambda xs: f"med {st.median(xs):.0f} max {max(xs):.0f}" if xs else "n/a"
print(f"| keys {len(ins)}/20 key->paint {f(lat)} | toggles {len(tog)} evt->paint {f(tl)}")
