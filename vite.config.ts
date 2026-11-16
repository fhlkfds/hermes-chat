/// <reference types="vitest/config" />
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// While serving, React Refresh adds an inline script and Vite's reload talks over a WebSocket; index.html's CSP lets
// neither through, so it is loosened for the dev server only.
const devCsp: Plugin = {
  name: "dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws:"),
};

const PDFJS = "node_modules/pdfjs-dist";
/** The folders pdf.js reads by file name: its image decoders, the fonts a PDF names without embedding, CMaps and ICC profiles. */
const PDFJS_FOLDERS = ["wasm", "standard_fonts", "cmaps", "iccs"];
const PDFJS_TYPES: Record<string, string> = { wasm: "application/wasm", js: "text/javascript" };

/**
 * pdf.js loads those files by name from a folder URL, not through imports (ADR 0186), so they go in the app as
 * `/pdfjs/<folder>/<file>`: copied into the build, and served by the dev server, which the e2e suite also runs on.
 */
export const pdfjsAssets: Plugin = {
  name: "pdfjs-assets",
  configureServer(server) {
    server.middlewares.use("/pdfjs", (req, res, next) => {
      const [folder, file, ...more] = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
      const path = file && !more.length && PDFJS_FOLDERS.includes(folder) && !file.startsWith(".") ? join(PDFJS, folder, file) : undefined;
      if (!path || !existsSync(path)) return next();
      res.setHeader("Content-Type", PDFJS_TYPES[file.split(".").pop()!] ?? "application/octet-stream");
      res.end(readFileSync(path));
    });
  },
  generateBundle() {
    for (const folder of PDFJS_FOLDERS)
      for (const file of readdirSync(join(PDFJS, folder)))
        this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${file}`, source: readFileSync(join(PDFJS, folder, file)) });
  },
};

export default defineConfig({
  plugins: [react(), devCsp, pdfjsAssets],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  // The jsdom tests that drive the whole app take up to about 5.5 s on CI's runners. Set here rather than per test or
  // file, a run's `--testTimeout` still replaces it when a busy machine needs more.
  test: { testTimeout: 20_000 },
});
