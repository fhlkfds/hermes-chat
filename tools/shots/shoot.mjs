// Screenshots the signed-in app (main.tsx) in headless Chromium: one PNG per scene into tools/shots/out/.
// Uses Playwright's cached headless shell or $CHROME, as bench/run.mjs does. Usage: node tools/shots/shoot.mjs [scene...]
import { build, preview } from "vite";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const out = fileURLToPath(new URL("./out/", import.meta.url));

// Each scene: the page's query, then a script run in the page once the chat list shows.
const click = (sel, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text ?? "")}));
     if (!el) throw new Error("no " + ${JSON.stringify(sel + " " + (text ?? ""))}); el.click(); })()`;
const key = (k, mods = {}) => `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(mods)} }))`;
// The chat list's sections (ADR 0036): three chats moved out of Settled, two of them snoozed (as another window would
// leave them), and a reply running in "NAS disk usage" so it shows in Working.
const sections = `(async () => {
  const h = window.shots.hermes;
  for (const id of ["caddy", "rust", "trip"]) await h.unsettle(id);
  const scope = JSON.stringify(["ssh", "liam@hermes", "liam", h.getSnapshot().profile]);
  localStorage.setItem("hermes-chat.snoozes", JSON.stringify({ v: 1, scopes: { [scope]: { trip: Date.now() + 3 * 3600e3, rust: Date.now() + 26 * 3600e3 } } }));
  window.dispatchEvent(new StorageEvent("storage", { key: "hermes-chat.snoozes" }));
  void h.send("nas", "Run a SMART check on every disk in tank");
})()`;
const menuOn = (chat) =>
  `(() => { const el = document.querySelector('.row-open[data-chat="${chat}"]'); const r = el.getBoundingClientRect();
     el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 20 })); })()`;
const scenes = {
  "sidebar-sections": { query: "", steps: [sections, click(".section-toggle", "Snoozed"), click(".section-toggle", "Settled")] },
  "sidebar-sections-light": { query: "?mode=light", steps: [sections, click(".section-toggle", "Snoozed"), click(".section-toggle", "Settled")] },
  "snooze-menu": { query: "", steps: [sections, menuOn("caddy")] },
  "snooze-custom": { query: "", steps: [sections, menuOn("caddy"), click(".menu-item", "Custom…"), click(".snooze-dialog .segmented button", "Duration")] },
  // A headless page never has focus and isn't hovered, so the actions a hover shows are shown on one top row (Settle) and
  // one Settled row (Unsettle): the same icon-only button.
  unsettle: {
    query: "",
    steps: [
      sections,
      click(".section-toggle", "Settled"),
      `(() => { const s = document.head.appendChild(document.createElement("style"));
         s.textContent = '.row:has([data-chat="backup"]) .row-action, .row:has([data-chat="zfs"]) .row-action { display: grid } .row:has([data-chat="backup"]) .row-meta, .row:has([data-chat="zfs"]) .row-meta { display: none }'; })()`,
    ],
  },
  "new-chat": { query: "", steps: [] },
  chat: { query: "", steps: [click("button", "Nightly backup")] },
  "chat-light": { query: "?mode=light", steps: [click("button", "Nightly backup")] },
  "new-chat-light": { query: "?mode=light", steps: [] },
  search: { query: "", steps: [click("button", "Nightly backup"), key("k", { ctrlKey: true })] },
  settings: { query: "", steps: [key(",", { ctrlKey: true })] },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}

await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];
const profile = mkdtempSync(join(tmpdir(), "shots-chrome-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
try {
  for (const name of wanted) {
    const scene = scenes[name];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
      if (msg.method === "Runtime.exceptionThrown") logs.push(JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params));
    });
    const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
    const evaluate = async (expression) => {
      const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`${name}: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: url + scene.query });
    for (let i = 0; !(await evaluate("!!document.querySelector('.sidebar, nav, aside') && document.body.innerText.includes('Nightly backup')")); i++) {
      if (i > 100) throw new Error(`${name}: app never showed. ${logs.join("\n")}`);
      await sleep(100);
    }
    await sleep(400);
    for (const step of scene.steps) {
      await evaluate(step);
      await sleep(500);
    }
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
    console.log(`${name}.png`, logs.length ? logs : "");
    ws.close();
  }
} finally {
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
