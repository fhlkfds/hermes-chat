// A column of groups beside a Settings tab's content (ADR 0051): the tab shows one group at a time, so no tab scrolls
// at 1920 × 1080. Items can sit under a label ("External memory"), and arrow keys move between them as the tab strip's do.
import type { ReactNode, KeyboardEvent } from "react";

export type SubNavItem = { id: string; label: string; icon?: ReactNode; /** A label drawn above this item, starting a group. */ under?: string; mono?: boolean };

export function SubNav({ label, items, selected, onPick }: { label: string; items: SubNavItem[]; selected: string; onPick: (id: string) => void }) {
  const ids = items.map((i) => i.id);
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const at = ids.indexOf(selected);
    const next = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : -1;
    if (next < 0 || next >= ids.length) return;
    e.preventDefault();
    onPick(ids[next]);
    (e.currentTarget.querySelector(`[data-subnav="${ids[next]}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <nav className="subnav" aria-label={label} onKeyDown={onKey}>
      {items.map((it) => (
        <div key={it.id} className="subnav-cell">
          {it.under && <div className="subnav-label">{it.under}</div>}
          <button
            type="button"
            data-subnav={it.id}
            className={`subnav-item ${it.id === selected ? "on" : ""} ${it.mono ? "mono" : ""}`}
            aria-current={it.id === selected ? "true" : undefined}
            tabIndex={it.id === selected ? 0 : -1}
            onClick={() => onPick(it.id)}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        </div>
      ))}
    </nav>
  );
}
