// The global shortcut that brings Hermes Chat forward from any app (ADR 0033). Rust registers it and keeps the
// setting (src-tauri/src/summon.rs); this is how Settings reads and changes it, and how the window learns it was
// brought forward.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** How this desktop registers it: the app's own X11 grab, the desktop portal (Wayland), or not at all. */
export type SummonBackend = "x11" | "portal" | "none";
/** `failed`: the saved shortcut isn't registered. `unavailable`: nothing can be here; a desktop binding is the way. */
export type SummonState = "off" | "pending" | "working" | "failed" | "unavailable";
export type SummonFailure = { shortcut: string; kind: "conflict" | "denied" | "failed"; message: string };

export type SummonStatus = {
  backend: SummonBackend;
  wayland: boolean;
  desktop: "hyprland" | "sway" | "gnome" | "kde" | "other";
  /** Why nothing can be registered here. */
  unavailable: string | null;
  /** The shortcut in use: the last one that registered. */
  shortcut: string | null;
  hideWhenActive: boolean;
  state: SummonState;
  /** The key the desktop says it set, when it says. */
  trigger: string | null;
  /** What Hyprland lists the shortcut as, for a `global` bind. */
  hyprlandName: string | null;
  /** A shortcut that didn't register, for Retry. The one in use stays. */
  failure: SummonFailure | null;
  paused: boolean;
};

export type SummonApi = {
  status: () => Promise<SummonStatus>;
  /** Registers a new shortcut, or turns it off with null. Resolves with the outcome, a failure included. */
  set: (shortcut: string | null) => Promise<SummonStatus>;
  retry: () => Promise<SummonStatus>;
  setHide: (hide: boolean) => Promise<SummonStatus>;
  /** Lets go of the X11 grab while a new shortcut is recorded, so pressing the current one reaches the recorder. */
  pause: (paused: boolean) => Promise<SummonStatus>;
  /** Calls `fn` with each status Rust reports by itself (a registration finishing, the desktop changing the key). */
  onStatus: (fn: (s: SummonStatus) => void) => () => void;
  /** Calls `fn` each time the shortcut or `hermes-chat --show` brings the window forward. */
  onSummoned: (fn: () => void) => () => void;
};

const listenTo = <T>(event: string, fn: (payload: T) => void) => {
  const stop = listen<T>(event, (e) => fn(e.payload)).catch(() => undefined);
  return () => void stop.then((s) => s?.());
};

export const tauriSummon: SummonApi = {
  status: () => invoke<SummonStatus>("summon_status"),
  set: (shortcut) => invoke<SummonStatus>("summon_set", { shortcut }),
  retry: () => invoke<SummonStatus>("summon_retry"),
  setHide: (hide) => invoke<SummonStatus>("summon_set_hide", { hide }),
  pause: (paused) => invoke<SummonStatus>("summon_pause", { paused }),
  onStatus: (fn) => listenTo("summon-status", fn),
  onSummoned: (fn) => listenTo<null>("summoned", () => fn()),
};

/** The real one in the desktop app; none in a browser. */
export const desktopSummon: SummonApi | undefined =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriSummon : undefined;

/** The command a desktop key runs: `--toggle` hides Hermes Chat when it is already in front, as the setting says. */
export const summonCommand = (hideWhenActive: boolean) => `hermes-chat ${hideWhenActive ? "--toggle" : "--show"}`;

const parts = (shortcut: string) => {
  const p = shortcut.split("+");
  return { key: p[p.length - 1], mods: p.slice(0, -1) };
};

/** A Hyprland bind line for the shortcut: `bind = CTRL ALT, H, exec, hermes-chat --show`. */
export function hyprlandBind(shortcut: string, action: string): string {
  const { key, mods } = parts(shortcut);
  const names: Record<string, string> = { Ctrl: "CTRL", Alt: "ALT", Shift: "SHIFT", Super: "SUPER" };
  const keys: Record<string, string> = { PrintScreen: "Print", ScrollLock: "Scroll_Lock" };
  return `bind = ${mods.map((m) => names[m]).join(" ")}, ${keys[key] ?? key}, ${action}`;
}

/** A Sway bindsym line: `bindsym Ctrl+Mod1+h exec hermes-chat --show`. */
export function swayBind(shortcut: string, command: string): string {
  const { key, mods } = parts(shortcut);
  const names: Record<string, string> = { Ctrl: "Ctrl", Alt: "Mod1", Shift: "Shift", Super: "Mod4" };
  const keys: Record<string, string> = { PrintScreen: "Print", ScrollLock: "Scroll_Lock" };
  const k = keys[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  return `bindsym ${[...mods.map((m) => names[m]), k].join("+")} exec ${command}`;
}
