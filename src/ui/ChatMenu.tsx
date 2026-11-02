// The menu a chat row opens on right-click, the Menu key or Shift+F10. Escape or a click elsewhere closes it, and focus
// goes back to the chat.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Pencil, Sparkles } from "lucide-react";
import type { Chat } from "../hermes/model";
import type { Project } from "../hermes/projects";
import { useReturnFocus } from "./bits";

/** The profile's projects, for the chat menu: which ones the chat is in, and putting it in one or taking it out. */
export type ChatProjects = { list: Project[]; of: Set<string>; onToggle: (projectId: string, inProject: boolean) => void };

/**
 * The right-click menu for one chat, at the pointer, kept inside the window. `onRename` and `onRegenTitle` hand back
 * to the row. Below them, a checkbox for each project puts the chat in it or takes it out, on this computer only. The
 * arrow keys move between its items.
 */
export function ChatMenu({
  chat,
  x,
  y,
  onRename,
  onRegenTitle,
  projects,
  onClose,
}: {
  chat: Chat;
  x: number;
  y: number;
  onRename: () => void;
  onRegenTitle: () => void;
  projects?: ChatProjects;
  onClose: () => void;
}) {
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
      aria-label={`Actions for ${chat.title}`}
      style={{ left: pos.left, top: pos.top }}
      // The menu sits inside its row, which would open another menu.
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
          const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        }
      }}
    >
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
      {!!projects?.list.length && (
        <div role="group" aria-label="Projects" className="menu-group">
          <div className="menu-heading" aria-hidden>
            Projects
          </div>
          {projects.list.map((p) => {
            const on = projects.of.has(p.id);
            return (
              <button
                key={p.id}
                role="menuitemcheckbox"
                aria-checked={on}
                className="menu-item"
                title={on ? `Take this chat out of ${p.name}` : `Put this chat in ${p.name}`}
                onClick={() => {
                  onClose();
                  projects.onToggle(p.id, !on);
                }}
              >
                <span className="menu-icon">{on && <Check size={15} />}</span>
                <span className="menu-label">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
