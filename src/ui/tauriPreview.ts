// The preview pane's Local files, through Rust: the Open dialog runs there, and only a file picked in it can be read
// again (src-tauri/src/lib.rs `preview_pick_local`, `preview_read_local`, `preview_read_local_image`). And its web
// pages' framing check and Open in your browser (src-tauri/src/web_page.rs, ADR 0011).
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "../hermes/tauriPipe";
import { readLocalFile, type FileView, type Framing, type LocalText } from "../hermes/preview";

export type LocalFiles = {
  /** Opens the Open dialog; null when the owner cancels. */
  pick(): Promise<{ path: string; name: string } | null>;
  /** Reads a picked file. An image's `src` is an object URL, for the caller to revoke. */
  read(file: { path: string; name: string }): Promise<FileView>;
};

export const tauriLocalFiles: LocalFiles = {
  pick: () => invoke<{ path: string; name: string } | null>("preview_pick_local").catch(asError),
  read: (file) =>
    readLocalFile(file, {
      readText: (path) => invoke<LocalText>("preview_read_local", { path }).catch(asError),
      readImage: async (path) => {
        const bytes = await invoke<ArrayBuffer>("preview_read_local_image", { path }).catch(asError);
        return URL.createObjectURL(new Blob([bytes]));
      },
    }),
};

export type WebPages = {
  /** Whether the site refuses to be shown in the pane's frame, asked the way the frame asks. */
  check(url: string): Promise<Framing>;
  /** Opens the page in the owner's browser. Rejects with why it couldn't. */
  openInBrowser(url: string): Promise<void>;
};

export const tauriWebPages: WebPages = {
  check: (url) => invoke<Framing>("preview_check_web", { url, userAgent: navigator.userAgent }).catch(asError),
  openInBrowser: (url) => invoke<void>("preview_open_in_browser", { url }).catch(asError),
};

/**
 * A page on the Hermes server's own loopback, opened through an SSH tunnel to the sign-in's SSH target
 * (src-tauri/src/server_page.rs, ADR 0051). `url`: where the frame loads it, on this computer's `127.0.0.1`.
 * `target`: the SSH target it goes through. `at`: where it is on the server, as `localhost:3000`.
 */
export type ServerPage = { id: number; url: string; target: string; at: string };

/**
 * Why a server page didn't open, as Rust says it. `kind` picks what the pane offers: `noSshTarget` and `notConnected`
 * offer this computer; the rest offer Reload too.
 */
export class ServerPageError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export type ServerPages = {
  /**
   * Opens a tunnel for `url`. Rejects with a `ServerPageError`. `onClosed` hears, once, if the tunnel ends without
   * `close`: ssh exited, or the app left the server.
   */
  open(url: string, onClosed: (message: string) => void): Promise<ServerPage>;
  /** Closes the tunnel, ending its ssh. */
  close(id: number): void;
};

const asServerPageError = (e: unknown) =>
  Promise.reject(
    e && typeof e === "object" && "kind" in e && "message" in e ? new ServerPageError(String(e.kind), String(e.message)) : new ServerPageError("io", String(e)),
  );

export const tauriServerPages: ServerPages = {
  open: (url, onClosed) => {
    const onEvent = new Channel<{ kind: "closed"; message: string }>();
    onEvent.onmessage = (e) => onClosed(e.message);
    return invoke<ServerPage>("preview_server_open", { url, onEvent }).catch(asServerPageError);
  },
  close: (id) => void invoke("preview_server_close", { id }).catch(() => {}),
};
