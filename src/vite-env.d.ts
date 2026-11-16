/// <reference types="vite/client" />

// noVNC ships no types; the Screen types the little it uses (Screen.tsx `RfbClient`).
declare module "@novnc/novnc";

// mammoth's own bundle for browsers, the same in the app and in jsdom tests (whose resolver skips its `browser` field).
declare module "mammoth/mammoth.browser.js" {
  import mammoth = require("mammoth");
  export = mammoth;
}
