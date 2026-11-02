// Display preferences for this computer: the theme, whether the last chat reopens at launch and which chat that is in
// each profile, whether reasoning shows, the model last picked, and which items the status bar shows. All of it lives
// in one versioned JSON document under one localStorage key, so "Clear local cache" can't touch it (chatCache.ts) and
// later settings add fields here rather than new keys. Nothing here goes to Hermes. Every settings feature reads and writes through this module.

export const UI_PREFS_KEY = "hermes-ui-prefs";
/** The shape the document has now. Bump it, and add a step to UI_PREFS_MIGRATIONS, when a field changes meaning. */
export const UI_PREFS_VERSION = 1;

export type Theme = "light" | "dark" | "system";
export const THEMES: readonly Theme[] = ["light", "dark", "system"];

/** The model picked last, kept so the next new chat starts with it. */
export type ModelPick = { provider: string; model: string; effort?: string; fast?: boolean };

export type UIPrefs = {
  theme: Theme;
  /** Open the chat that was on screen when the app last closed. */
  reopenLastChat: boolean;
  /**
   * The chat last opened in each profile, by profile name; a profile whose New chat pane was on screen last has none.
   * Kept as the owner moves between chats, not when the app closes, so it holds however the app ends.
   */
  lastOpenChat: Record<string, string>;
  /** Show the model's reasoning blocks in transcripts. */
  reasoningBlocks: boolean;
  /** null: no sticky pick, so Hermes's default model is used. */
  modelPicker: ModelPick | null;
  /** The status bar items shown, in order. */
  statusBar: string[];
};

export const DEFAULT_UI_PREFS: Readonly<UIPrefs> = Object.freeze({
  theme: "system",
  reopenLastChat: true,
  lastOpenChat: Object.freeze({}) as Record<string, string>,
  reasoningBlocks: true,
  modelPicker: null,
  statusBar: [],
});

/** A stored document as read, before its fields are checked. */
export type UIPrefsDoc = Record<string, unknown>;
/** Turns a document of version `n` into one of version `n + 1`; keyed by `n`. */
export type UIPrefsMigrations = Readonly<Record<number, (doc: UIPrefsDoc) => UIPrefsDoc>>;

export const UI_PREFS_MIGRATIONS: UIPrefsMigrations = {
  // Version 0 is a document written without `v`; its fields already have version 1's shape.
  0: (doc) => doc,
};

const isDoc = (v: unknown): v is UIPrefsDoc => typeof v === "object" && v !== null && !Array.isArray(v);
/** A document's version: no `v` is version 0; anything that isn't a whole number isn't trusted at all. */
const versionOf = (doc: UIPrefsDoc) => (doc.v === undefined ? 0 : Number.isInteger(doc.v) ? (doc.v as number) : -1);

/**
 * `raw` brought up to version `to`, one step at a time. A document from a newer app is read as it is: its fields are
 * checked like any other, so the ones this version knows still apply. Anything that isn't a document is empty.
 */
export function migrateUIPrefs(raw: unknown, migrations: UIPrefsMigrations = UI_PREFS_MIGRATIONS, to: number = UI_PREFS_VERSION): UIPrefsDoc {
  if (!isDoc(raw)) return { v: to };
  let v = versionOf(raw);
  if (v < 0) return { v: to };
  let doc = raw;
  while (v < to) {
    const step = migrations[v];
    // A version with no way forward can't be read safely; start over from the defaults.
    if (!step) return { v: to };
    doc = step(doc);
    v++;
  }
  return { ...doc, v: Math.max(v, to) };
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

function toModelPick(v: unknown): ModelPick | null | undefined {
  if (v === null) return null;
  if (!isDoc(v)) return undefined;
  const provider = str(v.provider);
  const model = str(v.model);
  if (provider === undefined || model === undefined) return undefined;
  const effort = str(v.effort, 40);
  return { provider, model, ...(effort !== undefined && { effort }), ...(typeof v.fast === "boolean" && { fast: v.fast }) };
}

function toStatusBar(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((i): i is string => str(i, 60) !== undefined);
  return [...new Set(items)];
}

/** Only names and ids that are strings; anything else in the record is dropped. */
function toLastOpenChat(v: unknown): Record<string, string> | undefined {
  if (!isDoc(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter(([profile, id]) => str(profile) !== undefined && str(id) !== undefined)) as Record<string, string>;
}

/** The prefs `doc` holds, each field that is missing or not a valid value taken from `d`: the defaults, unless given. */
export function readUIPrefs(doc: UIPrefsDoc, d: Readonly<UIPrefs> = DEFAULT_UI_PREFS): UIPrefs {
  const pick = toModelPick(doc.modelPicker);
  return {
    theme: THEMES.includes(doc.theme as Theme) ? (doc.theme as Theme) : d.theme,
    reopenLastChat: typeof doc.reopenLastChat === "boolean" ? doc.reopenLastChat : d.reopenLastChat,
    lastOpenChat: toLastOpenChat(doc.lastOpenChat) ?? { ...d.lastOpenChat },
    reasoningBlocks: typeof doc.reasoningBlocks === "boolean" ? doc.reasoningBlocks : d.reasoningBlocks,
    modelPicker: pick === undefined ? (d.modelPicker && { ...d.modelPicker }) : pick,
    statusBar: toStatusBar(doc.statusBar) ?? [...d.statusBar],
  };
}

export type UIPrefsListener = (prefs: Readonly<UIPrefs>) => void;

/** The storage the prefs are kept in: localStorage in the app. Looked up on each use, so tests can swap it. */
const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
function readRaw(): string | null {
  try {
    return storage()?.getItem(UI_PREFS_KEY) ?? null;
  } catch {
    return null;
  }
}
function parse(raw: string | null): { doc: UIPrefsDoc; prefs: UIPrefs } {
  let parsed: unknown;
  try {
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    // Unreadable: the defaults.
  }
  const doc = migrateUIPrefs(parsed);
  return { doc, prefs: readUIPrefs(doc) };
}

// What was read last, so getUIPrefs returns the same object until the stored document changes (useSyncExternalStore
// needs that). A change that couldn't be stored is kept here, and holds until the app closes or another window writes.
let cachedRaw: string | null | undefined;
let cached: { doc: UIPrefsDoc; prefs: UIPrefs } = { doc: { v: UI_PREFS_VERSION }, prefs: readUIPrefs({}) };

function current() {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

const listeners = new Set<UIPrefsListener>();
const notify = () => {
  const prefs = cached.prefs;
  for (const fn of [...listeners]) fn(prefs);
};

/** The prefs on this computer, the defaults filling anything unset. The same object until they change. */
export function getUIPrefs(): Readonly<UIPrefs> {
  return current().prefs;
}

/**
 * Merges `patch` into the prefs and keeps them. Each field given replaces the old value whole (`statusBar` is not
 * appended to; `modelPicker: null` forgets the pick); fields left out, or given as undefined, stay as they are.
 * Fields this version doesn't know, written by a newer app, are kept. Listeners hear of it only if something changed.
 */
export function setUIPrefs(patch: Partial<UIPrefs>): void {
  const { doc, prefs } = current();
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  // A value that isn't valid leaves the field as it was.
  const next = readUIPrefs(given, prefs);
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  const nextDoc: UIPrefsDoc = { ...doc, ...next, v: UI_PREFS_VERSION };
  const raw = JSON.stringify(nextDoc);
  cached = { doc: nextDoc, prefs: next };
  try {
    storage()?.setItem(UI_PREFS_KEY, raw);
    cachedRaw = raw;
  } catch {
    // Not kept: `cached` holds the change while the stored document is still the one last read.
  }
  notify();
}

/** Another window changed the stored document. `key` null: that window cleared all of localStorage. */
function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== UI_PREFS_KEY) return;
  const before = cached.prefs;
  const after = current().prefs;
  if (after !== before && JSON.stringify(after) !== JSON.stringify(before)) notify();
}

/**
 * Calls `fn` with the new prefs whenever they change: by setUIPrefs in this window, or in another window of the app
 * (the `storage` event). Returns the function that stops it.
 */
export function subscribe(fn: UIPrefsListener): () => void {
  if (listeners.size === 0) {
    current();
    globalThis.addEventListener?.("storage", onStorage);
  }
  listeners.add(fn);
  return () => {
    if (!listeners.delete(fn) || listeners.size > 0) return;
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/**
 * Keeps `chatId` as the chat last opened in `profile`; null: the New chat pane is on screen, so there is none. Called on
 * every move between chats, so whatever was on screen last is what reopens, however the app closed.
 */
export function rememberOpenChat(profile: string, chatId: string | null): void {
  const { [profile]: _, ...others } = getUIPrefs().lastOpenChat;
  setUIPrefs({ lastOpenChat: chatId === null ? others : { ...others, [profile]: chatId } });
}

/** Drops `chatId` as `profile`'s last chat, if it still is: Hermes's list no longer has it. */
export function forgetOpenChat(profile: string, chatId: string): void {
  if (getUIPrefs().lastOpenChat[profile] === chatId) rememberOpenChat(profile, null);
}

/** The chat to open at launch in `profile`: its last one, if `reopenLastChat` is on. */
export const chatToReopen = (prefs: Readonly<UIPrefs>, profile: string): string | undefined =>
  prefs.reopenLastChat ? prefs.lastOpenChat[profile] : undefined;
