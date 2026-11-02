// Settings, the Appearance tab: the color scheme, themes, contrast and chat width (ThemePicker.tsx), then the interface
// and code fonts and sizes, and Word wrap, each with a preview of what it changes. Changes apply at once and are kept
// on this computer only (appearance.ts). Last, whether the status bar shows (StatusBar.tsx), so a bar hidden from its
// own menu can come back.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { DEFAULT_APPEARANCE, MONO_SIZES, UI_SIZES, type Appearance, type AppearanceStore, type Fonts } from "./appearance";
import { Markdown } from "./Markdown";
import { StatusBarSetting } from "./StatusBar";
import { ThemeSettings } from "./ThemePicker";

const UI_SAMPLE = "Chats that need attention sit at the top; settled ones wait below. Press Ctrl+K to search every chat.";
const CODE_SAMPLE = [
  "```ts",
  "// 0O 1lI: one long line shows what Word wrap does.",
  "export function describe(chat: Chat): string {",
  "  return `${chat.title}: ${chat.items.length} messages, last updated ${new Date(chat.updatedAt).toLocaleString()}`;",
  "}",
  "```",
].join("\n");

/** The font picker: the app's default first, then the installed families. A saved font no longer installed stays listed. */
function FontSelect({ label, value, groups, onChange }: { label: string; value: string; groups: [string, string[]][]; onChange: (f: string) => void }) {
  const listed = groups.some(([, fonts]) => fonts.includes(value));
  return (
    <select className="select font-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Default</option>
      {value && !listed && <option value={value}>{value}</option>}
      {groups.map(([name, fonts]) =>
        fonts.length ? (
          <optgroup key={name} label={name}>
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}

function SizeSelect({ label, value, sizes, onChange }: { label: string; value: number; sizes: number[]; onChange: (n: number) => void }) {
  return (
    <select className="select size-select" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {sizes.map((n) => (
        <option key={n} value={n}>
          {n} px
        </option>
      ))}
    </select>
  );
}

/** One font setting: its name, what it covers, the pickers, and a reset once it differs from the default. */
function FontRow({
  title,
  hint,
  changed,
  onReset,
  children,
}: {
  title: string;
  hint: string;
  changed: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="appearance-row">
      <div className="appearance-label">
        <div className="appearance-title">
          {title}
          {changed && (
            <button className="icon-btn small-icon" aria-label={`Reset ${title.toLowerCase()}`} title="Back to the default" onClick={onReset}>
              <RotateCcw size={13} />
            </button>
          )}
        </div>
        <div className="muted small">{hint}</div>
      </div>
      <div className="appearance-pickers">{children}</div>
    </div>
  );
}

export function AppearanceSettings({ store, listFonts }: { store: AppearanceStore; listFonts: () => Promise<Fonts> }) {
  const a = useSyncExternalStore(store.subscribe, store.get);
  const [fonts, setFonts] = useState<Fonts>({ all: [], mono: [] });
  useEffect(() => {
    let live = true;
    void listFonts().then((f) => live && setFonts(f));
    return () => void (live = false);
  }, [listFonts]);

  const set = (change: Partial<Appearance>) => store.set(change);
  const d = DEFAULT_APPEARANCE;
  const otherFonts = fonts.all.filter((f) => !fonts.mono.includes(f));

  return (
    <>
      <ThemeSettings store={store} />
      <section>
        <h2>Fonts</h2>

        <FontRow
          title="Interface font"
          hint="Everything outside code blocks and tool output."
          changed={a.uiFont !== d.uiFont || a.uiSize !== d.uiSize}
          onReset={() => set({ uiFont: d.uiFont, uiSize: d.uiSize })}
        >
          <FontSelect label="Interface font" value={a.uiFont} groups={[["Installed fonts", fonts.all]]} onChange={(uiFont) => set({ uiFont })} />
          <SizeSelect label="Interface font size" value={a.uiSize} sizes={UI_SIZES} onChange={(uiSize) => set({ uiSize })} />
        </FontRow>
        <div className="appearance-preview ui-preview">{UI_SAMPLE}</div>

        <FontRow
          title="Code font"
          hint="Code blocks, tool output, and commands waiting for approval."
          changed={a.monoFont !== d.monoFont || a.monoSize !== d.monoSize}
          onReset={() => set({ monoFont: d.monoFont, monoSize: d.monoSize })}
        >
          <FontSelect
            label="Code font"
            value={a.monoFont}
            groups={[
              ["Monospace", fonts.mono],
              ["Other fonts", otherFonts],
            ]}
            onChange={(monoFont) => set({ monoFont })}
          />
          <SizeSelect label="Code font size" value={a.monoSize} sizes={MONO_SIZES} onChange={(monoSize) => set({ monoSize })} />
        </FontRow>
        <div className="appearance-preview code-preview">
          <Markdown text={CODE_SAMPLE} />
        </div>

        <div className="appearance-row">
          <div className="appearance-label">
            <div className="appearance-title" id="word-wrap-label">
              Word wrap
            </div>
            <div className="muted small">Wrap long lines in code blocks instead of scrolling sideways.</div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={a.wordWrap}
            aria-labelledby="word-wrap-label"
            onClick={() => set({ wordWrap: !a.wordWrap })}
          >
            <span className="switch-knob" />
          </button>
        </div>
        <StatusBarSetting />
      </section>
    </>
  );
}
