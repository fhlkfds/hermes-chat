// The real pipe: Rust signs in to the dashboard, through an SSH tunnel (ADR 0003) or straight to a URL, and relays
// `/api/ws` frames and REST calls. It also reads the files the owner attaches, so their bytes never pass through the
// webview.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalFile, OpenPipe, PipeEvent, Route } from "./pipe";

// A failed command rejects with the Rust error's text, not an Error.
export const asError = (e: unknown) => Promise.reject(new Error(String(e)));

/** An extra request header for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0006). */
export type ExtraHeader = { name: string; value: string };

/**
 * `mode` picks which of `sshTarget` and `url` is used. `headers` go with every request to a URL, never through the SSH
 * tunnel; Rust checks them. Like the password, they are kept in the system keyring, never beside the rest.
 */
export type SignInDetails = { mode: "ssh" | "url"; sshTarget: string; url: string; username: string; password: string; headers?: ExtraHeader[] };

export function tauriPipe(d: SignInDetails): OpenPipe {
  const target = d.mode === "ssh" ? { kind: "ssh", target: d.sshTarget } : { kind: "url", url: d.url, headers: d.headers ?? [] };
  return async (onEvent, profile) => {
    const channel = new Channel<PipeEvent>();
    channel.onmessage = onEvent;
    const route = await invoke<Route>("hermes_connect", { target, username: d.username, password: d.password, profile, onEvent: channel }).catch(asError);
    return {
      route,
      send: (frame) => invoke("hermes_send", { frame }),
      request: (method, path, body) => invoke<string>("hermes_request", { method, path, body }).catch(asError),
      statFiles: (paths) => invoke<LocalFile[]>("hermes_stat_files", { paths }),
      sendFile: (head, path, tail, maxBytes) => invoke<void>("hermes_send_file", { head, path, tail, maxBytes }).catch(asError),
      close: () => invoke("hermes_disconnect"),
    };
  };
}
