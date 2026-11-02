// The menu a chat row opens on right-click, and the dialog that picks a custom snooze time. Arrow keys move through
// the menu, Right opens Snooze's times, and Escape or a click elsewhere closes it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  FolderOpen,
  MessageSquare,
  MessageSquareDot,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Chat } from "../hermes/model";
import { wakeLabel } from "./bits";

/** What the owner can do to a chat from its row. `until` absent wakes a Snoozed chat now. */
export type ChatAction =
  | { kind: "settle"; settled: boolean }
  | { kind: "pin"; pinned: boolean }
  | { kind: "snooze"; until?: number }
  | { kind: "rename"; title: string }
  | { kind: "regenerate-title" }
  | { kind: "unread"; unread: boolean }
  | { kind: "copy-chat" }
  | { kind: "copy-folder" }
  | { kind: "delete" };

const HOUR_MS = 3_600_000;
/** "Tomorrow" means this hour, local time. */
const MORNING_HOUR = 9;

/** The snooze times the menu offers, from `now`. */
export function snoozePresets(now = Date.now()): { label: string; until: number }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(MORNING_HOUR, 0, 0, 0);
  return [
    { label: "1 hour", until: now + HOUR_MS },
    { label: "3 hours", until: now + 3 * HOUR_MS },
    { label: "Tomorrow", until: tomorrow.getTime() },
  ];
}

function Item({
  icon,
  label,
  hint,
  danger,
  disabled,
  onClick,
  onPointerEnter,
  ...rest
}: {
  icon?: ReactNode;
  label: string;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onPointerEnter?: () => void;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
  title?: string;
}) {
  return (
    <button role="menuitem" className={`menu-item ${danger ? "danger" : ""}`} disabled={disabled} onClick={onClick} onPointerEnter={onPointerEnter} {...rest}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

/** Moves focus to the next or previous enabled item of the menu holding the focused one, wrapping around. */
function moveFocus(menu: HTMLElement, step: 1 | -1) {
  const items = [...menu.querySelectorAll<HTMLButtonElement>(":scope > [role=menuitem]:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(at + step + items.length) % items.length]?.focus();
}

/**
 * The right-click menu for one chat, at the pointer, kept inside the window. `onRename` and `onDelete` hand back to
 * the row, which asks for the new title or confirms the delete itself; `onCustomSnooze` opens the snooze dialog.
 */
export function ChatMenu({
  chat,
  x,
  y,
  onAction,
  onRename,
  onDelete,
  onCustomSnooze,
  onClose,
}: {
  chat: Chat;
  x: number;
  y: number;
  onAction: (action: ChatAction) => void;
  onRename: () => void;
  onDelete: () => void;
  onCustomSnooze: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, flip: false });
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [presets] = useState(() => snoozePresets());

  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    // The times open to the left when there's no room on the right.
    setPos({ left, top, flip: left + r.width + 210 > window.innerWidth });
    menu.current!.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => menu.current?.contains(e.target as Node) || onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("wheel", away, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("wheel", away);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const act = (action: ChatAction) => {
    onClose();
    onAction(action);
  };
  const openSnooze = (focus: boolean) => {
    setSnoozeOpen(true);
    if (focus) requestAnimationFrame(() => sub.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
  };
  const closeSnooze = () => setSnoozeOpen(false);
  const time = (t: number) => <span className="menu-time">{wakeLabel(t)}</span>;

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={`Actions for ${chat.title}`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const inSub = sub.current?.contains(document.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          if (inSub) {
            closeSnooze();
            menu.current!.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
          } else onClose();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(inSub ? sub.current! : menu.current!, e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === (pos.flip ? "ArrowLeft" : "ArrowRight") && (document.activeElement as HTMLElement)?.getAttribute("aria-haspopup")) {
          e.preventDefault();
          openSnooze(true);
        } else if (e.key === (pos.flip ? "ArrowRight" : "ArrowLeft") && inSub) {
          e.preventDefault();
          closeSnooze();
          menu.current!.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
        } else if (e.key === "Tab") e.preventDefault();
      }}
    >
      {chat.pinned ? (
        <Item icon={<PinOff size={15} />} label="Unpin" onClick={() => act({ kind: "pin", pinned: false })} onPointerEnter={closeSnooze} />
      ) : (
        <Item icon={<Pin size={15} />} label="Pin to top" onClick={() => act({ kind: "pin", pinned: true })} onPointerEnter={closeSnooze} />
      )}
      {chat.settled ? (
        <Item
          icon={<ArchiveRestore size={15} />}
          label="Move to Active"
          onClick={() => act({ kind: "settle", settled: false })}
          onPointerEnter={closeSnooze}
        />
      ) : (
        <Item icon={<Archive size={15} />} label="Settle" onClick={() => act({ kind: "settle", settled: true })} onPointerEnter={closeSnooze} />
      )}
      <div className="menu-sub-anchor">
        <Item
          icon={<AlarmClock size={15} />}
          label={chat.snoozedUntil ? "Snoozed" : "Snooze"}
          hint={chat.snoozedUntil ? time(chat.snoozedUntil) : <ChevronRight size={14} />}
          aria-haspopup="menu"
          aria-expanded={snoozeOpen}
          onClick={() => openSnooze(true)}
          onPointerEnter={() => openSnooze(false)}
        />
        {snoozeOpen && (
          <div ref={sub} className={`menu submenu ${pos.flip ? "flip" : ""}`} role="menu" aria-label="Snooze until">
            {chat.snoozedUntil && <Item label="Wake now" onClick={() => act({ kind: "snooze" })} />}
            {presets.map((p) => (
              <Item
                key={p.label}
                label={p.label}
                // "Tomorrow" already says which day.
                hint={<span className="menu-time">{wakeLabel(p.until).replace(/^Tomorrow /, p.label === "Tomorrow" ? "" : "Tomorrow ")}</span>}
                onClick={() => act({ kind: "snooze", until: p.until })}
              />
            ))}
            <div className="menu-sep" />
            <Item
              label="Pick a time…"
              onClick={() => {
                onClose();
                onCustomSnooze();
              }}
            />
          </div>
        )}
      </div>
      <div className="menu-sep" />
      <Item
        icon={<Pencil size={15} />}
        label="Rename…"
        onClick={() => {
          onClose();
          onRename();
        }}
        onPointerEnter={closeSnooze}
      />
      <Item icon={<Sparkles size={15} />} label="Regenerate title" onClick={() => act({ kind: "regenerate-title" })} onPointerEnter={closeSnooze} />
      {chat.unread ? (
        <Item icon={<MessageSquare size={15} />} label="Mark as read" onClick={() => act({ kind: "unread", unread: false })} onPointerEnter={closeSnooze} />
      ) : (
        <Item icon={<MessageSquareDot size={15} />} label="Mark as unread" onClick={() => act({ kind: "unread", unread: true })} onPointerEnter={closeSnooze} />
      )}
      <div className="menu-sep" />
      <Item icon={<Copy size={15} />} label="Copy chat" onClick={() => act({ kind: "copy-chat" })} onPointerEnter={closeSnooze} />
      <Item icon={<FolderOpen size={15} />} label="Copy working folder" onClick={() => act({ kind: "copy-folder" })} onPointerEnter={closeSnooze} />
      <div className="menu-sep" />
      <Item
        icon={<Trash2 size={15} />}
        label="Delete…"
        danger
        disabled={chat.running}
        title={chat.running ? "Stop the reply before deleting the chat." : undefined}
        onClick={() => {
          onClose();
          onDelete();
        }}
        onPointerEnter={closeSnooze}
      />
    </div>
  );
}

/** `t` as a `datetime-local` input's value, in local time. */
function localInput(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Picks a custom time to snooze a chat until, tomorrow morning to start with. It must be in the future. */
export function SnoozeDialog({ chat, onSnooze, onClose }: { chat: Chat; onSnooze: (until: number) => void; onClose: () => void }) {
  const [value, setValue] = useState(() => localInput(snoozePresets()[2].until));
  const until = new Date(value).getTime();
  const valid = Number.isFinite(until) && until > Date.now();
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label={`Snooze ${chat.title}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSnooze(until);
        }}
      >
        <h2>Snooze until</h2>
        <p className="muted small dialog-note">
          “{chat.title}” moves to Settled now, and back to Active, unread, at this time.
        </p>
        <input type="datetime-local" autoFocus value={value} min={localInput(Date.now())} onChange={(e) => setValue(e.target.value)} />
        <div className="dialog-foot">
          <span className="dialog-hint">{valid ? wakeLabel(until) : "Pick a time in the future."}</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Snooze
          </button>
        </div>
      </form>
    </div>
  );
}
