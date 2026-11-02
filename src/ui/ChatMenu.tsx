// Right-click menus: the one a chat row opens on right-click, the Menu key or Shift+F10, and the shell the status bar's
// menu uses too. Escape or a click elsewhere closes one, and focus goes back to what had it. The arrow keys move
// between a menu's items.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Columns2, PanelLeft, PanelRight, Pencil, Sparkles } from "lucide-react";
import type { Chat } from "../hermes/model";
import { useReturnFocus } from "./bits";

/**
 * The right-click menu for one chat, at the pointer, kept inside the window. `onRename` and `onRegenTitle` hand back
 * to the row. `onOpenIn` opens the chat in the left (0) or right (1) pane; with one pane (`split` false) the menu offers
 * to open it in a second pane. The arrow keys move between its items.
 */
export function ChatMenu({
  chat,
  x,
  y,
  split = false,
  onOpenIn,
  onRename,
  onRegenTitle,
  onClose,
}: {
  chat: Chat;
  x: number;
  y: number;
  split?: boolean;
  onOpenIn?: (side: number) => void;
  onRename: () => void;
  onRegenTitle: () => void;
  onClose: () => void;
}) {
  return (
    <Menu label={`Actions for ${chat.title}`} x={x} y={y} onClose={onClose}>
      <button
        role="menuitem"
        className="menu-item"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <span className="menu-icon">
          <Pencil size={15} />
        </span>
        <span className="menu-label">Rename…</span>
      </button>
      <button
        role="menuitem"
        className="menu-item"
        title="Ask Hermes for a new title from the last five messages"
        onClick={() => {
          onClose();
          onRegenTitle();
        }}
      >
        <span className="menu-icon">
          <Sparkles size={15} />
        </span>
        <span className="menu-label">Regenerate title</span>
      </button>
      {onOpenIn &&
        (split
          ? [
              { side: 0, label: "Open in left pane", icon: <PanelLeft size={15} /> },
              { side: 1, label: "Open in right pane", icon: <PanelRight size={15} /> },
            ]
          : [{ side: 1, label: "Open in a second pane", icon: <Columns2 size={15} /> }]
        ).map((o) => (
          <button
            key={o.side}
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose();
              onOpenIn(o.side);
            }}
          >
            <span className="menu-icon">{o.icon}</span>
            <span className="menu-label">{o.label}</span>
          </button>
        ))}
    </Menu>
  );
}

/** A menu at the pointer, kept inside the window, its first item focused. */
export function Menu({ label, x, y, onClose, children }: { label: string; x: number; y: number; onClose: () => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useReturnFocus();

  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    menu.current!.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus();
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

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      // The menu sits inside what opened it, which would open another menu.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "Tab") e.preventDefault();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [...menu.current!.querySelectorAll<HTMLElement>("[role^=menuitem]")];
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
