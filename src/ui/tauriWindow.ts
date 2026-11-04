// Asking before the window closes, for an unsaved edit. Registered only while there is one: while a close listener is
// registered, Tauri leaves closing to the webview.
//
// With Close to tray on, Rust hides the window instead of closing it (tray.rs), and the edit stays on screen, so a
// guard asks nothing when the window is already hidden by the time it hears of the close. While any guard is
// registered, Rust is told there is an unsaved edit, so the tray's Quit brings the window forward and closes through
// the guard's question instead of exiting under it (ADR 0034).
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Calls `ask` instead of closing the window, with a function that closes it anyway. Resolves to the function that
 * stops asking.
 */
export type CloseGuard = (ask: (close: () => void) => void) => Promise<() => void>;

let guards = 0;
const tellRust = (unsaved: boolean) => void invoke("window_unsaved", { unsaved }).catch(() => {});

/** Registers a close guard on the Tauri window. */
export async function guardWindowClose(ask: (close: () => void) => void): Promise<() => void> {
  const win = getCurrentWindow();
  const unlisten = await win.onCloseRequested(async (e) => {
    e.preventDefault();
    // Hidden to the tray, not closed: nothing is lost.
    if (!(await win.isVisible().catch(() => true))) return;
    ask(() => void win.destroy());
  });
  if (guards++ === 0) tellRust(true);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unlisten();
    if (--guards === 0) tellRust(false);
  };
}

export const tauriCloseGuard: CloseGuard = guardWindowClose;
