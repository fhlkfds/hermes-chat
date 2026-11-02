// How the app looks on this computer: the interface and code fonts and their sizes, and whether code blocks wrap long
// lines. Kept in localStorage and applied to the root element as CSS variables (styles.css), so it holds from launch,
// sign-in screen included. Nothing here goes to Hermes.

/** An empty font is the app's own default. Sizes are in CSS pixels. */
export type Appearance = { uiFont: string; uiSize: number; monoFont: string; monoSize: number; wordWrap: boolean };

export const DEFAULT_APPEARANCE: Appearance = { uiFont: "", uiSize: 14, monoFont: "", monoSize: 13, wordWrap: false };
export const UI_SIZES = [12, 13, 14, 15, 16, 17, 18, 20];
export const MONO_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];

const KEY = "hermes-chat.appearance";
/** Longer than any real family name; anything past it is not a font. */
const MAX_FONT = 120;

export type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

/** A family name as fc-list gives it, or empty: no control characters, trimmed. */
const cleanFont = (f: unknown): string => (typeof f === "string" && f.length <= MAX_FONT && !/[\0-\x1f\x7f]/.test(f) ? f.trim() : "");
const pickSize = (n: unknown, sizes: number[], fallback: number) => (typeof n === "number" && sizes.includes(n) ? n : fallback);

/** What `storage` holds, with anything missing or not one of the choices back at its default. */
export function loadAppearance(storage: AppearanceStorage): Appearance {
  let saved: Partial<Record<keyof Appearance, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // Unreadable: the defaults.
  }
  const d = DEFAULT_APPEARANCE;
  return {
    uiFont: cleanFont(saved.uiFont),
    uiSize: pickSize(saved.uiSize, UI_SIZES, d.uiSize),
    monoFont: cleanFont(saved.monoFont),
    monoSize: pickSize(saved.monoSize, MONO_SIZES, d.monoSize),
    wordWrap: typeof saved.wordWrap === "boolean" ? saved.wordWrap : d.wordWrap,
  };
}

/** A family name as a CSS string, so a name with quotes or backslashes stays one name. */
export const cssFamily = (font: string) => `"${font.replace(/["\\]/g, "\\$&")}"`;

/** Sets the CSS variables styles.css reads. The app's default fonts stay as fallbacks behind a chosen one. */
export function applyAppearance(a: Appearance, root: HTMLElement) {
  const font = (name: string, value: string) => (value ? root.style.setProperty(name, cssFamily(value)) : root.style.removeProperty(name));
  font("--ui-font", a.uiFont);
  font("--mono-font", a.monoFont);
  root.style.fontSize = `${a.uiSize}px`;
  root.style.setProperty("--mono-size", `${a.monoSize}px`);
  root.classList.toggle("wrap-code", a.wordWrap);
}

export type AppearanceStore = {
  get(): Appearance;
  /** Applies the change at once and keeps it. */
  set(change: Partial<Appearance>): void;
  subscribe(fn: () => void): () => void;
};

/** The appearance kept in `storage`, applied to `root` now and on every change. */
export function appearanceStore(storage: AppearanceStorage, root: HTMLElement): AppearanceStore {
  let current = loadAppearance(storage);
  const listeners = new Set<() => void>();
  applyAppearance(current, root);
  return {
    get: () => current,
    set(change) {
      current = { ...current, ...change };
      applyAppearance(current, root);
      try {
        storage.setItem(KEY, JSON.stringify(current));
      } catch {
        // Kept until the app closes.
      }
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** The font families installed on this computer; `mono` are the fixed-width ones. */
export type Fonts = { all: string[]; mono: string[] };
