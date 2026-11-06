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
  /** Opens the page in the owner's default browser, and gives the browser's name where it is known. Rejects with why it couldn't. */
  openInBrowser(url: string): Promise<string | null>;
  /** Where there is one (Linux), the Preview's own page view, which takes the frame's place (ADR 0081). */
  native?: NativePages;
};

/** A rectangle in the window's CSS pixels. */
export type Rect = { x: number; y: number; width: number; height: number };
/** Where a native page shows, and the parts of that the app's own layers cover, which the page leaves bare. */
export type Placement = { rect: Rect; holes: Rect[] };
/**
 * What a native page says: its first response came, so it has something to show; it couldn't load; or the owner
 * pressed Escape in it and the page didn't use it, which gives the keyboard back to the app.
 */
export type PageEvent = { kind: "shown" } | { kind: "failed"; message: string } | { kind: "escaped" };
/** A page open in the native view. Hidden until placed; `close` hides and stops it. */
export type NativePage = { place(placement: Placement | null): void; close(): void };
export type NativePages = { open(url: string, onEvent: (e: PageEvent) => void): NativePage };

/**
 * The view's commands, each sent once the one before it has finished, so Rust gets them in the order the pane made
 * them: a close never comes before its open, nor an old page's open after a new one's.
 */
let viewCommands: Promise<unknown> = Promise.resolve();
const inOrder = <T>(command: () => Promise<T>): Promise<T> => {
  const sent = viewCommands.then(command);
  viewCommands = sent.catch(() => {});
  return sent;
};

export const tauriNativePages: NativePages = {
  open: (url, onEvent) => {
    // The page's name in Rust, so a page that went away can't move or close the next one.
    const key = crypto.randomUUID();
    const events = new Channel<PageEvent>();
    events.onmessage = onEvent;
    inOrder(() => invoke("preview_page_open", { key, url, onEvent: events })).catch((e) => onEvent({ kind: "failed", message: String(e) }));
    return {
      place: (placement) => void inOrder(() => invoke("preview_page_place", { key, placement })).catch(() => {}),
      close: () => void inOrder(() => invoke("preview_page_close", { key })).catch(() => {}),
    };
  },
};

export const tauriWebPages: WebPages = {
  check: (url) => invoke<Framing>("preview_check_web", { url, userAgent: navigator.userAgent }).catch(asError),
  openInBrowser: (url) => invoke<string | null>("preview_open_in_browser", { url }).catch(asError),
  ...(/\bLinux\b/.test(navigator.userAgent) && { native: tauriNativePages }),
};

/**
 * A page on the Hermes server's own loopback, opened through an SSH tunnel to the sign-in's SSH target
 * (src-tauri/src/server_page.rs, ADR 0052). `url`: where the frame loads it, on this computer's `127.0.0.1`.
 * `target`: the SSH target it goes through. `at`: where it is on the server, as `localhost:3000`.
 */
export type ServerPage = { id: string; url: string; target: string; at: string };

/**
 * Why a server page didn't open, as Rust says it. `kind` picks what the pane offers: `noSshTarget` and `notConnected`
 * offer this computer; `closed` means the app left the server while it connected; the rest offer Try again too.
 */
export class ServerPageError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

/** A server page being opened: `page` settles once its tunnel is open or failed; `close` ends it, at any point. */
export type OpeningPage = { page: Promise<ServerPage>; close(): void };

export type ServerPages = {
  /**
   * Opens a tunnel for `url`. `page` rejects with a `ServerPageError`. `onClosed` hears, once, if the tunnel ends
   * without `close`: ssh exited, or the app left the server.
   */
  open(url: string, onClosed: (message: string) => void): OpeningPage;
};

const asServerPageError = (e: unknown) =>
  Promise.reject(
    e && typeof e === "object" && "kind" in e && "message" in e ? new ServerPageError(String(e.kind), String(e.message)) : new ServerPageError("io", String(e)),
  );

export const tauriServerPages: ServerPages = {
  open: (url, onClosed) => {
    // The page's name in Rust from the start, so closing it while ssh connects ends that ssh too.
    const key = crypto.randomUUID();
    const onEvent = new Channel<{ kind: "closed"; message: string }>();
    onEvent.onmessage = (e) => onClosed(e.message);
    return {
      page: invoke<ServerPage>("preview_server_open", { url, key, onEvent }).catch(asServerPageError),
      close: () => void invoke("preview_server_close", { key }).catch(() => {}),
    };
  },
};
