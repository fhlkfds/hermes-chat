// The status bar along the bottom of the chat pane: how full the chat's context window is, its YOLO switch, its model,
// and the connection. Right-click picks what it shows, or hides it; Settings, Appearance shows it again. The choice is
// kept on this computer (ui-prefs `statusBar`). Nothing is shown that Hermes didn't report.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Zap } from "lucide-react";
import type { Chat, ConnectionStatus, ContextPart } from "../hermes/model";
import { Menu } from "./ChatMenu";
import { STATUS_LABEL, useReturnFocus } from "./bits";

export const STATUS_ITEMS = [
  ["context", "Context"],
  ["yolo", "YOLO"],
  ["model", "Model"],
  ["status", "Connection"],
] as const;
export type StatusItem = (typeof STATUS_ITEMS)[number][0];
export type StatusBarPrefs = { shown: boolean; items: StatusItem[] };

const KEY = "hermes-chat.ui-prefs";
const ALL = STATUS_ITEMS.map(([id]) => id);
export const DEFAULT_STATUS_BAR: StatusBarPrefs = { shown: true, items: ALL };

type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

const readPrefs = (storage: PrefsStorage): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** What `storage` keeps for the status bar, with anything missing or unknown back at its default. */
export function loadStatusBar(storage: PrefsStorage): StatusBarPrefs {
  const kept = readPrefs(storage).statusBar as Partial<Record<keyof StatusBarPrefs, unknown>> | undefined;
  return {
    shown: typeof kept?.shown === "boolean" ? kept.shown : true,
    items: Array.isArray(kept?.items) ? ALL.filter((i) => (kept.items as unknown[]).includes(i)) : ALL,
  };
}

export type StatusBarStore = { get(): StatusBarPrefs; set(change: Partial<StatusBarPrefs>): void; subscribe(fn: () => void): () => void };

/** The status bar's choices kept in `storage`, beside any other ui-prefs. */
export function statusBarStore(storage: PrefsStorage): StatusBarStore {
  let current = loadStatusBar(storage);
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(change) {
      current = { ...current, ...change };
      try {
        storage.setItem(KEY, JSON.stringify({ ...readPrefs(storage), statusBar: current }));
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

const n = (tokens: number) => tokens.toLocaleString();

/** A small panel above the bar. Escape or a click outside closes it, and focus goes back. */
function Popover({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useReturnFocus();
  useEffect(() => {
    // Inside, so Escape reaches it; a button with autoFocus already has it.
    if (!box.current?.contains(document.activeElement)) box.current?.focus();
    const away = (e: Event) => box.current?.parentElement?.contains(e.target as Node) || onClose();
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);
  return (
    <div
      ref={box}
      className="status-popover"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

/** How full the context window is; clicking shows the numbers, and the breakdown by category if Hermes gives one. */
function ContextMeter({ context, onBreakdown }: { context: NonNullable<NonNullable<Chat["live"]>["context"]>; onBreakdown: () => Promise<ContextPart[]> }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<ContextPart[] | "loading" | { error: string }>("loading");
  useEffect(() => {
    if (!open) return;
    let live = true;
    setParts("loading");
    onBreakdown().then(
      (p) => live && setParts(p),
      (e: unknown) => live && setParts({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => void (live = false);
  }, [open]);
  const { used, max, percent, estimated } = context;
  const level = percent >= 90 ? "full" : percent >= 70 ? "high" : "";
  return (
    <span className="status-anchor">
      <button
        className={`status-item status-meter ${level}`}
        aria-expanded={open}
        title={`Context: ${n(used)} of ${n(max)} tokens${estimated ? " (partly estimated)" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="meter" aria-hidden>
          <span style={{ width: `${percent}%` }} />
        </span>
        {percent}% full
      </button>
      {open && (
        <Popover label="Context window" onClose={() => setOpen(false)}>
          <div className="popover-title">Context window</div>
          <div className="popover-sum">
            {n(used)} of {n(max)} tokens · {percent}%{estimated && <span className="muted"> · partly estimated</span>}
          </div>
          {parts === "loading" ? (
            <div className="muted small">Asking Hermes for the breakdown…</div>
          ) : "error" in parts ? (
            <div className="muted small">Couldn't get the breakdown: {parts.error}</div>
          ) : !parts.length ? (
            <div className="muted small">Hermes gave no breakdown for this chat.</div>
          ) : (
            <ul className="context-parts" aria-label="Breakdown by category">
              {parts.map((p) => (
                <li key={p.id}>
                  <span className="swatch" style={p.color ? { background: p.color } : undefined} aria-hidden />
                  <span className="part-label">{p.label}</span>
                  <span className="part-tokens">{n(p.tokens)}</span>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      )}
    </span>
  );
}

/** Why the YOLO switch can't be used for this chat, or nothing when it can. */
function yoloBlocked(chat: Chat, status: ConnectionStatus): string | undefined {
  if (status !== "connected") return "Connect to Hermes to change YOLO for this chat.";
  if (!chat.runtimeId) return "YOLO can be changed once this chat has started.";
  if (chat.live?.yolo === undefined) return "Hermes hasn't reported YOLO for this chat yet, so it can't be changed from here.";
  if (chat.live.yoloEverywhere) return "YOLO is on for every chat by Hermes's own settings or launch options, so it can't be turned off here.";
}

/**
 * This chat's YOLO switch. Turning it on asks first, since Hermes then runs dangerous commands without asking. Until
 * Hermes reports the state it reads "unknown", never "off": YOLO may well be on.
 */
function YoloToggle({ chat, status, onYolo }: { chat: Chat; status: ConnectionStatus; onYolo: (on: boolean) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const known = chat.live?.yolo !== undefined;
  const on = !!chat.live?.yolo;
  const blocked = yoloBlocked(chat, status);
  const set = (next: boolean) => {
    setConfirming(false);
    setBusy(true);
    setError(undefined);
    onYolo(next)
      .catch((e: unknown) => setError(`Couldn't change YOLO: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false));
  };
  const title =
    error ??
    blocked ??
    (on ? "YOLO is on: Hermes runs dangerous commands in this chat without asking. Click to turn it off." : "YOLO is off: Hermes asks before running dangerous commands in this chat.");
  return (
    <span className="status-anchor">
      <button
        className={`status-item status-yolo${on ? " on" : ""}${error ? " failed" : ""}`}
        role={known ? "switch" : undefined}
        aria-checked={known ? on : undefined}
        aria-label={known ? "YOLO for this chat" : "YOLO for this chat: unknown"}
        aria-description={title}
        title={title}
        disabled={!!blocked || busy}
        onClick={() => (on ? set(false) : setConfirming(true))}
      >
        <Zap size={12} />
        YOLO {!known ? "unknown" : on ? "on" : "off"}
      </button>
      {confirming && (
        <Popover label="Turn on YOLO" onClose={() => setConfirming(false)}>
          <div className="popover-title">Turn on YOLO for this chat?</div>
          <p className="muted small">Hermes will run every command in this chat without asking, dangerous ones too. Other chats still ask.</p>
          <div className="confirm-actions">
            {/* Cancel takes focus, so a stray Enter doesn't turn it on. */}
            <button className="btn" autoFocus onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => set(true)}>
              Turn on
            </button>
          </div>
        </Popover>
      )}
    </span>
  );
}

/** The bar for the chat on screen. Right-click opens the menu of what it shows. */
export function StatusBar({
  chat,
  status,
  prefs,
  onYolo,
  onBreakdown,
}: {
  chat: Chat;
  status: ConnectionStatus;
  prefs: StatusBarStore;
  onYolo: (on: boolean) => Promise<void>;
  onBreakdown: () => Promise<ContextPart[]>;
}) {
  const { shown, items } = useSyncExternalStore(prefs.subscribe, prefs.get);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!shown) return null;
  const show = (i: StatusItem) => items.includes(i);
  const live = chat.live;
  return (
    <footer
      className="status-bar"
      aria-label="Status bar"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {show("context") && live?.context && <ContextMeter context={live.context} onBreakdown={onBreakdown} />}
      {show("yolo") && <YoloToggle chat={chat} status={status} onYolo={onYolo} />}
      <span className="status-gap" />
      {show("model") && live?.model && (
        <span className="status-item" title="The model this chat uses">
          {live.model}
        </span>
      )}
      {show("status") && (
        <span className={`status-item status-conn ${status}`}>
          <span className="conn-dot" aria-hidden />
          {STATUS_LABEL[status]}
        </span>
      )}
      {menu && (
        <Menu label="Show in status bar" x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {STATUS_ITEMS.map(([id, label]) => (
            <button
              key={id}
              role="menuitemcheckbox"
              aria-checked={show(id)}
              className="menu-item"
              onClick={() => prefs.set({ items: show(id) ? items.filter((i) => i !== id) : ALL.filter((i) => i === id || items.includes(i)) })}
            >
              <span className="menu-icon">{show(id) && <Check size={14} />}</span>
              <span className="menu-label">{label}</span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(null);
              prefs.set({ shown: false });
            }}
          >
            <span className="menu-icon" />
            <span className="menu-label">Hide bar</span>
          </button>
        </Menu>
      )}
    </footer>
  );
}
