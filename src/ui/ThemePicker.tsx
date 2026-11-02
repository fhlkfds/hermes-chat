// Settings, Appearance: the color scheme, the themes (built-in and the owner's own), contrast, and chat width. A theme
// is four colors per mode (themes.ts); the editor shows a small copy of the app in both modes as the colors change.
import { useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Check, Copy, Moon, Paintbrush, Pencil, Plus, RotateCcw, Sun, Trash2 } from "lucide-react";
import { CHAT_WIDTHS, DEFAULT_APPEARANCE, MAX_CUSTOM_THEMES, themeOf, type Appearance, type AppearanceStore } from "./appearance";
import { arrowSelect } from "./bits";
import {
  BUILTIN_THEMES,
  PALETTE_KEYS,
  PALETTE_LABELS,
  MAX_THEME_NAME,
  freeName,
  isHex,
  mix,
  newThemeId,
  readThemeJson,
  themeJson,
  themeVars,
  type Mode,
  type Palette,
  type Scheme,
  type Theme,
} from "./themes";

/** A small drawing of the app in one palette: the list panel, a reply, a message, the composer with its send dot. */
export function MiniApp({ palette, mode, contrast, className = "" }: { palette: Palette; mode: Mode; contrast: number; className?: string }) {
  return (
    <div className={`mini ${className}`} style={themeVars(palette, mode, contrast) as CSSProperties} aria-hidden>
      <div className="mini-side">
        <span className="mini-pill" />
        <span className="mini-row on" />
        <span className="mini-row" />
        <span className="mini-row" />
      </div>
      <div className="mini-main">
        <span className="mini-bubble" />
        <span className="mini-line" />
        <span className="mini-line short" />
        <div className="mini-composer">
          <span className="mini-line short" />
          <span className="mini-send" />
        </div>
      </div>
    </div>
  );
}

/** The light and dark versions of a theme as two lit spheres. */
const orb = (p: Palette, mode: Mode): CSSProperties => ({
  background: `radial-gradient(circle at 32% 28%, ${mix(p.accent, mode === "light" ? "#ffffff" : p.text, 0.75)} 0%, ${p.accent} 42%, ${mix(p.accent, p.background, 0.75)} 78%, ${p.background} 100%)`,
});

const SCHEMES: { id: Scheme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function SchemePicker({ a, set }: { a: Appearance; set: (c: Partial<Appearance>) => void }) {
  const theme = themeOf(a);
  return (
    <div
      className="scheme-grid"
      role="radiogroup"
      aria-label="Color scheme"
      onKeyDown={(e) => arrowSelect(e, SCHEMES.map((s) => s.id), a.scheme, (scheme) => set({ scheme }))}
    >
      {SCHEMES.map(({ id, label }) => (
        <button
          key={id}
          className={`scheme-card ${a.scheme === id ? "on" : ""}`}
          role="radio"
          aria-checked={a.scheme === id}
          tabIndex={a.scheme === id ? 0 : -1}
          onClick={() => set({ scheme: id })}
        >
          {id === "system" ? (
            <div className="mini-split">
              <MiniApp palette={theme.light} mode="light" contrast={a.contrast} />
              <MiniApp palette={theme.dark} mode="dark" contrast={a.contrast} className="mini-right" />
            </div>
          ) : (
            <MiniApp palette={theme[id]} mode={id} contrast={a.contrast} />
          )}
          <span className="scheme-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A theme being made or changed. `id` is the custom theme it replaces; a new one has none. `session` tells one opening
 * of the editor from the next, so starting another draft starts afresh.
 */
type Draft = { id?: string; session: number; name: string; light: Palette; dark: Palette };

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  const typed = (t: string) => {
    setText(t);
    const hex = t.startsWith("#") ? t : `#${t}`;
    if (isHex(hex)) onChange(hex.toLowerCase());
  };
  return (
    <label className="color-field">
      <span className="color-name">{label}</span>
      <input type="color" value={value} aria-label={`${label} color`} onChange={(e) => onChange(e.target.value)} />
      <input
        className="color-hex mono"
        value={text}
        aria-label={`${label} hex`}
        spellCheck={false}
        maxLength={7}
        aria-invalid={!isHex(text.startsWith("#") ? text : `#${text}`)}
        onChange={(e) => typed(e.target.value.trim())}
        onBlur={() => setText(value)}
      />
    </label>
  );
}

function ThemeEditor({
  draft: initial,
  contrast,
  taken,
  onSave,
  onCancel,
}: {
  draft: Draft;
  contrast: number;
  /** Names other themes have. */
  taken: string[];
  onSave: (t: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [copied, setCopied] = useState(false);
  const name = draft.name.trim();
  const clash = taken.includes(name);
  const color = (mode: Mode, key: keyof Palette, hex: string) => setDraft((d) => ({ ...d, [mode]: { ...d[mode], [key]: hex } }));
  return (
    <div className="theme-editor" role="group" aria-label={initial.id ? `Edit ${initial.name}` : "New theme"}>
      <div className="theme-editor-head">
        <input
          className="theme-name"
          aria-label="Theme name"
          placeholder="Theme name"
          value={draft.name}
          maxLength={MAX_THEME_NAME}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <button
          className="btn"
          title="Copy this theme as JSON, to keep or share"
          onClick={() => {
            void navigator.clipboard?.writeText(themeJson({ id: "", ...draft, name: name || "Untitled" }));
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <div className="theme-editor-modes">
        {(["light", "dark"] as const).map((mode) => (
          <div key={mode} className="theme-editor-mode">
            <div className="theme-editor-title">
              {mode === "light" ? <Sun size={13} /> : <Moon size={13} />} {mode === "light" ? "Light" : "Dark"}
            </div>
            <MiniApp palette={draft[mode]} mode={mode} contrast={contrast} className="mini-large" />
            <div className="color-fields">
              {PALETTE_KEYS.map((key) => (
                <ColorField key={key} label={PALETTE_LABELS[key]} value={draft[mode][key]} onChange={(hex) => color(mode, key, hex)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small theme-editor-hint">
        Surface is for the composer, menus and cards. Borders, muted text, code blocks and the list panel are worked out from these four.
      </p>
      <div className="theme-editor-actions">
        {clash && <span className="small sign-in-error">Another theme is already called that.</span>}
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name || clash} onClick={() => onSave({ ...draft, name })}>
          {initial.id ? "Save theme" : "Create theme"}
        </button>
      </div>
    </div>
  );
}

function ImportTheme({ onImport, onCancel }: { onImport: (t: Theme) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  return (
    <div className="theme-editor" role="group" aria-label="Add a theme">
      <div className="theme-editor-title">Paste a theme's JSON, as Copy JSON gives it</div>
      <textarea
        className="theme-json mono"
        aria-label="Theme JSON"
        rows={8}
        spellCheck={false}
        autoFocus
        value={text}
        placeholder={'{\n  "name": "…",\n  "light": { "background": "#ffffff", "surface": "#ffffff", "text": "#111111", "accent": "#3366ff" },\n  "dark": { … }\n}'}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
      />
      <div className="theme-editor-actions">
        {error && (
          <span className="small sign-in-error" role="alert">
            {error}
          </span>
        )}
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => {
            const read = readThemeJson(text, newThemeId);
            if (typeof read === "string") setError(read);
            else onImport(read);
          }}
        >
          Add theme
        </button>
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  selected,
  mode,
  custom,
  canDuplicate,
  onPick,
  onDuplicate,
  onEdit,
  onDelete,
}: {
  theme: Theme;
  selected: boolean;
  /** The mode showing, ringed on the selected theme. */
  mode: Mode;
  custom: boolean;
  /** False once the owner has as many themes as are kept. */
  canDuplicate: boolean;
  onPick: (mode?: Mode) => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`theme-card ${selected ? "on" : ""}`}>
      <button className="theme-pick" aria-pressed={selected} aria-label={`Use ${theme.name}`} onClick={() => onPick()} />
      <div className="theme-orbs">
        {(["light", "dark"] as const).map((m) => (
          <button
            key={m}
            className={`theme-orb ${selected && mode === m ? "on" : ""}`}
            style={orb(theme[m], m)}
            aria-label={`Use ${theme.name}, ${m}`}
            title={`${theme.name}, ${m}`}
            onClick={() => onPick(m)}
          >
            {selected && mode === m && <span className="theme-orb-mode">{m === "light" ? <Sun size={11} /> : <Moon size={11} />}</span>}
          </button>
        ))}
      </div>
      <div className="theme-foot">
        {confirming ? (
          <>
            <span className="theme-name-label small">Delete {theme.name}?</span>
            <button className="row-confirm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="row-confirm danger" onClick={onDelete}>
              Delete
            </button>
          </>
        ) : (
          <>
            <span className="theme-name-label">{theme.name}</span>
            {custom && (
              <>
                <button className="icon-btn small-icon" aria-label={`Edit ${theme.name}`} title="Edit" onClick={onEdit}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn small-icon" aria-label={`Delete ${theme.name}`} title="Delete" onClick={() => setConfirming(true)}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <button
              className="icon-btn small-icon"
              aria-label={`Duplicate ${theme.name}`}
              title={canDuplicate ? "Duplicate and edit" : `You have ${MAX_CUSTOM_THEMES} themes of your own`}
              disabled={!canDuplicate}
              onClick={onDuplicate}
            >
              <Copy size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Themes({ a, mode, set }: { a: Appearance; mode: Mode; set: (c: Partial<Appearance>) => void }) {
  const [editing, setEditing] = useState<Draft | "import">();
  const sessions = useRef(0);
  const all = [...BUILTIN_THEMES, ...a.customThemes];
  const names = (except?: string) => all.filter((t) => t.id !== except).map((t) => t.name);
  // Past the limit, loading drops the extra themes, so none is offered.
  const full = a.customThemes.length >= MAX_CUSTOM_THEMES;
  const fullNote = full ? `You have ${MAX_CUSTOM_THEMES} themes of your own. Delete one to add another.` : undefined;
  const edit = (d: Omit<Draft, "session">) => setEditing({ ...d, session: ++sessions.current });
  const startFrom = (t: Theme, name: string) => edit({ name: freeName(name, names()), light: { ...t.light }, dark: { ...t.dark } });

  const save = (d: Omit<Draft, "session">) => {
    // A theme deleted while it was being edited comes back as a new one.
    const replaces = d.id && a.customThemes.some((t) => t.id === d.id) ? d.id : undefined;
    if (!replaces && full) return;
    const theme: Theme = { id: replaces ?? newThemeId(), name: d.name, light: d.light, dark: d.dark };
    const customThemes = replaces ? a.customThemes.map((t) => (t.id === replaces ? theme : t)) : [...a.customThemes, theme];
    set({ customThemes, themeId: theme.id });
    setEditing(undefined);
  };
  const pick = (t: Theme, m?: Mode) => set(m ? { themeId: t.id, scheme: m } : { themeId: t.id });

  return (
    <>
      <div className="appearance-head">
        <h3>Themes</h3>
        <div className="appearance-pickers">
          <button className="btn" disabled={full} title={fullNote} onClick={() => startFrom(themeOf(a), "My theme")}>
            <Paintbrush size={14} /> Create theme
          </button>
          <button className="btn" disabled={full} title={fullNote} onClick={() => setEditing("import")}>
            <Plus size={14} /> Add theme
          </button>
        </div>
      </div>
      {editing === "import" ? (
        <ImportTheme
          onCancel={() => setEditing(undefined)}
          onImport={(t) => save({ name: freeName(t.name, names()), light: t.light, dark: t.dark })}
        />
      ) : editing ? (
        <ThemeEditor
          key={editing.session}
          draft={editing}
          contrast={a.contrast}
          taken={names(editing.id)}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      <div className="theme-grid">
        {all.map((t) => {
          const custom = !BUILTIN_THEMES.includes(t);
          return (
            <ThemeCard
              key={t.id}
              theme={t}
              selected={t.id === a.themeId}
              mode={mode}
              custom={custom}
              onPick={(m) => pick(t, m)}
              canDuplicate={!full}
              onDuplicate={() => startFrom(t, `${t.name} copy`)}
              onEdit={() => edit({ id: t.id, name: t.name, light: { ...t.light }, dark: { ...t.dark } })}
              onDelete={() => {
                if (editing !== "import" && editing?.id === t.id) setEditing(undefined);
                set({
                  customThemes: a.customThemes.filter((o) => o.id !== t.id),
                  ...(a.themeId === t.id ? { themeId: DEFAULT_APPEARANCE.themeId } : {}),
                });
              }}
            />
          );
        })}
      </div>
    </>
  );
}

/** A labeled slider over a list of stops, with a reset once it's off the default. */
function SliderRow({
  title,
  hint,
  value,
  min,
  max,
  step = 1,
  label,
  low,
  high,
  isDefault,
  onChange,
  onReset,
}: {
  title: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  low: string;
  high: string;
  isDefault: boolean;
  onChange: (n: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="appearance-row slider-row">
      <div className="appearance-label">
        <div className="appearance-title">
          {title}
          {!isDefault && (
            <button className="icon-btn small-icon" aria-label={`Reset ${title.toLowerCase()}`} title="Back to the default" onClick={onReset}>
              <RotateCcw size={13} />
            </button>
          )}
        </div>
        <div className="muted small">{hint}</div>
      </div>
      <div className="slider">
        <input
          type="range"
          aria-label={title}
          aria-valuetext={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className="slider-scale small">
          <span>{low}</span>
          <span className="slider-value">{label}</span>
          <span>{high}</span>
        </div>
      </div>
    </div>
  );
}

const widthLabel = (w: number) => (w ? `${w} px` : "Full width");

export function ThemeSettings({ store }: { store: AppearanceStore }) {
  const a = useSyncExternalStore(store.subscribe, store.get);
  const mode = useSyncExternalStore(store.subscribe, store.mode);
  const set = (change: Partial<Appearance>) => store.set(change);
  const d = DEFAULT_APPEARANCE;
  const widthAt = Math.max(0, CHAT_WIDTHS.indexOf(a.chatWidth));
  return (
    <>
      <section>
        <h2>Color scheme</h2>
        <p className="muted">System follows your desktop's light or dark setting.</p>
        <SchemePicker a={a} set={set} />
      </section>
      <section>
        <Themes a={a} mode={mode} set={set} />
      </section>
      <section>
        <h2>Layout and contrast</h2>
        <SliderRow
          title="Contrast"
          hint="How far text, borders and panels stand out from the background."
          value={a.contrast}
          min={0}
          max={100}
          step={5}
          label={a.contrast === d.contrast ? "Default" : `${a.contrast > d.contrast ? "+" : ""}${a.contrast - d.contrast}`}
          low="Softer"
          high="Sharper"
          isDefault={a.contrast === d.contrast}
          onChange={(contrast) => set({ contrast })}
          onReset={() => set({ contrast: d.contrast })}
        />
        <SliderRow
          title="Chat width"
          hint="How wide messages and the composer grow in a wide window."
          value={widthAt}
          min={0}
          max={CHAT_WIDTHS.length - 1}
          label={widthLabel(a.chatWidth)}
          low="Narrow"
          high="Full"
          isDefault={a.chatWidth === d.chatWidth}
          onChange={(i) => set({ chatWidth: CHAT_WIDTHS[i] })}
          onReset={() => set({ chatWidth: d.chatWidth })}
        />
      </section>
    </>
  );
}
