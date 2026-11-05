// Times the Screen's stream (issue #172): Hermes's `/api/display/ws` from wherever this runs, which is the dashboard
// end of the SSH tunnel when run on this computer and the dashboard itself when run on the server. It needs a Bot
// Desktop showing `page.html` in a focused browser (see README.md), takes over the screen to press keys on that page,
// and hands back at the end.
//
// Usage: node tools/screen-latency/measure.mjs <dashboard URL> <username> <password file> [quality] [compression]
// Prints JSON: fence round trips, key-to-update lag, and frame rate and bandwidth while the page animates.
import { readFileSync } from "node:fs";
import { signIn, openPipe } from "./rpc.mjs";
import { connectRfb } from "./rfb.mjs";

const [base, user, pwFile, quality = "7", compression = "2"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};
const summary = (xs) => (xs.length ? { n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), max: pct(xs, 100) } : { n: 0 });

const session = await signIn(base, user, readFileSync(pwFile, "utf8").trim());
const pipe = await openPipe(session);
let t = performance.now();
const observed = await pipe.request("display.observe", { profile: "default" });
const observeMs = performance.now() - t;
await pipe.request("display.lease.acquire", { profile: "default", viewer_id: observed.viewer_id });
// DIRECT=unix:<rfb.sock> skips the dashboard's bridge and reads Xvnc itself.
const url = process.env.DIRECT ?? new URL("api/display/ws", base);
if (!process.env.DIRECT) {
  url.protocol = url.protocol.replace("http", "ws");
  url.searchParams.set("display_ticket", observed.ticket);
}
t = performance.now();
const rfb = await connectRfb(url, { quality: +quality, compression: +compression });
while (!rfb.frames.length) await sleep(10);
const firstFrameMs = performance.now() - t;
const firstFrame = rfb.frames[0];
// The page's known state: at the top, no flash, no animation.
for (const k of [0x77, 0x66, 0x7a]) rfb.key(k);
await sleep(1500);

// The relay's own round trip: a fence with nothing else queued.
for (let i = 0; i < 20; i++) {
  await rfb.fence();
  await sleep(50);
}

// Key to the updates it causes. `keysym`: 't' flips a full-screen gradient, 's' scrolls the article by 400 px. TigerVNC
// sends a JPEG picture first (the first update), then, about 100 ms later when the link is idle, a lossless refresh of
// the same area in many small updates. What the owner sees change is the first update.
async function echo(keysym, label, times = 12) {
  const first = [];
  const firstDone = [];
  const last = [];
  const firstBytes = [];
  const bytes = [];
  for (let i = 0; i < times; i++) {
    await sleep(400);
    const before = rfb.frames.length;
    const at = performance.now();
    rfb.key(keysym);
    while (rfb.frames.length === before) {
      if (performance.now() - at > 3000) throw new Error(`no update within 3 s of key ${keysym.toString(16)} (try ${i})`);
      await sleep(1);
    }
    // Everything that came within 250 ms of the first update is part of the same change.
    const firstUpdate = rfb.frames[before];
    await sleep(250);
    const mine = rfb.frames.slice(before).filter((f) => f.start - firstUpdate.start < 250);
    first.push(firstUpdate.start - at);
    firstDone.push(firstUpdate.end - at);
    last.push(mine.at(-1).end - at);
    firstBytes.push(firstUpdate.bytes);
    bytes.push(mine.reduce((n, f) => n + f.bytes, 0));
  }
  const kb = (xs) => summary(xs.map((b) => b / 1024));
  return {
    label,
    firstUpdateStartMs: summary(first),
    firstUpdateDoneMs: summary(firstDone),
    refreshDoneMs: summary(last),
    firstUpdateKb: kb(firstBytes),
    kbWithRefresh: kb(bytes),
  };
}
const flip = await echo(0x74, "full-screen flip");
const scroll = await echo(0x73, "article scroll");
for (const k of [0x77, 0x66]) rfb.key(k); // back to the top, no flash

// An animating 800x500 canvas: what watching a busy screen costs.
await sleep(500);
rfb.key(0x61);
await sleep(500);
const from = rfb.frames.length;
const bytesFrom = rfb.stats.bytes;
const windowStart = performance.now();
await sleep(5000);
const windowMs = performance.now() - windowStart;
// Updates of 1 KiB or more: the canvas's frames, not the cursor's or the refresh's slivers.
const anim = rfb.frames.slice(from).filter((f) => f.bytes >= 1024);
rfb.key(0x7a);
const gaps = anim.slice(1).map((f, i) => f.start - anim[i].start);

const result = {
  base,
  quality: +quality,
  compression: +compression,
  continuousUpdates: rfb.continuous,
  observeMs: +observeMs.toFixed(1),
  connectToFirstFrameMs: +firstFrameMs.toFixed(1),
  firstFrameKb: +(firstFrame.bytes / 1024).toFixed(1),
  fenceRoundTripMs: summary(rfb.fences),
  echo: [flip, scroll],
  animation: {
    framesPerSecond: +((anim.length / windowMs) * 1000).toFixed(1),
    kbPerSecond: +((rfb.stats.bytes - bytesFrom) / 1024 / (windowMs / 1000)).toFixed(0),
    frameGapMs: summary(gaps),
  },
  wsMessages: rfb.stats.messages,
  wsKb: +(rfb.stats.bytes / 1024).toFixed(0),
};
await pipe.request("display.lease.release", { profile: "default", viewer_id: observed.viewer_id });
rfb.close();
pipe.close();
console.log(JSON.stringify(result, null, 1));
process.exit(0);
