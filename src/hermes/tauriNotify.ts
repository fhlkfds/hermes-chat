// The real notifications: Rust posts them to the desktop's notification service (src-tauri/src/notify.rs).
import { invoke } from "@tauri-apps/api/core";
import type { Notify } from "./transport";
import { asError } from "./tauriPipe";

export const desktopNotify: Notify = (n) => invoke<void>("notify_desktop", n).catch(asError);
