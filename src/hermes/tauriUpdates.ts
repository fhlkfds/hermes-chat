// The app's update store, on the Rust commands in src-tauri/src/update.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";
import { restoreDrafts, updater, type Progress } from "./updates";

export const appUpdates = updater({
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args).catch(asError),
  channel: (onMessage) => {
    const channel = new Channel<Progress>();
    channel.onmessage = onMessage;
    return channel;
  },
  fetch: (...args) => fetch(...args),
  storage: localStorage,
});

/**
 * Puts back the drafts saved by an update's restart. Runs before the app first renders, so no draft is read before.
 * The saved copy is deleted only once every one is back; otherwise the next launch tries again.
 */
export async function restoreDraftsAfterRestart() {
  try {
    const saved = await invoke<string | null>("restart_drafts_read");
    if (saved !== null && restoreDrafts(localStorage, saved)) await invoke("restart_drafts_clear");
  } catch {
    // Outside the app; or the copy couldn't be deleted, and the next launch puts it back again.
  }
}
