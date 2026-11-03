// The status bar along the bottom of the chat pane: how full the chat's context window is, its YOLO switch, its model,
// and the connection. Right-click picks what it shows, or hides it; Settings, Appearance shows it again. The choice is
// kept in the display preferences (uiPrefs.ts `statusBar`). Nothing is shown that Hermes didn't report.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Zap } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import { ContextInspector, type ContextApi } from "./ContextInspector";
import { STATUS_BAR_ITEMS, getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { Menu } from "./ChatMenu";
import { STATUS_LABEL, useReturnFocus } from "./bits";

type StatusItem = (typeof STATUS_BAR_ITEMS)[number];
const LABEL: Record<StatusItem, string> = { context: "Context", yolo: "YOLO", model: "Model", status: "Connection" };

/** The items the bar shows, in its order; ids a newer or older app kept that this one doesn't know are skipped. */
const useShown = (): StatusItem[] => {
  const kept = useSyncExternalStore(subscribe, getUIPrefs).statusBar;
  return STATUS_BAR_ITEMS.filter((i) => kept.includes(i));
};
const show = (items: StatusItem[]) => setUIPrefs({ statusBar: items });

/** The Settings switch that shows the bar again with every item, or hides it. */
export function StatusBarSetting() {
  const shown = useShown().length > 0;
  return (
    <div className="appearance-row">
      <div className="appearance-label">
        <div className="appearance-title" id="status-bar-label">
          Status bar
        </div>
        <div className="muted small">Context, YOLO, model and connection under the chat. Right-click it to pick what it shows.</div>
      </div>
      <button className="switch" role="switch" aria-checked={shown} aria-labelledby="status-bar-label" onClick={() => show(shown ? [] : [...STATUS_BAR_ITEMS])}>
        <span className="switch-knob" />
      </button>
    </div>
  );
}

const n = (tokens: number) => tokens.toLocaleString();

/** A small panel above the bar. Escape or a click outside closes it, and focus goes back. */
function Popover({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
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
      className={`status-popover${wide ? " wide" : ""}`}
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

/**
 * How full the context window is, as Hermes last measured it. Clicking opens the context inspector: what fills it, the
 * compactions Hermes stored, and Compact now where Hermes can (ContextInspector.tsx).
 */
function ContextMeter({ chat, status, api }: { chat: Chat; status: ConnectionStatus; api: ContextApi }) {
  const [open, setOpen] = useState(false);
  const { used, max, percent, estimated } = chat.live!.context!;
  const level = percent >= 90 ? "full" : percent >= 70 ? "high" : "";
  return (
    <span className="status-anchor">
      <button
        className={`status-item status-meter ${level}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Context: ${n(used)} of ${n(max)} tokens${estimated ? " (partly estimated)" : ""}. Click to see what fills it.`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="meter" aria-hidden>
          <span style={{ width: `${percent}%` }} />
        </span>
        {percent}% full
      </button>
      {open && (
        <Popover label="Context window" onClose={() => setOpen(false)} wide>
          <ContextInspector chat={chat} status={status} api={api} />
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
  onYolo,
  context,
}: {
  chat: Chat;
  status: ConnectionStatus;
  onYolo: (on: boolean) => Promise<void>;
  context: ContextApi;
}) {
  const items = useShown();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Nothing to show is the same as hidden: unticking the last item hides the bar.
  if (!items.length) return null;
  const has = (i: StatusItem) => items.includes(i);
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
      {/* Keyed by the chat's session: a new one starts the inspector afresh, and an answer for the old one is dropped. */}
      {has("context") && live?.context && <ContextMeter key={`${chat.id}/${chat.runtimeId}`} chat={chat} status={status} api={context} />}
      {has("yolo") && <YoloToggle chat={chat} status={status} onYolo={onYolo} />}
      <span className="status-gap" />
      {has("model") && chat.model && (
        <span className="status-item" title="The model this chat uses">
          {chat.model.model}
        </span>
      )}
      {has("status") && (
        <span className={`status-item status-conn ${status}`}>
          <span className="conn-dot" aria-hidden />
          {STATUS_LABEL[status]}
        </span>
      )}
      {menu && (
        <Menu label="Show in status bar" x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {STATUS_BAR_ITEMS.map((id) => (
            <button
              key={id}
              role="menuitemcheckbox"
              aria-checked={has(id)}
              className="menu-item"
              onClick={() => show(has(id) ? items.filter((i) => i !== id) : STATUS_BAR_ITEMS.filter((i) => i === id || has(i)))}
            >
              <span className="menu-icon">{has(id) && <Check size={14} />}</span>
              <span className="menu-label">{LABEL[id]}</span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(null);
              show([]);
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
