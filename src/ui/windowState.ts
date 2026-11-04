// Whether the window is hidden to the tray (tray.rs, ADR 0033). While it is, chats on screen aren't marked read,
// Dictation's recording is dropped and Read aloud stops; replies, queued messages and drafts carry on as they were.
// When it comes back, focus goes back where it was, or to the active pane's composer.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let hidden = false;
let lastFocus: Element | null = null;
/** Bumped on every change, so a focus restore waiting from an earlier showing does nothing. */
let turn = 0;
const subs = new Set<() => void>();

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
const get = () => hidden;

/** The window is hidden to the tray now. */
export const useWindowHidden = () => useSyncExternalStore(subscribe, get, get);

/** The composer to type in once the window is back: the active pane's, or the only one showing. */
const composer = (doc: Document) =>
  doc.querySelector<HTMLElement>(".pane.active [data-composer]") ?? doc.querySelector<HTMLElement>(".pane:not(.hidden) [data-composer]");

export function setWindowHidden(now: boolean, doc: Document = document) {
  if (now === hidden) return;
  if (now) lastFocus = doc.activeElement;
  hidden = now;
  const mine = ++turn;
  for (const fn of [...subs]) fn();
  if (now) return;
  const back = lastFocus;
  lastFocus = null;
  // After React has rendered the shown window.
  setTimeout(() => {
    if (mine !== turn || (doc.activeElement && doc.activeElement !== doc.body)) return;
    const to = back instanceof HTMLElement && back.isConnected && back !== doc.body ? back : composer(doc);
    to?.focus();
  }, 0);
}

/**
 * Follows the window's visibility from Rust. Called once, at startup. Once listening, it asks Rust how things stand,
 * so a window hidden before this page started listening (a close while it loaded) still counts as hidden.
 */
export async function followWindowVisibility(): Promise<void> {
  try {
    let heard = false;
    await listen<{ hidden: boolean }>("window-visibility", (e) => {
      heard = true;
      setWindowHidden(e.payload.hidden);
    });
    const now = await invoke<boolean>("window_hidden");
    // An event that came while asking is newer than the answer.
    if (!heard) setWindowHidden(now);
  } catch {
    // Outside the desktop app there is no window to hide.
  }
}
