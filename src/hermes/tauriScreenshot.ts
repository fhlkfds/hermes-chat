// The real screenshot calls: Rust takes and stages captures (src-tauri/src/screenshot.rs), and tells the webview when
// `hermes-chat --screenshot` asks for one from a desktop shortcut (src-tauri/src/remote.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Captured, ScreenshotApi } from "./screenshots";

export const tauriScreenshots: ScreenshotApi = {
  // Rust rejects with `{ kind, message }`, which the desk reads as it is.
  capture: (name) => invoke<Captured>("screenshot_capture", { name }),
  discard: (path) => invoke<void>("screenshot_discard", { path }),
};

/** How screenshots are taken on this desktop, for Settings. `ok` false: a capture will fail, and `summary` says why. */
export type ScreenshotSupport = { ok: boolean; summary: string };
export const screenshotSupport = () => invoke<ScreenshotSupport>("screenshot_support");

/**
 * Calls `fn` whenever a desktop shortcut asks for a screenshot. Rust keeps the request until a window takes it, so one
 * made before this window was signed in (or one that started the app) is taken now, if it's recent.
 */
export function onDesktopScreenshot(fn: () => void): () => void {
  const take = () => void invoke<boolean>("screenshot_take_request").then((asked) => asked && fn(), () => {});
  // Outside the app (tests, a plain browser) there is no Rust to listen to, and nothing to do.
  const stop = listen("screenshot-requested", take).catch(() => undefined);
  take();
  return () => void stop.then((s) => s?.());
}

/** Brings the window forward, so the owner can review a screenshot a desktop shortcut attached. */
export const showWindow = () => invoke<void>("screenshot_show_window").catch(() => {});
