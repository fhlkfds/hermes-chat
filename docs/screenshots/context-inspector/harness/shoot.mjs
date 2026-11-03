// Builds the screenshot page (main.tsx), serves it, and captures each scene in Playwright's cached headless Chromium
// over the DevTools protocol, as bench/run.mjs does. From the repo root:
//   node docs/screenshots/context-inspector/harness/shoot.mjs
import { build, preview } from "vite";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const out = fileURLToPath(new URL("..", import.meta.url));
const SCENES = [
  ["1-window", "window", 1280],
  ["2-unavailable", "empty", 1280],
  ["3-compactions", "compactions", 1280],
  ["4-compact-confirm", "confirm", 1280],
  ["5-compacted", "compacted", 1280],
  ["6-no-compactions", "no-compactions", 1280],
  ["7-narrow", "narrow", 760],
];

function chrome() {
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}

await build({ configFile });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];
const profile = mkdtempSync(join(tmpdir(), "h97-chrome-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,820", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
});
const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

try {
  for (const [name, shot, width] of SCENES) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${url}?shot=${shot}` });
    let ok = false;
    for (let i = 0; i < 600 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ok = await evaluate("window.ready === true");
    }
    if (!ok) throw new Error(`${name} never got ready: ${await evaluate("document.body.innerText.slice(0, 400)")}`);
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
    console.log("wrote", name);
  }
} finally {
  ws.close();
  proc.kill();
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
