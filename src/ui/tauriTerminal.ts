// The terminal on the server, through Rust (src-tauri/src/terminal.rs): ssh runs there in a pseudo-terminal, and
// its output arrives here as base64 bytes.
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "../hermes/tauriPipe";
import type { TerminalApi } from "../hermes/terminal";

type RawEvent = { kind: "output"; data: string } | { kind: "exit"; code: number | null };

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tauriTerminal: TerminalApi = {
  open: (target, cols, rows, onEvent) => {
    const onRaw = new Channel<RawEvent>();
    onRaw.onmessage = (e) => onEvent(e.kind === "output" ? { kind: "output", data: fromBase64(e.data) } : e);
    return invoke<number>("terminal_open", { target, cols, rows, onEvent: onRaw }).catch(asError);
  },
  write: (id, data) => invoke<void>("terminal_write", { id, data }).catch(asError),
  resize: (id, cols, rows) => invoke<void>("terminal_resize", { id, cols, rows }).catch(asError),
  close: (id) => void invoke("terminal_close", { id }).catch(() => {}),
};
