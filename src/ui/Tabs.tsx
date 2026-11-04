// Chat tabs: each pane keeps the chats the owner opened in it as tabs, and shows one. A chat from the chat list, or a
// tab from the other pane, can be dragged onto a pane: onto its tab strip to add a tab, onto its right or bottom edge to
// split the chat area there. `null` is the New chat tab.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Spinner } from "./bits";

/** The drag data type a chat id travels under, from a chat list row or a tab. */
export const CHAT_DRAG = "application/x-hermes-chat";

export const dragChat = (e: DragEvent, id: string) => {
  e.dataTransfer.setData(CHAT_DRAG, id);
  e.dataTransfer.effectAllowed = "copy";
};
const dragged = (e: DragEvent) => e.dataTransfer.types.includes(CHAT_DRAG);

/** The tabs once the pane goes from chat `from` to `to`: a chat with a tab already is switched to; otherwise it takes
 * the place of the tab it leaves, as a link followed in a browser tab does. */
export const navigateTabs = (tabs: (string | null)[], from: string | null, to: string | null) =>
  tabs.includes(to) ? tabs : tabs.includes(from) ? tabs.map((t) => (t === from ? to : t)) : [...tabs, to];

/** The tabs once `id`'s tab closes, and the tab shown next if `id`'s was the one shown: the one after it, or before. */
export const closeTabIn = (tabs: (string | null)[], id: string | null) => {
  const at = tabs.indexOf(id);
  const rest = tabs.filter((t) => t !== id);
  return { rest, next: rest[Math.min(at, rest.length - 1)] as string | null | undefined };
};

export type TabInfo = { id: string | null; title: string; running?: boolean; unread?: boolean };

/** One pane's tab strip. A chat dropped on it opens in a new tab. `lastClosable`: closing the last tab closes the pane. */
export function TabStrip({
  tabs,
  current,
  onPick,
  onClose,
  onNew,
  onDropChat,
  lastClosable = false,
}: {
  tabs: TabInfo[];
  current: string | null;
  onPick: (id: string | null) => void;
  onClose: (id: string | null) => void;
  onNew: () => void;
  onDropChat: (id: string) => void;
  lastClosable?: boolean;
}) {
  const [over, setOver] = useState(false);
  // The tab shown is scrolled into sight when the strip is wider than the pane.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }), [current, tabs.length]);
  return (
    <div
      className={`tab-strip ${over ? "drop" : ""}`}
      onDragOver={(e) => {
        if (!dragged(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(CHAT_DRAG);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        onDropChat(id);
      }}
    >
      <div ref={list} className="tabs" role="tablist" aria-label="Chat tabs">
        {tabs.map((t, i) => {
          const on = t.id === current;
          return (
            <div key={t.id ?? "new"} className={`tab ${on ? "on" : ""}`}>
              <button
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className="tab-open"
                title={t.title}
                draggable={t.id !== null}
                onDragStart={(e) => t.id !== null && dragChat(e, t.id)}
                onClick={() => on || onPick(t.id)}
                // A middle click closes the tab, as in a browser.
                onAuxClick={(e) => e.button === 1 && onClose(t.id)}
                onKeyDown={(e) => {
                  const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : undefined;
                  if (e.key === "Delete") return onClose(t.id);
                  if (to === undefined || !tabs[to]) return;
                  e.preventDefault();
                  onPick(tabs[to].id);
                  // React clears `currentTarget` once the handler returns.
                  const strip = e.currentTarget.closest(".tabs");
                  requestAnimationFrame(() => strip?.querySelectorAll<HTMLElement>(".tab-open")[to]?.focus());
                }}
              >
                {t.running ? <Spinner /> : t.unread ? <span className="dot" title="Unread" /> : null}
                <span className="tab-title">{t.title}</span>
              </button>
              {(tabs.length > 1 || lastClosable) && (
                <button className="tab-close" tabIndex={-1} title="Close tab" aria-label={`Close the tab ${t.title}`} onClick={() => onClose(t.id)}>
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="icon-btn tab-new" title="New chat in a new tab" aria-label="New tab" onClick={onNew}>
        <Plus size={15} />
      </button>
    </div>
  );
}

export type DropZone = "tab" | "right" | "bottom";

/** Where over a pane a dragged chat would land: its right or bottom quarter splits the chat area, the rest adds a tab. */
const zoneAt = (e: DragEvent<HTMLElement>): DropZone => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x > 0.75 && x - 0.75 >= y - 0.75) return "right";
  if (y > 0.75) return "bottom";
  return "tab";
};

/** A pane's body as a drop target for chats, showing where a dragged chat would land. */
export function PaneDrop({ children, onDropChat }: { children: ReactNode; onDropChat: (id: string, zone: DropZone) => void }) {
  const [zone, setZone] = useState<DropZone | null>(null);
  return (
    <div
      className="pane-drop"
      onDragOver={(e) => {
        if (!dragged(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setZone(zoneAt(e));
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setZone(null)}
      onDrop={(e) => {
        setZone(null);
        const id = e.dataTransfer.getData(CHAT_DRAG);
        if (!id) return;
        e.preventDefault();
        onDropChat(id, zoneAt(e));
      }}
    >
      {children}
      {zone && (
        <div className={`drop-hint ${zone}`} aria-hidden>
          <span>{zone === "tab" ? "Open in a new tab" : zone === "right" ? "Split right" : "Split down"}</span>
        </div>
      )}
    </div>
  );
}
