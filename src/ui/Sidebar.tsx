// Icon rail beside a chat list (ADR 0001), ported from the prototype's variants C and A, with its tools grouped into Work
// and Server and tips that show at once (ADR 0048). The list's header is the profile switcher. Settings opens from the
// rail's foot. Right-clicking a chat opens its menu (ChatMenu.tsx).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BarChart3, CalendarClock, Check, ChevronDown, ChevronRight, CircleAlert, EyeOff, FileOutput, FolderOpen, Inbox as InboxIcon, LockOpen, ScrollText, Search, Settings, SquarePen, SquareTerminal, Trash2, Webhook, FolderGit2 } from "lucide-react";
import type { Chat, ConnectionStatus, OtherProfile, OtherProfiles } from "../hermes/model";
import { SOURCE_LABEL, isWaiting } from "../hermes/model";
import { CHECK_EVERY_MS, totalUnread } from "../hermes/otherProfiles";
import type { Route } from "../hermes/pipe";
import { RenameConflict, TitleModelUnavailable, type Snapshot } from "../hermes/transport";
import { chatSections, wakeFull, wakeLabel, type Snoozes } from "../hermes/snooze";
import { ChatMenu, type ChatProjects, type ChatSnooze, type ChatTags } from "./ChatMenu";
import { SnoozeDialog, useSnoozeClock } from "./Snooze";
import { DeleteChatDialog } from "./DeleteChat";
import { ArchiveButton, STATUS_LABEL, SettleButton, SourceIcon, Spinner, composing, relTime, routeLabel, useReturnFocus } from "./bits";
import { dragChat } from "./Tabs";



export function Rail({
  status,
  route,
  unsecure,
  closedReason,
  onReconnect,
  onToggleList,
  onNew,
  onSearch,
  onFiles,
  filesOpen = false,
  onInbox,
  inboxOpen = false,
  inboxCount = 0,
  onOutputs,
  outputsOpen = false,
  onSettings,
  settingsOpen = false,
  onJobs,
  jobsOpen = false,
  onAutomations,
  automationsOpen = false,
  onUsage,
  usageOpen = false,
  onLogs,
  logsOpen = false,
  onRepo,
  repoOpen = false,
  onTerminal,
  terminalOpen = false,
  terminalRunning = false,
  updateWaiting = false,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  onReconnect: () => void;
  onToggleList: () => void;
  onNew: () => void;
  onSearch: () => void;
  /** Opens Server files, the read-only browser for the files on the Hermes server (FileBrowser.tsx). */
  onFiles?: () => void;
  filesOpen?: boolean;
  /** Opens or closes the inbox (Inbox.tsx); `inboxCount`: its entries that need the owner. */
  onInbox?: () => void;
  inboxOpen?: boolean;
  inboxCount?: number;
  /** Opens Outputs, the files Hermes's tools wrote (Outputs.tsx). */
  onOutputs?: () => void;
  outputsOpen?: boolean;
  onSettings: () => void;
  settingsOpen?: boolean;
  /** Opens Scheduled jobs: Hermes's jobs for the profile, which it runs on the server. */
  onJobs?: () => void;
  jobsOpen?: boolean;
  /** Opens Automations: Hermes's webhook routes for the profile, which start tasks on the server (Automations.tsx). */
  onAutomations?: () => void;
  automationsOpen?: boolean;
  /** Opens Usage analytics: tokens and recorded cost across chats, models, projects and profiles (UsageAnalytics.tsx). */
  onUsage?: () => void;
  usageOpen?: boolean;
  /** Opens Logs: this app's diagnostics and the profile's Hermes logs (Logs.tsx). */
  onLogs?: () => void;
  logsOpen?: boolean;
  /** Opens or closes the Repository screen: a Git checkout on the server, through the owner's ssh (Repository.tsx). */
  onRepo?: () => void;
  repoOpen?: boolean;
  /** Opens or closes the Terminal: a shell on the server through the owner's ssh (Terminal.tsx). */
  onTerminal?: () => void;
  terminalOpen?: boolean;
  /** Its ssh is running, maybe out of sight. */
  terminalRunning?: boolean;
  /** An update is ready to install or restart into (Settings → Updates). */
  updateWaiting?: boolean;
}) {
  const where = routeLabel(route);
  // The connection's full wording lives only in its tip (ADR 0001).
  const connNote = [
    where,
    unsecure && "Unsecure: traffic to the server isn't encrypted",
    status !== "connected" && closedReason,
    status !== "connected" && "Click to reconnect",
  ]
    .filter(Boolean)
    .join(" · ");
  const connLabel = [STATUS_LABEL[status], connNote].filter(Boolean).join(" · ");
  const { shown, bind, hide } = useRailTip();
  const needs = inboxCount ? `${inboxCount} need${inboxCount === 1 ? "s" : ""} you` : undefined;
  const work = [
    onFiles && (
      <button key="files" className={`icon-btn ${filesOpen ? "on" : ""}`} aria-label="Server files" aria-pressed={filesOpen} onClick={onFiles} {...bind("files", { label: "Server files", note: "Browse the files on the server" })}>
        <FolderOpen size={18} />
      </button>
    ),
    onOutputs && (
      <button key="outputs" className={`icon-btn ${outputsOpen ? "on" : ""}`} aria-label="Outputs" aria-pressed={outputsOpen} onClick={onOutputs} {...bind("outputs", { label: "Outputs", note: "Files Hermes made" })}>
        <FileOutput size={18} />
      </button>
    ),
    onRepo && (
      <button key="repo" className={`icon-btn ${repoOpen ? "on" : ""}`} aria-label="Repository" aria-pressed={repoOpen} onClick={onRepo} {...bind("repo", { label: "Repository", note: "Git changes on the server" })}>
        <FolderGit2 size={18} />
      </button>
    ),
    onTerminal && (
      <button
        key="terminal"
        className={`icon-btn terminal-btn ${terminalOpen ? "on" : ""}`}
        aria-label={terminalRunning ? "Terminal, session running" : "Terminal"}
        aria-pressed={terminalOpen}
        onClick={onTerminal}
        {...bind("terminal", { label: "Terminal", note: terminalRunning && !terminalOpen ? "On the server: a session is running" : "A shell on the server" })}
      >
        <SquareTerminal size={18} />
        {terminalRunning && !terminalOpen && <span className="dot terminal-dot" aria-hidden />}
      </button>
    ),
  ].filter(Boolean);
  const server = [
    onJobs && (
      <button key="jobs" className={`icon-btn ${jobsOpen ? "on" : ""}`} aria-label="Scheduled jobs" aria-pressed={jobsOpen} onClick={onJobs} {...bind("jobs", { label: "Scheduled jobs", note: "Tasks Hermes runs on a schedule" })}>
        <CalendarClock size={18} />
      </button>
    ),
    onAutomations && (
      <button key="automations" className={`icon-btn ${automationsOpen ? "on" : ""}`} aria-label="Automations" aria-pressed={automationsOpen} onClick={onAutomations} {...bind("automations", { label: "Automations", note: "Tasks started by GitHub events" })}>
        <Webhook size={18} />
      </button>
    ),
    onLogs && (
      <button key="logs" className={`icon-btn ${logsOpen ? "on" : ""}`} aria-label="Logs" aria-pressed={logsOpen} onClick={onLogs} {...bind("logs", { label: "Logs", note: "Diagnostics and Hermes's logs" })}>
        <ScrollText size={18} />
      </button>
    ),
    onUsage && (
      <button key="usage" className={`icon-btn ${usageOpen ? "on" : ""}`} aria-label="Usage" aria-pressed={usageOpen} onClick={onUsage} {...bind("usage", { label: "Usage", note: "Tokens and recorded cost" })}>
        <BarChart3 size={18} />
      </button>
    ),
  ].filter(Boolean);
  // Daily tools first, then the profile's tools in two labeled groups (ADR 0048).
  const parts = (
    <>
      <div className="rail-top">
        <button className="rail-brand" aria-label="Hide or show chats" aria-keyshortcuts="Control+B" onClick={onToggleList} {...bind("brand", { label: "Hide or show chats", keys: "Ctrl+B" })}>
          H
        </button>
        <button className="icon-btn rail-primary" aria-label="New chat (Ctrl+N)" aria-keyshortcuts="Control+N" onClick={onNew} {...bind("new", { label: "New chat", keys: "Ctrl+N" })}>
          <SquarePen size={18} />
        </button>
        <button className="icon-btn rail-primary" aria-label="Search all chats (Ctrl+K)" aria-keyshortcuts="Control+K" onClick={onSearch} {...bind("search", { label: "Search all chats", keys: "Ctrl+K" })}>
          <Search size={18} />
        </button>
        {onInbox && (
          <button
            className={`icon-btn rail-primary inbox-btn ${inboxOpen ? "on" : ""}`}
            aria-label={needs ? `Inbox, ${needs}` : "Inbox"}
            aria-expanded={inboxOpen}
            onClick={onInbox}
            {...bind("inbox", { label: "Inbox", note: needs ?? "What needs you in any profile" })}
          >
            <InboxIcon size={18} />
            {inboxCount > 0 && <span className="badge" aria-hidden>{inboxCount > 99 ? "99+" : inboxCount}</span>}
          </button>
        )}
      </div>
      <div className="rail-mid" onScroll={hide}>
        {work.length > 0 && (
          <div className="rail-group" role="group" aria-label="Work">
            <span className="rail-group-label" aria-hidden>Work</span>
            {work}
          </div>
        )}
        {server.length > 0 && (
          <div className="rail-group" role="group" aria-label="Server">
            <span className="rail-group-label" aria-hidden>Server</span>
            {server}
          </div>
        )}
      </div>
      <div className="rail-bottom">
        <button className="conn-btn" aria-label={connLabel} onClick={() => status !== "connected" && onReconnect()} {...bind("conn", { label: STATUS_LABEL[status], note: connNote || undefined })}>
          <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
          {unsecure && <LockOpen className="conn-lock" size={9} strokeWidth={2.8} />}
        </button>
        <button
          className={`icon-btn settings-btn ${settingsOpen ? "on" : ""}`}
          aria-label={updateWaiting ? "Settings: an update is ready" : "Settings"}
          aria-keyshortcuts="Control+Comma"
          aria-pressed={settingsOpen}
          onClick={onSettings}
          {...bind("settings", { label: "Settings", keys: "Ctrl+,", note: updateWaiting ? "An update is ready" : "Import, backup and more" })}
        >
          <Settings size={18} />
          {updateWaiting && <span className="dot update-dot" />}
        </button>
      </div>
    </>
  );
  const tip = shown();
  return (
    <aside className="rail">
      {parts}
      {tip && (
        <div className="rail-tip" role="tooltip" aria-hidden style={{ top: tip.top }}>
          <span className="rail-tip-label">{tip.label}</span>
          {tip.keys && <kbd>{tip.keys}</kbd>}
          {tip.note && <span className="rail-tip-note">{tip.note}</span>}
        </div>
      )}
    </aside>
  );
}

type RailTip = { label: string; keys?: string; note?: string };

/**
 * The rail's one tip: it shows at once beside the button under the pointer or keyboard focus, with the button's name,
 * its shortcut and a line about it, and goes on leaving, blurring, scrolling or Escape. Everything in it is also in the
 * button's own name or `aria-keyshortcuts`, so it is hidden from screen readers.
 */
function useRailTip() {
  const [at, setAt] = useState<{ key: string; top: number }>();
  const hide = useCallback(() => setAt(undefined), []);
  useEffect(() => {
    if (!at) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
    };
  }, [at, hide]);
  // Rebuilt each render, so a tip that stays up shows the button's wording as it is now (an Inbox count, a session).
  const tips: Record<string, RailTip> = {};
  const bind = (key: string, t: RailTip) => {
    tips[key] = t;
    const show = (e: { currentTarget: HTMLElement }) => {
      const r = e.currentTarget.getBoundingClientRect();
      setAt({ key, top: r.top + r.height / 2 });
    };
    return { onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide };
  };
  /** The tip showing, read after every `bind` of the render. */
  const shown = () => (at && tips[at.key] ? { ...tips[at.key], top: at.top } : undefined);
  return { shown, bind, hide };
}

/**
 * The chat's title in a text box. Enter saves it, and the box stays until Hermes has read the new title back. If
 * saving fails the typed title stays, with why; if the chat was renamed elsewhere, the list shows that title and only
 * another Enter replaces it. Escape, or clicking away before changing anything, keeps the old title.
 */
function RenameRow({
  chat,
  selected,
  hidden,
  onRename,
  onDone,
}: {
  chat: Chat;
  selected: boolean;
  hidden?: boolean;
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
    <div className={`row renaming ${selected ? "sel" : ""}`} hidden={hidden}>
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
          if (composing(e)) return;
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
 * One chat in the list: a button that opens it, then its Settle, Archive and Delete buttons. Right-clicking it, or the
 * Menu key or Shift+F10 on it, opens its menu. The trash button, Delete chat… in the menu, and Delete or Backspace on
 * the focused row all ask before deleting (`onAskDelete`, with what focus goes back to if the owner keeps the chat).
 * An archived chat has Restore in place of Settle and Archive. A chat with
 * a reply running can't be archived, restored or deleted. `snooze`: the chat can be snoozed from its menu. A snoozed
 * chat shows when it wakes in place of its age. `section`: where the list shows it, for styling. Regenerate title in the menu shows a spinner until the new
 * title is saved, and why underneath if it isn't. When Hermes can't use the Text generation model's provider, that
 * note says how to fix it and offers the setting.
 */
function ChatRow({
  chat,
  selected,
  alsoShown,
  split,
  onOpen,
  onOpenIn,
  onOpenTab,
  onSettle,
  onArchive,
  onAskDelete,
  onRename,
  onRegenTitle,
  onCopyLink,
  onTextGenerationSettings,
  projects,
  tags,
  snooze,
  section,
  hidden,
}: {
  chat: Chat;
  selected: boolean;
  /** The chat is in the pane that isn't active. */
  alsoShown: boolean;
  split: boolean;
  onOpen: () => void;
  /** Opens the chat in the left (0) or right (1) pane. */
  onOpenIn: (side: number) => void;
  /** Opens the chat in a new tab of the active pane. */
  onOpenTab: () => void;
  onSettle: (settled: boolean) => void;
  onArchive: (archived: boolean) => void;
  onAskDelete: (returnTo: HTMLElement | null) => void;
  onRename: (title: string, from: string) => Promise<unknown>;
  onRegenTitle: () => Promise<unknown>;
  /** Copies the chat's link (chatLinks.ts). */
  onCopyLink?: () => void;
  /** Opens Settings → Model at the Text generation model. */
  onTextGenerationSettings?: () => void;
  projects?: ChatProjects;
  tags?: ChatTags;
  snooze?: ChatSnooze;
  section?: string;
  /** In a collapsed section: kept, with its rename box or menu, but out of sight. */
  hidden?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [retitling, setRetitling] = useState(false);
  /** Why the title wasn't regenerated. `detail`: Hermes's own words; `settings`: the fix is the Text generation model. */
  const [retitleError, setRetitleError] = useState<{ text: string; detail?: string; settings?: boolean }>();
  const regenTitle = () => {
    if (retitling) return;
    setRetitling(true);
    setRetitleError(undefined);
    onRegenTitle()
      .catch((e) =>
        setRetitleError(
          e instanceof RenameConflict
            ? { text: `This chat was renamed in another Hermes client meanwhile, to "${e.title}". Regenerate again to replace it.` }
            : e instanceof TitleModelUnavailable
              ? { text: `Couldn't regenerate the title: ${e.message}`, detail: e.detail, settings: true }
              : { text: `Couldn't regenerate the title: ${e instanceof Error ? e.message : String(e)}` },
        ),
      )
      .finally(() => setRetitling(false));
  };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openButton = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  // The rename box replaces the row; once it closes, focus goes back to the chat unless the owner moved it elsewhere.
  useEffect(() => {
    const now = document.activeElement;
    if (wasRenaming.current && !renaming && (!now || now === document.body)) openButton.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);
  const now = Date.now();
  const sleepsUntil = snooze?.until !== undefined && snooze.until > now ? snooze.until : undefined;
  if (renaming) return <RenameRow chat={chat} selected={selected} hidden={hidden} onRename={onRename} onDone={() => setRenaming(false)} />;
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${alsoShown ? "shown" : ""} ${chat.unread ? "unread" : ""} ${menu ? "menu-open" : ""} ${retitleError ? "retitle-failed" : ""} ${retitling ? "retitling" : ""}`}
      data-section={section}
      hidden={hidden}
      onContextMenu={(e) => {
        e.preventDefault();
        setRetitleError(undefined);
        // From the keyboard the event has no pointer position, so the menu opens under the row.
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom });
      }}
    >
      <button
        ref={openButton}
        className="row-open"
        data-chat={chat.id}
        aria-current={selected || undefined}
        // Dragged onto a pane's tabs or edge, the chat opens in a new tab or a split there (Tabs.tsx).
        draggable
        onDragStart={(e) => dragChat(e, chat.id)}
        title={`${retitling ? "Writing a new title…" : chat.source !== "app" ? `${chat.title} (from ${SOURCE_LABEL[chat.source]})` : chat.title}${alsoShown ? " (in the other pane)" : ""}${sleepsUntil ? ` (snoozed until ${wakeFull(sleepsUntil)})` : ""}`}
        onClick={() => {
          setRetitleError(undefined);
          onOpen();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !chat.running) {
            e.preventDefault();
            onAskDelete(e.currentTarget);
          }
        }}
      >
        {chat.source !== "app" && <SourceIcon source={chat.source} />}
        <span className="row-title">{chat.title}</span>
        <span className="row-meta">
          {sleepsUntil && <span className="row-wake">{wakeLabel(sleepsUntil, now)}</span>}
          {chat.running || retitling ? (
            <Spinner />
          ) : chat.unread ? (
            <span className="dot" title="Unread" />
          ) : (
            !sleepsUntil && relTime(chat.updatedAt)
          )}
        </span>
      </button>
      {!chat.archived && (
        <SettleButton
          settled={chat.settled}
          size={14}
          className="row-action"
          onSettle={onSettle}
        />
      )}
      {!chat.running && <ArchiveButton archived={!!chat.archived} size={14} className="row-action" onArchive={onArchive} />}
      {!chat.running && (
        <button
          className="row-action"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onAskDelete(e.currentTarget);
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
      {menu && (
        <ChatMenu
          chat={chat}
          projects={projects}
          tags={tags}
          x={menu.x}
          y={menu.y}
          split={split}
          snooze={snooze}
          onOpenIn={onOpenIn}
          onOpenTab={onOpenTab}
          onRename={() => setRenaming(true)}
          onRegenTitle={regenTitle}
          onCopyLink={onCopyLink}
          onDelete={chat.running ? undefined : () => onAskDelete(openButton.current)}
          onClose={closeMenu}
        />
      )}
      {retitleError && (
        <div className="row-rename-error" role="alert" title={retitleError.detail && `Hermes said: ${retitleError.detail}`}>
          {retitleError.text}
          {retitleError.settings && onTextGenerationSettings && (
            <button
              className="link-btn row-error-action"
              onClick={() => {
                setRetitleError(undefined);
                onTextGenerationSettings();
              }}
            >
              Text generation settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ago = (ts: number) => (relTime(ts) === "now" ? "just now" : `${relTime(ts)} ago`);
const unreadCount = (p: OtherProfile) => `${p.unread}${p.more ? "+" : ""}`;
const CHECKED_EVERY = `Other profiles are checked every ${CHECK_EVERY_MS / 60_000} minutes`;

/** What the latest check of another profile found, and when; an earlier answer is kept through a failed check. */
function otherTip(p?: OtherProfile): string {
  const found = (q: OtherProfile) =>
    q.checkedAt === undefined
      ? undefined
      : `${q.unread ? `${unreadCount(q)} unread` : "No unread chats"}${q.more ? " in its most recent chats" : ""}, checked ${ago(q.checkedAt)}`;
  if (p?.error) return [`Couldn't check: ${p.error}`, found(p) && `Earlier: ${found(p)}`].filter(Boolean).join(". ");
  return (p && found(p)) ?? "Not checked yet";
}

/** The switcher's tooltip: which other profiles have Unread chats, which couldn't be checked, and how fresh it is. */
function switcherTip(others: OtherProfiles): string {
  const { withUnread, failed } = totalUnread(others);
  return [
    "Switch profile",
    withUnread.length && `Unread chats in ${withUnread.map((n) => `${n} (${unreadCount(others.byName[n])})`).join(", ")}`,
    failed.length && `Couldn't check ${failed.join(", ")}`,
    others.error,
    `${CHECKED_EVERY}${others.checkedAt ? `; last ${ago(others.checkedAt)}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A dot and count for another profile with Unread chats, and a mark when its latest check failed; the count beside
 * the mark is from an earlier check.
 */
function OtherBadge({ info }: { info?: OtherProfile }) {
  if (!info?.unread && !info?.error) return null;
  return (
    <span className="profile-unread">
      {!!info.unread && (
        <>
          <span className="dot" />
          {unreadCount(info)}
        </>
      )}
      {info.error && <CircleAlert size={13} className="profile-unknown" />}
    </span>
  );
}

/**
 * What the owner leaves behind in `profile` by switching away now, if anything: an Approval waiting, or a reply
 * running. Hermes keeps running the reply; an Approval waits only until Hermes stops waiting (its timeout).
 */
export function leavingNote(profile: string, chats: Chat[]): string | undefined {
  if (chats.some((c) => c.items.some(isWaiting)))
    return `An approval is waiting in ${profile}. Hermes waits for your answer only until it times out: switch back and open the chat to answer it.`;
  if (chats.some((c) => c.running)) return `A reply is still running in ${profile}. Hermes keeps it going, and it shows here when you switch back.`;
}

/**
 * The current profile's name with a ▾, which opens the server's profiles with a filter box (ADR 0001). Enter picks
 * the first match; Escape or a click outside closes it. A dot on it, and a count on each profile in the menu, show
 * Unread chats in the other profiles, as the latest poll found them. Opening the menu asks for a fresh check.
 * `leaving`: what switching away now leaves behind, which the owner is asked about first.
 */
function ProfileSwitcher({
  profile,
  others,
  leaving,
  onListProfiles,
  onCheckOthers,
  onSwitch,
}: {
  profile: string;
  others: OtherProfiles;
  leaving?: string;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The profile the owner picked while something was left behind here, and what, until they say whether to go. Kept
  // as asked, so the question stays if the reply finishes meanwhile.
  const [asking, setAsking] = useState<{ to: string; note: string }>();
  const button = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<string[]>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(undefined);
    onCheckOthers();
    onListProfiles().then(
      (names) => current && setProfiles(names),
      (e) => current && setError(`Couldn't list profiles: ${e instanceof Error ? e.message : String(e)}`),
    );
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || close();
    window.addEventListener("mousedown", onDown);
    return () => {
      current = false;
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const elsewhere = totalUnread(others).unread > 0;
  const close = () => {
    setOpen(false);
    setAsking(undefined);
  };
  // The options are gone once the question shows, so focus goes back to the switcher.
  const answer = (go: boolean) => {
    const to = asking?.to;
    close();
    button.current?.focus();
    if (go && to) onSwitch(to);
  };
  const pick = (name: string) => {
    if (name === profile) close();
    else if (leaving) setAsking({ to: name, note: leaving });
    else {
      close();
      onSwitch(name);
    }
  };

  return (
    <div className="profile-switch" ref={box}>
      <button ref={button} className="profile-btn" title={switcherTip(others)} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="profile-name">{profile}</span>
        {elsewhere && <span className="dot" aria-label="Unread chats in other profiles" />}
        <ChevronDown size={14} className="profile-chev" />
      </button>
      {open && asking && <LeaveProfile note={asking.note} to={asking.to} onGo={() => answer(true)} onStay={() => answer(false)} />}
      {open && !asking && <ProfileMenu profile={profile} profiles={profiles} error={error} others={others} onPick={pick} onClose={close} />}
    </div>
  );
}

/** Asks before switching to `to` while something is left behind. Stay has focus, so a stray Enter stays. */
function LeaveProfile({ note, to, onGo, onStay }: { note: string; to: string; onGo: () => void; onStay: () => void }) {
  const noteId = useId();
  return (
    <div
      className="profile-menu"
      role="alertdialog"
      aria-label={`Switch to ${to}?`}
      aria-describedby={noteId}
      onKeyDown={(e) => e.key === "Escape" && !composing(e) && onStay()}
    >
      <div className="confirm profile-leave">
        <span id={noteId}>{note}</span>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            Stay
          </button>
          <button className="btn primary" onClick={onGo}>
            Switch anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A switch of profile under way, until the new profile's list is read: connecting, then loading its chats. If that
 * fails it says why, and offers to try again or go back to the profile the owner came from.
 */
function SwitchStatus({
  profile,
  switching,
  status,
  onRetry,
  onBack,
}: {
  profile: string;
  switching: NonNullable<Snapshot["switching"]>;
  status: ConnectionStatus;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className={`switch-status ${switching.error ? "failed" : ""}`} role="status" aria-label="Switching profile">
      {switching.error ? (
        <>
          <span>
            Couldn't open {profile}: {switching.error}
          </span>
          <div className="switch-actions">
            <button className="btn" onClick={onRetry}>
              Try again
            </button>
            <button className="btn" onClick={onBack}>
              Back to {switching.from}
            </button>
          </div>
        </>
      ) : (
        <span className="switch-progress">
          <Spinner />
          {status === "connected" ? `Loading ${profile}'s chats…` : `Connecting to ${profile}…`}
        </span>
      )}
    </div>
  );
}

/** The open profile menu. Closing it puts focus back on the profile button. */
function ProfileMenu({
  profile,
  profiles,
  error,
  others,
  onPick,
  onClose,
}: {
  profile: string;
  profiles?: string[];
  error?: string;
  others: OtherProfiles;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  useReturnFocus();

  const shown = (profiles ?? [profile]).filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div
      className="profile-menu"
      role="listbox"
      aria-label="Profiles"
      // Escape closes it from the filter or from an option the owner tabbed to.
      onKeyDown={(e) => e.key === "Escape" && !composing(e) && onClose()}
    >
      <input
        className="profile-filter"
        autoFocus
        placeholder="Filter profiles"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && shown[0] && onPick(shown[0])}
      />
      <div className="profile-options">
        {shown.map((p) => (
          <button
            key={p}
            role="option"
            aria-selected={p === profile}
            title={p === profile ? undefined : otherTip(others.byName[p])}
            className={`profile-option ${p === profile ? "on" : ""}`}
            onClick={() => onPick(p)}
          >
            <span className="row-title">{p}</span>
            {p === profile ? <Check size={14} /> : <OtherBadge info={others.byName[p]} />}
          </button>
        ))}
        {!profiles && !error && <div className="profile-hint">Loading profiles…</div>}
        {profiles && shown.length === 0 && <div className="profile-hint">No profile matches.</div>}
        {error && <div className="profile-hint err">{error}</div>}
      </div>
      {others.error && <div className="profile-hint err">{others.error}</div>}
      {profiles && profiles.length > 1 && (
        <div className="profile-hint">
          Unread checked every {CHECK_EVERY_MS / 60_000} min{others.checkedAt ? `, last ${ago(others.checkedAt)}` : ""}
        </div>
      )}
    </div>
  );
}

/** Up and Down move focus between the chats in the list, top to bottom through its sections, without opening them. */
function moveBetweenChats(e: KeyboardEvent<HTMLElement>) {
  // Alt+arrows open the chat above or below instead (App.tsx), so they pass.
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || !(e.target as Element).classList.contains("row-open")) return;
  e.preventDefault();
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".row-open")).filter((r) => !r.closest("[hidden]"));
  rows[rows.indexOf(e.target as HTMLButtonElement) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/**
 * The chat list, in sections (snooze.ts `chatSections`): first, unlabeled, the chats that need the owner or are done;
 * then Working, the chats Hermes is replying in; then Snoozed, collapsed; and Settled, a drawer at the foot. The
 * first three are one list of rows and headings, so a row that moves between them, as a reply starts or ends, keeps
 * its menu, rename box and focus. The Custom snooze dialog belongs to the list, not a row, for the same reason.
 * `archivedListed`: it shows the profile's archived chats instead.
 * `projectSwitcher` sits under the profile's name; `chats` are only the shown project's when one is picked there.
 * `projectsOf`: the projects a chat's menu offers to put it in or take it out of.
 */
export function ChatList({
  profile,
  projectSwitcher,
  savedFilters,
  projectsOf,
  tagsOf,
  switching,
  status,
  others,
  chats,
  archivedListed,
  syncError,
  selectedId,
  alsoShownId = null,
  split = false,
  onOpen,
  onOpenIn = () => {},
  onOpenTab = () => {},
  onSettle,
  snoozes = {},
  attentionSince,
  onSnooze,
  onWake,
  onArchive,
  onListArchived,
  onDelete,
  onRename,
  onRegenTitle,
  onCopyLink,
  onTextGenerationSettings,
  onListProfiles,
  onCheckOthers,
  onSwitchProfile,
  onRetrySwitch,
  onNew,
  onSearch,
}: {
  profile: string;
  projectSwitcher?: ReactNode;
  /** The profile's Saved filters (Tags.tsx), under the project switcher. */
  savedFilters?: ReactNode;
  projectsOf?: (chatId: string) => ChatProjects | undefined;
  tagsOf?: (chatId: string) => ChatTags | undefined;
  switching?: Snapshot["switching"];
  status: ConnectionStatus;
  others: OtherProfiles;
  chats: Chat[];
  archivedListed: boolean;
  syncError?: string;
  /** The chat in the active pane. */
  selectedId: string | null;
  /** The chat in the other pane, when there are two. */
  alsoShownId?: string | null;
  split?: boolean;
  onOpen: (id: string) => void;
  /** Opens a chat in the left (0) or right (1) pane, opening the right one if there is one pane. */
  onOpenIn?: (id: string, side: number) => void;
  /** Opens a chat in a new tab of the active pane. */
  onOpenTab?: (id: string) => void;
  onSettle: (id: string, settled: boolean) => void;
  /** When each snoozed chat wakes (snooze.ts). */
  snoozes?: Snoozes;
  /** When each chat last stopped working, so the top lists it as new then (snooze.ts `AttentionClock`). */
  attentionSince?: Readonly<Record<string, number>>;
  onSnooze?: (id: string, until: number) => void;
  onWake?: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onListArchived: (on: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string, from: string) => Promise<unknown>;
  onRegenTitle: (id: string) => Promise<unknown>;
  /** Copies a chat's link (chatLinks.ts). */
  onCopyLink?: (chat: Chat) => void;
  /** Opens Settings → Model at the Text generation model, the model titles are made with. */
  onTextGenerationSettings?: () => void;
  onListProfiles: () => Promise<string[]>;
  onCheckOthers: () => void;
  onSwitchProfile: (name: string) => void;
  onRetrySwitch: () => void;
  /** The list's own New chat and Search buttons, labeled with their keys; the rail keeps icons for both. */
  onNew?: () => void;
  onSearch?: () => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  // The chat whose Custom snooze dialog is open.
  const [customFor, setCustomFor] = useState<Chat>();
  // The chat the Delete question is open for, and what had focus when it was asked.
  const [deleting, setDeleting] = useState<{ chat: Chat; from: HTMLElement | null }>();
  const deletingGone = !!deleting && !chats.some((c) => c.id === deleting.chat.id && !c.running);
  // Re-sorts the list when the next snooze wakes.
  const now = useSnoozeClock(snoozes);
  const { top, working, snoozed, settled, archived } = chatSections(chats, snoozes, now, attentionSince);
  // The dialog closes if its chat leaves the list, or is settled or archived meanwhile (in another window or client).
  const customGone = !!customFor && !chats.some((c) => c.id === customFor.id && !c.settled && !c.archived);
  useEffect(() => {
    if (customGone) setCustomFor(undefined);
  }, [customGone]);
  useEffect(() => {
    if (deletingGone) setDeleting(undefined);
  }, [deletingGone]);
  // Opening a Settled or Snoozed chat, say from a search, shows it in the list; settling or snoozing the chat on
  // screen doesn't.
  const selectedSettled = settled.some((c) => c.id === selectedId);
  const selectedSnoozed = snoozed.some((c) => c.id === selectedId);
  useEffect(() => {
    if (selectedSettled) setSettledOpen(true);
    if (selectedSnoozed) setSnoozedOpen(true);
  }, [selectedId]);
  const settledUnread = settled.filter((c) => c.unread).length;
  const snoozedUnread = snoozed.filter((c) => c.unread).length;
  const row = (c: Chat, section?: string, hidden?: boolean) => (
    <ChatRow
      key={c.id}
      section={section}
      hidden={hidden}
      chat={c}
      selected={c.id === selectedId}
      alsoShown={c.id === alsoShownId && c.id !== selectedId}
      split={split}
      onOpen={() => onOpen(c.id)}
      onOpenIn={(side) => onOpenIn(c.id, side)}
      onOpenTab={() => onOpenTab(c.id)}
      onSettle={(s) => onSettle(c.id, s)}
      onArchive={(a) => onArchive(c.id, a)}
      onAskDelete={(from) => setDeleting({ chat: c, from })}
      onRename={(title, from) => onRename(c.id, title, from)}
      onRegenTitle={() => onRegenTitle(c.id)}
      onCopyLink={onCopyLink && (() => onCopyLink(c))}
      onTextGenerationSettings={onTextGenerationSettings}
      projects={projectsOf?.(c.id)}
      tags={tagsOf?.(c.id)}
      snooze={
        onSnooze && onWake && !c.settled && !c.archived
          ? { until: snoozes[c.id], onSnooze: (until) => onSnooze(c.id, until), onCustom: () => setCustomFor(c), onWake: () => onWake(c.id) }
          : undefined
      }
    />
  );
  return (
    <aside className="sidebar" onKeyDown={moveBetweenChats}>
      <div className="sb-head">
        <ProfileSwitcher
          profile={profile}
          others={others}
          leaving={leavingNote(profile, chats)}
          onListProfiles={onListProfiles}
          onCheckOthers={onCheckOthers}
          onSwitch={onSwitchProfile}
        />
        <button
          className={`icon-btn ${archivedListed ? "on" : ""}`}
          title={archivedListed ? "Back to the chat list" : "Archived chats"}
          aria-pressed={archivedListed}
          onClick={() => onListArchived(!archivedListed)}
        >
          <EyeOff size={16} />
        </button>
      </div>
      {(onNew || onSearch) && (
        <div className="sb-actions">
          {onNew && (
            <button className="sb-action primary" onClick={onNew}>
              <SquarePen size={15} />
              <span>New chat</span>
              <kbd aria-hidden>Ctrl N</kbd>
            </button>
          )}
          {onSearch && (
            <button className="sb-action" onClick={onSearch}>
              <Search size={15} />
              <span>Search chats</span>
              <kbd aria-hidden>Ctrl K</kbd>
            </button>
          )}
        </div>
      )}
      {projectSwitcher && <div className="sb-project">{projectSwitcher}</div>}
      <div className="sb-scroll">
        {switching && (
          <SwitchStatus profile={profile} switching={switching} status={status} onRetry={onRetrySwitch} onBack={() => onSwitchProfile(switching.from)} />
        )}
        {savedFilters}
        {syncError && !switching?.error && (
          <div className="sync-error" role="status">
            {syncError}
          </div>
        )}
        {archivedListed ? (
          <>
            <div className="section-label">Archived</div>
            {archived.length ? archived.map((c) => row(c)) : <div className="empty-hint">No archived chats.</div>}
          </>
        ) : (
          // One keyed array, so React keeps a row that moves from one section to another.
          [
            ...top.map((c) => row(c, "top")),
            !top.length && (
              <div key="empty" className="empty-hint">
                {working.length || snoozed.length ? "Nothing needs you right now." : "Nothing needs you. Start a new chat."}
              </div>
            ),
            working.length > 0 && (
              <div key="working" className="section-label">
                Working <span className="count">{working.length}</span>
              </div>
            ),
            ...working.map((c) => row(c, "working")),
            snoozed.length > 0 && (
              <button key="snoozed" className="section-toggle" aria-expanded={snoozedOpen} onClick={() => setSnoozedOpen((o) => !o)}>
                <ChevronRight size={14} className={`chev ${snoozedOpen ? "open" : ""}`} />
                Snoozed
                <span className="count">{snoozed.length}</span>
                {snoozedUnread > 0 && !snoozedOpen && <span className="dot" title={`${snoozedUnread} unread`} />}
              </button>
            ),
            // Kept while collapsed, hidden, so a row snoozed meanwhile (from another window) keeps its rename box.
            ...snoozed.map((c) => row(c, "snoozed", !snoozedOpen)),
          ]
        )}
      </div>
      {/* Settled is pinned to the foot of the list and opens upward as a drawer with its own scroll. */}
      {!archivedListed && (
        <div className={`settled-section ${settledOpen ? "open" : ""}`}>
          <button className="section-toggle" aria-expanded={settledOpen} onClick={() => setSettledOpen((o) => !o)}>
            <ChevronRight size={14} className={`chev ${settledOpen ? "open" : ""}`} />
            Settled
            <span className="count">{settled.length}</span>
            {settledUnread > 0 && !settledOpen && <span className="dot" title={`${settledUnread} unread`} />}
          </button>
          {settledOpen && <div className="settled-list">{settled.map((c) => row(c, "settled"))}</div>}
        </div>
      )}
      {customFor && !customGone && (
        <SnoozeDialog
          title={customFor.title}
          returnTo={{
            get current() {
              return document.querySelector<HTMLElement>(`.row-open[data-chat="${CSS.escape(customFor.id)}"]`);
            },
          }}
          onClose={() => setCustomFor(undefined)}
          onSnooze={(until) => {
            setCustomFor(undefined);
            onSnooze?.(customFor.id, until);
          }}
        />
      )}
      {deleting && !deletingGone && (
        <DeleteChatDialog
          title={deleting.chat.title}
          returnTo={{
            get current() {
              return deleting.from?.isConnected ? deleting.from : document.querySelector<HTMLElement>(`.row-open[data-chat="${CSS.escape(deleting.chat.id)}"]`);
            },
          }}
          onClose={() => setDeleting(undefined)}
          onDelete={() => {
            setDeleting(undefined);
            onDelete(deleting.chat.id);
          }}
        />
      )}
    </aside>
  );
}
