#!/usr/bin/env node
// Summarises run.sh output: median and range across runs of click-to-ready, per-key and per-toggle event-to-frame
// latency, the longest frame while the keys went in (wd.mjs runs no element search then), and the requests each step
// made. For stream.sh output: frame intervals with the dialog closed and open, each key from when it reached the X
// server to its frame, and each toggle to its frame.
//   node bench/clone-profile/summary.mjs <out.jsonl>...
import { readFileSync } from "node:fs";

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const parsed = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const fmt = (xs) => `median ${med(xs).toFixed(1)}, range ${Math.min(...xs).toFixed(1)} to ${Math.max(...xs).toFixed(1)} (n=${xs.length})`;

function streamed(file, runs) {
  const row = runs.map((r) => {
    const lag = parsed(r.lag);
    const keys = lag.events.filter((e) => e.kind === "key");
    const fromSend = keys.filter((e) => e.paint).map((e, i) => e.paint + lag.origin - r.sent[i]);
    const toggles = lag.events.filter((e) => e.kind === "toggle" && e.paint).map((e) => e.paint - e.t0);
    return {
      keyMed: med(fromSend),
      keyMax: Math.max(...fromSend),
      typing: keys.at(-1)?.paint + lag.origin - r.sent[0],
      toggleMed: med(toggles),
      closed: parsed(r.closed).median,
      open: parsed(r.open).median,
      keys: `${fromSend.length}/${r.sent.length}`,
      toggles: toggles.length,
      reply: r.reply,
      load: r.load,
    };
  });
  console.log(`# ${file}`);
  for (const r of row) console.log(JSON.stringify(r));
  console.log(`frame with the dialog closed, ms, median per run: ${fmt(row.map((r) => r.closed))}`);
  console.log(`frame with the dialog open, ms, median per run: ${fmt(row.map((r) => r.open))}`);
  console.log(`key (X server) to frame, ms, median per run: ${fmt(row.map((r) => r.keyMed))}`);
  console.log(`key (X server) to frame, ms, worst per run: ${fmt(row.map((r) => r.keyMax))}`);
  console.log(`20 keys 60 ms apart, first sent to last drawn, ms: ${fmt(row.map((r) => r.typing))}`);
  console.log(`toggle to frame, ms, median per run: ${fmt(row.map((r) => r.toggleMed))}`);
  console.log(`load (1 min) per run: ${row.map((r) => r.load.split(" ")[0]).join(" ")}`);
}

for (const file of process.argv.slice(2)) {
  const runs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (runs[0].sent) {
    streamed(file, runs);
    continue;
  }
  const row = runs.map((r) => {
    const lag = typeof r.lag === "string" ? JSON.parse(r.lag) : r.lag;
    const keys = lag.events.filter((e) => e.kind === "key" && e.paint).map((e) => e.paint - e.t0);
    const toggles = lag.events.filter((e) => e.kind === "toggle" && e.paint).map((e) => e.paint - e.t0);
    const missing = lag.events.filter((e) => !e.paint).length;
    return {
      open: lag.open?.ready - lag.open?.t0,
      keyMed: med(keys),
      keyMax: Math.max(...keys),
      keyCount: keys.length,
      typing: lag.events.filter((e) => e.kind === "key").at(-1)?.paint - lag.events.find((e) => e.kind === "key")?.t0,
      toggleMed: med(toggles),
      toggleCount: toggles.length,
      gapMax: (() => {
        const keyEvents = lag.events.filter((e) => e.kind === "key");
        const from = keyEvents[0]?.t0 ?? 0;
        const to = keyEvents.at(-1)?.paint ?? 0;
        return Math.max(0, ...lag.gaps.filter(([at, ms]) => at + ms > from && at < to).map((g) => g[1]));
      })(),
      missing,
      reqs: r.reqs,
      load: r.load,
    };
  });
  console.log(`# ${file}`);
  for (const r of row) console.log(JSON.stringify(r));
  console.log(`open (click to ready), ms: ${fmt(row.map((r) => r.open))}`);
  console.log(`key to frame, ms, median per run: ${fmt(row.map((r) => r.keyMed))}`);
  console.log(`key to frame, ms, worst per run: ${fmt(row.map((r) => r.keyMax))}`);
  console.log(`20 keys, first key to last frame, ms: ${fmt(row.map((r) => r.typing))}`);
  console.log(`toggle to frame, ms, median per run: ${fmt(row.map((r) => r.toggleMed))}`);
  console.log(`longest frame while typing, ms: ${fmt(row.map((r) => r.gapMax))}`);
  for (const k of ["open", "typing", "toggles", "after"]) console.log(`requests during ${k}: ${row.map((r) => r.reqs[k]).join(" ")}`);
  console.log(`keys seen per run: ${row.map((r) => r.keyCount).join(" ")}; events without a frame: ${row.map((r) => r.missing).join(" ")}`);
}
