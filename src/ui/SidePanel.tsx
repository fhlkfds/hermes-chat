// The side panel beside the chat (ADR 0033): Preview, Terminal, Files and Screen, one shown at a time. Each tab is made
// the first time it is opened and kept from then on, so a shell or the screen keeps running while the owner is in
// another tab, or the panel is hidden or closed. The panel is resizable from its left edge, and in a window too narrow
// for both it covers the chat until the owner goes back.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeft, Eye, FolderOpen, Monitor, SquareTerminal, X } from "lucide-react";

export type PanelTab = "preview" | "terminal" | "files" | "screen";

/** The narrowest the panel gets, and the step the arrow keys resize it by. */
export const PANE_MIN_WIDTH = 300;
const KEY_STEP = 32;

const TABS: { tab: PanelTab; label: string; title: string; icon: ReactNode }[] = [
  { tab: "preview", label: "Preview", title: "Pages, files and tool output", icon: <Eye size={14} /> },
  { tab: "terminal", label: "Terminal", title: "A shell on the Hermes server or on this computer", icon: <SquareTerminal size={14} /> },
  { tab: "files", label: "Files", title: "The files on the Hermes server", icon: <FolderOpen size={14} /> },
  { tab: "screen", label: "Screen", title: "Hermes's screen, where its computer use and browser run", icon: <Monitor size={14} /> },
];

export function SidePanel({
  tab,
  onTab,
  shown,
  overlay,
  width,
  maxWidth,
  onResize,
  onHide,
  onClose,
  running = {},
  tabs,
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  /** False while the panel is closed or hidden: what runs in it keeps running. */
  shown: boolean;
  /** The window is too narrow for the panel beside the chat, so it covers the chat until `onHide`. */
  overlay: boolean;
  width: number;
  maxWidth: number;
  /** The owner is dragging the panel's edge; `done` once they let go. */
  onResize: (width: number, done: boolean) => void;
  onHide: () => void;
  onClose: () => void;
  /** Tabs with something running in them, marked with a dot. */
  running?: Partial<Record<PanelTab, boolean>>;
  /** Each tab's content. `shown`: whether it is the tab on screen. */
  tabs: Record<PanelTab, (shown: boolean) => ReactNode>;
}) {
  const [made, setMade] = useState<PanelTab[]>([tab]);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!made.includes(tab)) setMade((m) => [...m, tab]);
  }, [tab, made]);
  // Opened or shown again, the panel takes focus, so Escape and the keys reach it, unless something in it (a terminal,
  // say) took it first. Covering the chat makes it inert, focus included, so focus moves in then too.
  useEffect(() => {
    if (shown && !root.current?.contains(document.activeElement)) root.current?.focus();
  }, [overlay, shown, tab]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (overlay) onHide();
    else onClose();
  };

  return (
    <aside
      ref={root}
      tabIndex={-1}
      hidden={!shown}
      className={`preview side-panel ${overlay ? "overlay" : ""} ${dragging ? "dragging" : ""}`}
      style={overlay ? undefined : { width }}
      aria-label="Side panel"
      onKeyDown={onKey}
    >
      {!overlay && <ResizeHandle width={width} maxWidth={maxWidth} onResize={onResize} onDragging={setDragging} />}
      <div className="panel-tabs">
        {overlay && (
          <button className="icon-btn" title="Back to the chat" onClick={onHide}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div role="tablist" aria-label="Side panel" className="panel-tablist">
          {TABS.map((t) => (
            <button
              key={t.tab}
              role="tab"
              id={`panel-tab-${t.tab}`}
              aria-selected={tab === t.tab}
              aria-controls={`panel-${t.tab}`}
              className="panel-tab"
              title={t.title}
              onClick={() => onTab(t.tab)}
            >
              {t.icon}
              <span className="panel-tab-label">{t.label}</span>
              {running[t.tab] && <span className="dot run-dot" aria-label="(running)" />}
            </button>
          ))}
        </div>
        <button className="icon-btn panel-close" title="Close the side panel" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {TABS.filter((t) => made.includes(t.tab)).map((t) => (
        <div key={t.tab} role="tabpanel" id={`panel-${t.tab}`} aria-labelledby={`panel-tab-${t.tab}`} className={`panel-body panel-${t.tab}`} hidden={tab !== t.tab}>
          {tabs[t.tab](shown && tab === t.tab)}
        </div>
      ))}
    </aside>
  );
}

/** The panel's left edge: drag it, or focus it and use the arrow keys, to make the panel wider or narrower. */
function ResizeHandle({
  width,
  maxWidth,
  onResize,
  onDragging,
}: {
  width: number;
  maxWidth: number;
  onResize: (width: number, done: boolean) => void;
  onDragging: (on: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, PANE_MIN_WIDTH), Math.max(PANE_MIN_WIDTH, maxWidth)));
  const move = (e: ReactPointerEvent, done: boolean) => {
    if (!start.current) return;
    // The panel is on the right, so dragging its edge left makes it wider.
    onResize(clamp(start.current.width + start.current.x - e.clientX), done);
    if (done) {
      start.current = null;
      onDragging(false);
    }
  };
  return (
    <div
      className="preview-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={Math.max(PANE_MIN_WIDTH, maxWidth)}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width };
        onDragging(true);
      }}
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => move(e, true)}
      onPointerCancel={(e) => move(e, true)}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowLeft"
            ? width + KEY_STEP
            : e.key === "ArrowRight"
              ? width - KEY_STEP
              : e.key === "Home"
                ? maxWidth
                : e.key === "End"
                  ? PANE_MIN_WIDTH
                  : undefined;
        if (next === undefined) return;
        e.preventDefault();
        onResize(clamp(next), true);
      }}
    />
  );
}
