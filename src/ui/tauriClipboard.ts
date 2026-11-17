// This computer's clipboard text, through Rust (src-tauri/src/clipboard_text.rs), for copy and paste with the Screen.
import { invoke } from "@tauri-apps/api/core";
import type { LocalClipboard } from "../hermes/screenClipboard";

export const tauriClipboard: LocalClipboard = {
  read: () => invoke<string>("clipboard_text"),
  write: (text) => invoke("set_clipboard_text", { text }),
};
