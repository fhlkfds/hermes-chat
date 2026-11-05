// The agent office (ADR 0077): every agent at work on this connection as a desk, in one room per chat, or the same desks
// as a list. It opens from the rail beside the chat list, like the Inbox. A desk opens what it stands for: the chat's
// reply opens the chat, at its Approval card or failure, and a subagent opens in the chat's Subagents panel. Nothing here
// answers, approves, retries or starts anything. App draws it only while it is open and the window can be seen.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleStop, Clock, Coffee, LayoutGrid, List, Loader, ShieldAlert, X } from "lucide-react";
import { officeTally, type Desk, type DeskState, type Room } from "../hermes/office";
import { composing, relTime, useReturnFocus } from "./bits";

export const STATE_LABEL: Record<DeskState, string> = {
  queued: "Queued",
  running: "Running",
  approval: "Waiting for your approval",
  failed: "Failed",
  uncertain: "May not have sent",
  completed: "Finished",
  unread: "New, not read yet",
  stopped: "Stopped",
  ended: "Ended, Hermes didn't say how",
  unknown: "Not known yet",
  idle: "Not running",
};

const STATE_ICON: Record<DeskState, typeof X> = {
  queued: Clock,
  running: Loader,
  approval: ShieldAlert,
  failed: CircleAlert,
  uncertain: CircleHelp,
  completed: CircleCheck,
  unread: CircleDot,
  stopped: CircleStop,
  ended: CircleDashed,
  unknown: CircleHelp,
  idle: Coffee,
};

const reducedMotionQuery = () => (typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-reduced-motion: reduce)"));
const subscribeReducedMotion = (fn: () => void) => {
  const q = reducedMotionQuery();
  q?.addEventListener?.("change", fn);
  return () => q?.removeEventListener?.("change", fn);
};
/** Whether the desks may move: not when the owner asks for reduced motion. While hidden, the office isn't drawn at all. */
function useMotion(): "on" | "still" {
  return useSyncExternalStore(subscribeReducedMotion, () => !!reducedMotionQuery()?.matches) ? "still" : "on";
}

/** The subagent that started a subagent's desk, when it has a desk in the room too. */
function parentOf(room: Room, d: Desk): Desk | undefined {
  const id = d.agent.kind === "subagent" ? d.agent.parent : undefined;
  return id && room.desks.find((p) => p.agent.kind === "subagent" && p.agent.id === id);
}

/** What a desk says to a screen reader, and the same in either view. */
export function deskLabel(room: Room, d: Desk, profile: string): string {
  const parent = parentOf(room, d);
  const where = `${parent ? `started by “${parent.name}”, ` : ""}in “${room.title}”${room.profile === profile ? "" : `, profile ${room.profile}`}`;
  return [`${d.name}, ${STATE_LABEL[d.state]}${d.stale ? ", as last seen" : ""}, ${where}.`, d.doing?.text, d.stale].filter(Boolean).join(" ");
}

/**
 * `rooms`: from `officeRooms`. `view`: desks or a list, the owner's choice, kept by the caller. `leaving`: what switching
 * away from the shown profile leaves behind, asked about before a desk in another profile opens.
 */
export function Office({
  rooms,
  view,
  onView,
  server,
  profile,
  connected,
  leaving,
  onOpen,
  onClose,
}: {
  rooms: Room[];
  view: "desks" | "list";
  onView: (view: "desks" | "list") => void;
  server: string;
  profile: string;
  connected: boolean;
  leaving?: string;
  onOpen: (room: Room, desk: Desk) => void;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState<{ room: Room; desk: Desk }>();
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  const motion = useMotion();
  useReturnFocus();

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target;
      if (at instanceof Node && !root.current?.contains(at) && !(at instanceof Element && at.closest(".office-btn"))) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  const desks = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-desk]") ?? []);
  // Opening, and switching views, puts focus on the first desk, or on Close when there is none.
  useEffect(() => void (desks()[0] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus(), [view]);
  // A desk with focus can go, as when its reply ends and its room with it. Focus then goes to the desk now in its place,
  // or Close, rather than to the page, where the office's keys don't reach.
  const lastDesk = useRef<{ key: string; index: number }>(undefined);
  useEffect(() => {
    const was = lastDesk.current;
    if (!was || (document.activeElement && document.activeElement !== document.body)) return;
    const all = desks();
    (all.find((d) => d.dataset.desk === was.key) ?? all[Math.min(was.index, all.length - 1)] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus();
  });
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const key = e.target instanceof HTMLElement ? e.target.dataset.desk : undefined;
    if (key) lastDesk.current = { key, index: desks().indexOf(e.target as HTMLButtonElement) };
  };

  const open = (room: Room, desk: Desk) => (room.profile !== profile && leaving ? setAsking({ room, desk }) : onOpen(room, desk));
  // Staying puts focus back on the desk the question came from.
  const stay = () => {
    const key = asking?.desk.key;
    setAsking(undefined);
    if (key) root.current?.querySelector<HTMLElement>(`[data-desk="${CSS.escape(key)}"]`)?.focus();
  };

  // The arrow keys, Home and End move between desks in reading order, in either view; Escape closes.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (asking) stay();
      else onClose();
      return;
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    const all = desks();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    (e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : all[at + step!])?.focus();
  };

  const { working, waiting, failed, desks: count } = officeTally(rooms);
  const tally = [working && `${working} running`, waiting && `${waiting} waiting for you`, failed && `${failed} failed`, `${count} desk${count === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <section ref={root} className="inbox office" role="dialog" aria-labelledby={headId} onKeyDown={onKeyDown} onFocus={onFocus}>
      <header className="inbox-head">
        <div className="inbox-heading">
          <h2 id={headId}>Office</h2>
          <span className="inbox-server" title="The server these agents run on">
            {server}
          </span>
        </div>
        <div className="segmented office-views" role="group" aria-label="Show as">
          <button type="button" aria-pressed={view === "desks"} onClick={() => onView("desks")}>
            <LayoutGrid size={13} aria-hidden /> Desks
          </button>
          <button type="button" aria-pressed={view === "list"} onClick={() => onView("list")}>
            <List size={13} aria-hidden /> List
          </button>
        </div>
        <button className="icon-btn office-close" title="Close the office (Escape)" aria-label="Close the office" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="inbox-fresh" role="status">
        {rooms.length > 0 && <div className="inbox-note">{tally}</div>}
        {!connected && <div className="inbox-note err">Not connected to Hermes: every desk is as last seen.</div>}
      </div>
      {asking && (
        <div className="confirm inbox-leave" role="alertdialog" aria-label={`Switch to ${asking.room.profile}?`}>
          <span>{leaving}</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={stay}>
              Stay
            </button>
            <button className="btn primary" onClick={() => onOpen(asking.room, asking.desk)}>
              Switch to {asking.room.profile}
            </button>
          </div>
        </div>
      )}
      {rooms.length === 0 ? (
        <div className="empty-hint inbox-empty">No agent is at work. A desk shows here while a reply runs, waits for you or failed, and for each subagent it starts.</div>
      ) : view === "desks" ? (
        <div className="office-floor" data-motion={motion}>
          {rooms.map((r) => (
            <RoomDesks key={r.key} room={r} profile={profile} onOpen={open} />
          ))}
        </div>
      ) : (
        <ul className="inbox-list office-list" aria-label="Agents">
          {rooms.map((r) => (
            <RoomList key={r.key} room={r} profile={profile} onOpen={open} />
          ))}
        </ul>
      )}
      <p className="inbox-note office-foot">Subagents show for the chats opened on this connection since the app started.</p>
    </section>
  );
}

function RoomName({ room, profile, id }: { room: Room; profile: string; id: string }) {
  return (
    <h3 id={id} className="office-room-name">
      <span className="office-room-title">{room.title}</span>
      {room.profile !== profile && <span className="office-room-profile">{room.profile}</span>}
    </h3>
  );
}

function RoomDesks({ room, profile, onOpen }: { room: Room; profile: string; onOpen: (room: Room, desk: Desk) => void }) {
  const nameId = useId();
  return (
    <section className="office-room" aria-labelledby={nameId}>
      <RoomName room={room} profile={profile} id={nameId} />
      <ul className="office-desks">
        {room.desks.map((d) => {
          const Icon = STATE_ICON[d.state];
          const parent = parentOf(room, d);
          return (
            <li key={d.key}>
              <button
                className={`desk state-${d.state}${d.stale ? " is-stale" : ""}${d.agent.kind === "reply" ? " is-reply" : ""}`}
                data-desk={d.key}
                aria-label={deskLabel(room, d, profile)}
                onClick={() => onOpen(room, d)}
              >
                <span className="desk-screen" aria-hidden>
                  <Icon size={16} />
                  {d.state === "running" && !d.stale && (
                    <span className="desk-typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </span>
                <span className="desk-top" aria-hidden />
                <span className="desk-name">{d.name}</span>
                <span className="desk-state">
                  {STATE_LABEL[d.state]}
                  {d.stale && " · as last seen"}
                </span>
                {parent && <span className="desk-under">for {parent.name}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RoomList({ room, profile, onOpen }: { room: Room; profile: string; onOpen: (room: Room, desk: Desk) => void }) {
  const nameId = useId();
  return (
    <li className="office-list-room">
      <RoomName room={room} profile={profile} id={nameId} />
      <ul aria-labelledby={nameId}>
        {room.desks.map((d) => {
          const Icon = STATE_ICON[d.state];
          const depth = d.agent.kind === "subagent" ? d.agent.depth + 1 : 0;
          return (
            <li key={d.key} className={`inbox-row office-row state-${d.state}${d.stale ? " is-stale" : ""}`} style={{ paddingLeft: `${Math.min(depth, 4) * 12}px` }}>
              <button className="inbox-open" data-desk={d.key} aria-label={deskLabel(room, d, profile)} onClick={() => onOpen(room, d)}>
                <span className="inbox-line">
                  <span className="inbox-kind">
                    <Icon size={13} aria-hidden />
                    {STATE_LABEL[d.state]}
                    {d.stale && " · as last seen"}
                  </span>
                  {!!d.doing?.at && <span className="inbox-time">{relTime(d.doing.at) === "now" ? "now" : `${relTime(d.doing.at)} ago`}</span>}
                </span>
                <span className="inbox-title">{d.name}</span>
                {d.doing && <span className="inbox-summary">{d.doing.text}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
