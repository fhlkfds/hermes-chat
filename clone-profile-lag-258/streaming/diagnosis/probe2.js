// Verifier's own probe (read-only listeners). Each input in the clone dialog's name field and each part checkbox
// change records wall-clock time of the event handler and of the frame after it. Long frames (>50 ms) are listed.
(() => {
  if (window.__v) return "already";
  const now = () => performance.timeOrigin + performance.now();
  const V = (window.__v = { inputs: [], toggles: [], gaps: [] });
  const afterPaint = (cb) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => cb(now()); ch.port2.postMessage(0); });
  document.addEventListener("input", (e) => {
    if (!e.target.closest?.(".clone-dialog")) return;
    if (e.target.type === "checkbox") return;
    const ev = { len: e.target.value.length, handler: now(), ts: performance.timeOrigin + e.timeStamp };
    V.inputs.push(ev); afterPaint((p) => (ev.paint = p));
  }, true);
  document.addEventListener("change", (e) => {
    if (!e.target.matches?.(".clone-table input[type=checkbox]")) return;
    const ev = { handler: now(), ts: performance.timeOrigin + e.timeStamp };
    V.toggles.push(ev); afterPaint((p) => (ev.paint = p));
  }, true);
  let last = performance.now();
  const loop = (t) => { if (t - last > 50) V.gaps.push([Math.round(performance.timeOrigin + last), Math.round(t - last)]); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return "ok";
})()
