// Chat links the desktop hands Hermes Chat (src-tauri links.rs): the one it was started with, and any opened while it
// runs. Rust hands each out once, so they are taken here, once for the whole app, and held until the app has dealt
// with them. A component mounting twice (StrictMode) can't lose one.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A link as it arrived, not yet read; `at` tells one from the next, even the same link opened twice. */
export type ArrivedLink = { raw: string; at: number };

export type LinkInbox = {
  subscribe(fn: () => void): () => void;
  getSnapshot(): ArrivedLink | undefined;
  /**
   * The link the app was started with, if any, has been read. Until then an empty inbox doesn't mean there is no
   * link, so the app doesn't reopen the last chat yet (ADR 0036).
   */
  isReady(): boolean;
  /** The app has dealt with the link that arrived `at`; a newer one stays. */
  clear(at: number): void;
  /** For tests, and for a link that didn't come from the desktop. */
  arrive(raw: string): void;
};

/**
 * An inbox `start` fills, once something subscribes. `start` resolves once the link the app was started with has
 * been read; with no `start`, the inbox is ready at once.
 */
export function linkInbox(start?: (arrive: (raw: string) => void) => Promise<void>): LinkInbox {
  let latest: ArrivedLink | undefined;
  let seq = 0;
  let started = false;
  let ready = !start;
  const fns = new Set<() => void>();
  const notify = () => {
    for (const fn of fns) fn();
  };
  const arrive = (raw: string) => {
    latest = { raw, at: Date.now() * 1000 + (seq++ % 1000) };
    notify();
  };
  const begin = () => {
    if (started) return;
    started = true;
    const done = () => {
      ready = true;
      notify();
    };
    start?.(arrive).then(done, done);
  };
  return {
    subscribe(fn) {
      fns.add(fn);
      begin();
      return () => fns.delete(fn);
    },
    getSnapshot: () => latest,
    isReady: () => ready,
    clear(at) {
      if (latest?.at !== at) return;
      latest = undefined;
      notify();
    },
    arrive,
  };
}

/** The two IPC calls the desktop inbox makes, so tests can stand in for Rust. */
export type LinkIpc = {
  take(): Promise<string | null>;
  onArrived(fn: () => void): Promise<unknown>;
};

const tauriIpc: LinkIpc = {
  take: () => invoke<string | null>("chat_link_take"),
  onArrived: (fn) => listen("chat-link", fn),
};

/**
 * Listens for Rust saying a link has arrived, then takes what it holds now. Listening first means a link arriving
 * meanwhile is either taken now or announced after. Takes run one at a time, so links arrive here in the order Rust
 * handed them out, and a slow answer can't put an older link over a newer one. Resolves once the first take is done.
 */
export function fromDesktop(ipc: LinkIpc) {
  return async (arrive: (raw: string) => void): Promise<void> => {
    let draining = Promise.resolve();
    const take = () =>
      (draining = draining.then(async () => {
        const raw = await ipc.take().catch(() => null);
        if (raw) arrive(raw);
      }));
    await ipc.onArrived(() => void take()).catch(() => {});
    await take();
  };
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const desktopLinks = linkInbox(inTauri ? fromDesktop(tauriIpc) : undefined);
