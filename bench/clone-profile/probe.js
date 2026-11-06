// Installed in the app's page by run.sh (`wd.mjs eval`). Reads only: it adds listeners and observers and moves no node.
// Each key in the dialog and each part checkbox click is timed from the event's timestamp to the frame after it
// (requestAnimationFrame, then a message posted from there runs once that frame is drawn). The open is timed from
// the click on Clone a profile… to the frame after the table shows with nothing still reading. `gaps` lists frames
// that took longer than 34 ms.
(() => {
  if (window.__lag) return "already";
  const L = (window.__lag = { events: [], gaps: [], muts: 0, open: undefined });
  const afterPaint = (cb) =>
    requestAnimationFrame(() => {
      const raf = performance.now();
      const ch = new MessageChannel();
      ch.port1.onmessage = () => cb(raf, performance.now());
      ch.port2.postMessage(0);
    });
  const record = (kind, e) => {
    const ev = { kind, key: e.key, t0: e.timeStamp, handler: performance.now(), m0: L.muts };
    L.events.push(ev);
    afterPaint((raf, paint) => Object.assign(ev, { raf, paint, m1: L.muts }));
  };
  document.addEventListener("keydown", (e) => e.target.closest?.(".clone-dialog") && record("key", e), true);
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.matches?.(".clone-table input[type=checkbox]")) record("toggle", e);
      if (e.target.closest?.("button")?.textContent.includes("Clone a profile")) {
        const open = (L.open = { t0: e.timeStamp, handler: performance.now() });
        const poll = () => {
          if (document.querySelector(".clone-table") && !document.querySelector(".clone-loading")) return afterPaint((raf, paint) => (open.ready = paint));
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }
    },
    true,
  );
  new MutationObserver((ms) => (L.muts += ms.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  let last = performance.now();
  const loop = (t) => {
    if (t - last > 34) L.gaps.push([Math.round(last), Math.round(t - last)]);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return "ok";
})()
