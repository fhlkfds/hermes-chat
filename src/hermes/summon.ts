// How the window learns it was brought forward by `hermes-chat --show`, `--toggle`, a second launch or a chat link
// (src-tauri/src/summon.rs), so the cursor goes back in the composer. There is no global shortcut in the app; a key is
// bound in the desktop's own config to run `hermes-chat --toggle`.
import { listen } from "@tauri-apps/api/event";

export type SummonApi = {
  /** Calls `fn` each time the window is brought forward. */
  onSummoned: (fn: () => void) => () => void;
};

export const tauriSummon: SummonApi = {
  onSummoned: (fn) => {
    const stop = listen<null>("summoned", () => fn()).catch(() => undefined);
    return () => void stop.then((s) => s?.());
  },
};

/** The real one in the desktop app; none in a browser. */
export const desktopSummon: SummonApi | undefined =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriSummon : undefined;
