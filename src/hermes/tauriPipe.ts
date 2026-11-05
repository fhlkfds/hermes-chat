// The real pipe: Rust signs in to the dashboard, through an SSH tunnel (ADR 0003) or straight to a URL, and relays
// `/api/ws` frames and REST calls. It also reads the files the owner attaches, so their bytes never pass through the
// webview.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalFile, OpenPipe, PipeEvent, Route, ToolsetGuards, Transcript, VoiceSetup } from "./pipe";
import type { Downloaded, PickedUpload, TransferProgress } from "./remoteFiles";
import type { Probe, Probed, ProbeFailure, SavedKey } from "./setup";
import { routedPipe, type ReachRoute, type RouteDetails, type RoutedHooks } from "./routes";

// A failed command rejects with the Rust error's text, not an Error.
export const asError = (e: unknown) => Promise.reject(new Error(String(e)));

/** Base64 to bytes. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An extra request header for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0006). */
export type ExtraHeader = { name: string; value: string };

/**
 * `mode` picks which of `sshTarget` and `url` is used. `headers` go with every request to a URL, never through the SSH
 * tunnel; Rust checks them. Like the password, they are kept in the system keyring, never beside the rest.
 */
export type SignInDetails = {
  mode: "ssh" | "url";
  sshTarget: string;
  url: string;
  username: string;
  password: string;
  headers?: ExtraHeader[];
  /**
   * The connection's routes, tried in order (routes.ts, ADR 0056); the address above is then the first route's. Absent
   * on a sign-in with one route, which is its address.
   */
  routes?: RouteDetails[];
  /** The server every route must reach, once known: a hash of its Hermes install id (ADR 0056). */
  server?: string;
};

const targetOf = (d: SignInDetails) =>
  d.mode === "ssh" ? { kind: "ssh", target: d.sshTarget } : { kind: "url", url: d.url, headers: d.headers ?? [] };

const asProbeFailure = (e: unknown): ProbeFailure => (e && typeof e === "object" ? (e as ProbeFailure) : { stage: "address", message: String(e) });

/** Setup's connection test (src-tauri `hermes_probe`): it rejects with a `ProbeFailure`, not an Error. One route only. */
export const tauriProbe: Probe = {
  run: (d, profile, quick = false) =>
    invoke<Probed>("hermes_probe", { target: targetOf(d), username: d.username, password: d.password, profile, expectServer: d.server ?? null, quick }).catch(
      (e: unknown) => Promise.reject<Probed>(asProbeFailure(e)),
    ),
  cancel: () => void invoke("hermes_probe_cancel").catch(() => {}),
};

/** What `hermes_reach` found: how the route went, and the dashboard's `/api/status` body, if it answered one. */
export type Reached = { route: Route; status?: string | null };

/**
 * Reaches one route without signing in (src-tauri `hermes_reach`): the tunnel or address opens, and `/api/status`
 * answers as the Hermes `expectServer` names. Rejects with a `ProbeFailure`. No password goes anywhere.
 */
export const tauriReach = (d: SignInDetails, expectServer: string | undefined, quick = true): Promise<Reached> =>
  invoke<Reached>("hermes_reach", { target: targetOf(d), expectServer: expectServer ?? null, quick }).catch((e: unknown) =>
    Promise.reject<Reached>(asProbeFailure(e)),
  );

export const reachRoute: ReachRoute = (d, expectServer) => tauriReach(d, expectServer);

/** The pipe for a connection: its routes, tried in order (routes.ts `routedPipe`), each opened by Rust. */
export function tauriPipe(d: SignInDetails, hooks?: RoutedHooks): OpenPipe {
  return routedPipe(d, (one, opts) => routePipe(one, opts), hooks);
}

/** One route's pipe. `expectServer`, `quick` and `sshRoute`: see routes.ts `OpenRoute`. */
function routePipe(d: SignInDetails, opts: { expectServer?: string; quick: boolean; sshRoute?: string }): OpenPipe {
  const target = targetOf(d);
  return async (onEvent, profile, signal) => {
    const channel = new Channel<PipeEvent>();
    channel.onmessage = onEvent;
    // Names this opening, so stopping it can't stop a later one (src-tauri `hermes_connect_cancel`).
    const attempt = crypto.randomUUID();
    const stop = () => void invoke("hermes_connect_cancel", { attempt }).catch(() => {});
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const route = await invoke<Route>("hermes_connect", {
      target,
      username: d.username,
      password: d.password,
      profile,
      attempt,
      onEvent: channel,
      expectServer: opts.expectServer ?? null,
      quick: opts.quick,
      sshRoute: opts.sshRoute ?? null,
    })
      .catch(asError)
      .finally(() => signal?.removeEventListener("abort", stop));
    return {
      route,
      send: (frame) => invoke("hermes_send", { frame }),
      request: (method, path, body) => invoke<string>("hermes_request", { method, path, body }).catch(asError),
      getLimited: (path, maxBytes) => invoke<string>("hermes_get_limited", { path, maxBytes }).catch(asError),
      statFiles: (paths) => invoke<LocalFile[]>("hermes_stat_files", { paths }),
      sendFile: (head, path, tail, maxBytes) => invoke<void>("hermes_send_file", { head, path, tail, maxBytes }).catch(asError),
      saveProviderKey: (profile, key, value) => invoke<SavedKey>("hermes_save_provider_key", { profile, key, value }).catch(asError),
      // The recording goes as the raw body, not as a JSON list of numbers.
      transcribe: (profile, audio, mime) =>
        invoke<Transcript>("hermes_transcribe", audio, {
          headers: { "x-mime": encodeURIComponent(mime), "x-profile": encodeURIComponent(profile) },
        }).catch(asError),
      speak: async (profile, text) => {
        const got = await invoke<{ mime: string; audio: string; provider?: string }>("hermes_speak", { profile, text }).catch(asError);
        return { ...got, audio: fromBase64(got.audio) };
      },
      voiceSetup: (profile) => invoke<VoiceSetup>("hermes_voice_setup", { profile }).catch(asError),
      toolsetGuards: (profile) => invoke<ToolsetGuards>("hermes_toolset_guards", { profile }).catch(asError),
      download: (id, path, name, onProgress) => {
        const channel = new Channel<TransferProgress>();
        channel.onmessage = onProgress;
        return invoke<Downloaded | null>("files_download", { id, path, name, onProgress: channel }).then((got) => got ?? undefined, asError);
      },
      pickUpload: () => invoke<PickedUpload | null>("files_pick_upload").then((p) => p ?? undefined, asError),
      discardUpload: (token) => invoke<void>("files_discard_pick", { token }),
      upload: (id, token, path, overwrite, onProgress) => {
        const channel = new Channel<TransferProgress>();
        channel.onmessage = onProgress;
        return invoke<string>("files_upload", { id, token, path, overwrite, onProgress: channel }).catch(asError);
      },
      saveText: (id, path, text, overwrite) => invoke<string>("files_save_text", { id, path, text, overwrite }).catch(asError),
      fsSaveText: (id, profile, path, text) => invoke<string>("fs_save_text", { id, profile, path, text }).catch(asError),
      cancelTransfer: (id) => invoke("files_cancel", { id }),
      openDisplay: async (ticket, onData, onClose) => {
        // RFB bytes arrive raw, as an ArrayBuffer; the close, once, as JSON.
        const channel = new Channel<ArrayBuffer | { code: number; reason: string }>();
        channel.onmessage = (m) => (m instanceof ArrayBuffer ? onData(m) : onClose(m.code, m.reason));
        const id = await invoke<number>("display_open", { ticket, onEvent: channel }).catch(asError);
        return {
          // The owner's keys and pointer go as the raw body.
          send: (bytes) => void invoke("display_send", bytes, { headers: { "x-display-id": String(id) } }).catch(() => {}),
          close: () => void invoke("display_close", { id }).catch(() => {}),
        };
      },
      close: () => invoke("hermes_disconnect"),
    };
  };
}
