// The app's update store, on the Rust commands in src-tauri/src/update.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";
import { clearCachedChats } from "./chatCache";
import { updater, type Progress } from "./updates";

export const appUpdates = updater({
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args).catch(asError),
  channel: (onMessage) => {
    const channel = new Channel<Progress>();
    channel.onmessage = onMessage;
    return channel;
  },
  fetch: (...args) => fetch(...args),
  storage: localStorage,
  clearCache: clearCachedChats,
});

/** Puts back the drafts saved by an update's restart. Runs before the app first renders, so no draft is read before. */
export async function restoreDraftsAfterRestart() {
  try {
    await appUpdates.restoreAfterRestart();
  } catch {
    // Outside the app; or the saved copy couldn't be deleted or set aside, and the next launch puts it back again.
  }
}
