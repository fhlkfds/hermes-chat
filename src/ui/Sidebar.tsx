// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A. The list's header is the
// profile switcher. Settings opens from the rail's foot. Right-clicking a chat opens its menu (ChatMenu.tsx).
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, LockOpen, Search, Settings, SquarePen, Trash2 } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import { SOURCE_LABEL } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { RenameConflict } from "../hermes/transport";
import { ChatMenu } from "./ChatMenu";
import { STATUS_LABEL, SettleButton, SourceIcon, Spinner, relTime, routeLabel } from "./bits";

const byRecent = (a: Chat, b: Chat) => b.updatedAt - a.updatedAt;


export function Rail({
  status,
  route,
  unsecure,
  closedReason,
  onReconnect,
  onToggleList,
  onNew,
  onSearch,
  onSettings,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  onReconnect: () => void;
  onToggleList: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  const where = routeLabel(route);
  // The full wording lives only in the tooltip (ADR 0001).
  const tip = [
    STATUS_LABEL[status],
    where,
    unsecure && "Unsecure: traffic to the server isn't encrypted",
    status !== "connected" && closedReason,
    status !== "connected" && "Click to reconnect",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <aside className="rail">
      <div className="rail-top">
        <button className="rail-brand" title="Hide or show chats (Ctrl+B)" onClick={onToggleList}>
          H
        </button>
        <button className="icon-btn" title="New chat (Ctrl+N)" onClick={onNew}>
          <SquarePen size={18} />
        </button>
        <button className="icon-btn" title="Search all chats (Ctrl+K)" onClick={onSearch}>
          <Search size={18} />
        </button>
      </div>
      <div className="rail-bottom">
        <button className="conn-btn" title={tip} aria-label={tip} onClick={() => status !== "connected" && onReconnect()}>
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          {unsecure && <LockOpen className="conn-lock" size={9} strokeWidth={2.8} />}
        </button>
        <button className="icon-btn" title="Settings" onClick={onSettings}>
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

/**
 * The chat's title in a text box. Enter saves it, and the box stays until Hermes has read the new title back. If
 * saving fails the typed title stays, with why; if the chat was renamed elsewhere, the list shows that title and only
 * another Enter replaces it. Escape, or clicking away before changing anything, keeps the old title.
 */
function RenameRow({
  chat,
  selected,
  onRename,
  onDone,
}: {
  chat: Chat;
  selected: boolean;
  onRename: (title: string, from: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(chat.title);
  // The title being replaced: after a conflict, the one the server has now.
  const [from, setFrom] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    onRename(draft, from).then(onDone, (e) => {
      if (e instanceof RenameConflict) setFrom(e.title);
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    });
  };
  return (
    <div className={`row renaming ${selected ? "sel" : ""}`}>
      <input
        className="row-rename"
        aria-label="Chat title"
        aria-invalid={!!error}
        autoFocus
        value={draft}
        readOnly={saving}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          else if (e.key === "Escape" && !saving) onDone();
        }}
        onBlur={() => !saving && draft.trim() === from && onDone()}
      />
      {saving && <Spinner />}
      {error && (
        <div className="row-rename-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * One chat in the list. Right-clicking it opens its menu. Its trash button asks before deleting, in the row itself:
 * Escape, Cancel or clicking away keeps the chat. A chat with a reply running can't be deleted.
 */
function ChatRow({
  chat,
  selected,
  onOpen,
  onSettle,
  onDelete,
  onRename,
}: {
  chat: Chat;
  selected: boolean;
  onOpen: () => void;
  onSettle: (settled: boolean) => void;
  onDelete: () => void;
  onRename: (title: string, from: string) => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  if (renaming) return <RenameRow chat={chat} selected={selected} onRename={onRename} onDone={() => setRenaming(false)} />;
  if (confirming)
    return (
      <div
        className={`row confirming ${selected ? "sel" : ""}`}
        onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
        onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setConfirming(false)}
      >
        <span className="row-title">{chat.title}</span>
        <button className="row-confirm danger" title="Delete this chat in every Hermes client. This can't be undone." onClick={onDelete}>
          Delete
        </button>
        <button className="row-confirm" autoFocus onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    );
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${chat.unread ? "unread" : ""} ${menu ? "menu-open" : ""}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title={chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}
    >
      {chat.source !== "app" && <SourceIcon source={chat.source} />}
      <span className="row-title">{chat.title}</span>
      <span className="row-meta">
        {chat.running ? <Spinner /> : chat.unread ? <span className="dot" title="Unread" /> : relTime(chat.updatedAt)}
      </span>
      <SettleButton settled={chat.settled} size={14} className="row-action" onSettle={onSettle} />
      {!chat.running && (
        <button
          className="row-action"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
      {menu && <ChatMenu chat={chat} x={menu.x} y={menu.y} onRename={() => setRenaming(true)} onClose={closeMenu} />}
    </div>
  );
}

/**
 * The current profile's name with a ▾, which opens the server's profiles with a filter box (ADR 0001). Enter picks
 * the first match; Escape or a click outside closes it.
 */
function ProfileSwitcher({
  profile,
  onListProfiles,
  onSwitch,
}: {
  profile: string;
  onListProfiles: () => Promise<string[]>;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFilter("");
    setError(undefined);
    onListProfiles().then(
      (names) => current && setProfiles(names),
      (e) => current && setError(`Couldn't list profiles: ${e instanceof Error ? e.message : String(e)}`),
    );
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => {
      current = false;
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const shown = (profiles ?? [profile]).filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase()));
  const pick = (name: string) => {
    setOpen(false);
    if (name !== profile) onSwitch(name);
  };

  return (
    <div className="profile-switch" ref={box}>
      <button className="profile-btn" title="Switch profile" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="profile-name">{profile}</span>
        <ChevronDown size={14} className="profile-chev" />
      </button>
      {open && (
        <div className="profile-menu" role="listbox" aria-label="Profiles">
          <input
            className="profile-filter"
            autoFocus
            placeholder="Filter profiles"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "Enter" && shown[0]) pick(shown[0]);
            }}
          />
          <div className="profile-options">
            {shown.map((p) => (
              <button key={p} role="option" aria-selected={p === profile} className={`profile-option ${p === profile ? "on" : ""}`} onClick={() => pick(p)}>
                <span className="row-title">{p}</span>
                {p === profile && <Check size={14} />}
              </button>
            ))}
            {!profiles && !error && <div className="profile-hint">Loading profiles…</div>}
            {profiles && shown.length === 0 && <div className="profile-hint">No profile matches.</div>}
            {error && <div className="profile-hint err">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatList({
  profile,
  chats,
  syncError,
  selectedId,
  onOpen,
  onSettle,
  onDelete,
  onRename,
  onListProfiles,
  onSwitchProfile,
}: {
  profile: string;
  chats: Chat[];
  syncError?: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onSettle: (id: string, settled: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string, from: string) => Promise<unknown>;
  onListProfiles: () => Promise<string[]>;
  onSwitchProfile: (name: string) => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  // Opening a Settled chat, say from a search, shows it in the list; settling the chat on screen doesn't.
  const selectedSettled = chats.some((c) => c.id === selectedId && c.settled);
  useEffect(() => {
    if (selectedSettled) setSettledOpen(true);
  }, [selectedId]);
  const active = chats.filter((c) => !c.settled).sort(byRecent);
  const settled = chats.filter((c) => c.settled).sort(byRecent);
  const settledUnread = settled.filter((c) => c.unread).length;
  const row = (c: Chat) => (
    <ChatRow
      key={c.id}
      chat={c}
      selected={c.id === selectedId}
      onOpen={() => onOpen(c.id)}
      onSettle={(s) => onSettle(c.id, s)}
      onDelete={() => onDelete(c.id)}
      onRename={(title, from) => onRename(c.id, title, from)}
    />
  );
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <ProfileSwitcher profile={profile} onListProfiles={onListProfiles} onSwitch={onSwitchProfile} />
      </div>
      <div className="sb-scroll">
        {syncError && (
          <div className="sync-error" role="status">
            {syncError}
          </div>
        )}
        <div className="section-label">Active</div>
        {active.length ? active.map(row) : <div className="empty-hint">Nothing active. Start a new chat.</div>}
      </div>
      {/* Settled is pinned to the foot of the list and opens upward as a drawer with its own scroll. */}
      <div className={`settled-section ${settledOpen ? "open" : ""}`}>
        <button className="section-toggle" onClick={() => setSettledOpen((o) => !o)}>
          <ChevronRight size={14} className={`chev ${settledOpen ? "open" : ""}`} />
          Settled
          <span className="count">{settled.length}</span>
          {settledUnread > 0 && !settledOpen && <span className="dot" title={`${settledUnread} unread`} />}
        </button>
        {settledOpen && <div className="settled-list">{settled.map(row)}</div>}
      </div>
    </aside>
  );
}
