// The tray icon and Close to tray, from Rust (tray.rs, ADR 0034). Outside the desktop app there is no tray: the status
// call fails, and Settings says the tray works only in the desktop app.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** `shown`: the icon is in the desktop's tray. `noTray`: nothing on this desktop shows tray icons now. `unavailable`: the icon couldn't be made (`why`). */
export type TrayState = "shown" | "noTray" | "unavailable";
export type TrayStatus = { closeToTray: boolean; tray: TrayState; why?: string };

export type TrayWiring = {
  status: () => Promise<TrayStatus>;
  /** Stores the setting and answers what Rust read back. */
  setCloseToTray: (on: boolean) => Promise<TrayStatus>;
  onStatus: (fn: (s: TrayStatus) => void) => () => void;
  /** The owner picked New chat in the tray menu; the window is already shown. */
  onNewChat: (fn: () => void) => () => void;
  /** The owner picked Open Inbox in the tray menu; the window is already shown. */
  onOpenInbox: (fn: () => void) => () => void;
  /** How many Inbox entries need the owner. Only the count leaves the webview, never what a chat says. */
  reportInbox: (count: number) => void;
};

/** Listens to a Rust event, and returns what stops listening at once, even before the listener is registered. */
export function listenTo<T>(event: string, fn: (payload: T) => void): () => void {
  let live = true;
  const stop = listen<T>(event, (e) => live && fn(e.payload)).catch(() => undefined);
  return () => {
    live = false;
    void stop.then((s) => s?.());
  };
}

export const tauriTray: TrayWiring = {
  status: () => invoke<TrayStatus>("tray_status"),
  setCloseToTray: (on) => invoke<TrayStatus>("tray_set_close_to_tray", { on }),
  onStatus: (fn) => listenTo<TrayStatus>("tray-status", fn),
  onNewChat: (fn) => listenTo<null>("tray-new-chat", fn),
  onOpenInbox: (fn) => listenTo<null>("tray-open-inbox", fn),
  reportInbox: (count) => void invoke("tray_inbox", { count }).catch(() => {}),
};
