// Right-click menus: the one a chat row opens on right-click, the Menu key or Shift+F10, and the shell the status bar's
// menu uses too. Escape or a click elsewhere closes one, and focus goes back to what had it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import type { Chat } from "../hermes/model";
import { useReturnFocus } from "./bits";

/** The right-click menu for one chat, at the pointer, kept inside the window. `onRename` hands back to the row. */
export function ChatMenu({ chat, x, y, onRename, onClose }: { chat: Chat; x: number; y: number; onRename: () => void; onClose: () => void }) {
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
          const at = items.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
          items[(at + items.length) % items.length]?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
