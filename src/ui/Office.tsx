// The agent office (ADR 0077): every agent at work on this connection as a desk, in one room per chat, the same desks
// as a list, or each agent as a character at its desk in one shared room (ADR 0083). It opens from the rail beside the
// chat list, like the Inbox. A desk opens what it stands for: the chat's reply opens the chat, at its Approval card or
// failure, and a subagent opens in the chat's Subagents panel. Nothing here answers, approves, retries or starts
// anything. App draws it only while it is open and the window can be seen.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleStop, Clock, Coffee, LayoutGrid, List, Loader, ShieldAlert, Users, X } from "lucide-react";
import { officeTally, type Desk, type DeskState, type Room } from "../hermes/office";
import type { OfficeView } from "../hermes/uiPrefs";
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
  view: Exclude<OfficeView, "off">;
  onView: (view: Exclude<OfficeView, "off">) => void;
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
  // or Close, rather than to the page, where the office's keys don't reach. Where the desk with focus is, is read
  // again after every change, since desks before it can go or move while it stays.
  const lastDesk = useRef<{ key: string; index: number }>(undefined);
  const remember = (all: HTMLButtonElement[], at: number) => {
    if (at >= 0) lastDesk.current = { key: all[at].dataset.desk!, index: at };
  };
  useEffect(() => {
    const all = desks();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at >= 0) return remember(all, at);
    const was = lastDesk.current;
    if (!was || (document.activeElement && document.activeElement !== document.body)) return;
    (all.find((d) => d.dataset.desk === was.key) ?? all[Math.min(was.index, all.length - 1)] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus();
  });
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const all = desks();
    remember(all, all.indexOf(e.target as HTMLButtonElement));
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
          <button type="button" aria-pressed={view === "scene"} onClick={() => onView("scene")}>
            <Users size={13} aria-hidden /> Scene
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
      ) : view === "scene" ? (
        <div className="office-scene" data-motion={motion}>
          {rooms.map((r) => (
            <RoomScene key={r.key} room={r} profile={profile} moves={motion === "on"} onOpen={open} />
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

/** How a character sits for its desk's state: at work, asking the owner, done, failed, or not at work. */
type Pose = "typing" | "hand-up" | "done" | "slumped" | "idle";

const POSE: Record<DeskState, Pose> = {
  queued: "idle",
  running: "typing",
  approval: "hand-up",
  uncertain: "hand-up",
  failed: "slumped",
  completed: "done",
  unread: "idle",
  stopped: "idle",
  ended: "idle",
  unknown: "idle",
  idle: "idle",
};

/** Each pose as points in the character's 96 × 72 drawing: the two arms from the shoulders, the hands, the head. */
const FIGURE: Record<Pose, { arms: [string, string]; hands: [number, number][]; head: "ahead" | "down" | "on-desk"; armsBehind?: true; smile?: true }> = {
  typing: { arms: ["37,36 33,45 40,46", "59,36 63,45 56,46"], hands: [[40, 46], [56, 46]], head: "down" },
  "hand-up": { arms: ["37,36 33,45 40,46", "59,36 67,26 67,13"], hands: [[40, 46], [67, 11]], head: "ahead" },
  done: { arms: ["37,36 32,25 41,16", "59,36 64,25 55,16"], hands: [], head: "ahead", armsBehind: true, smile: true },
  slumped: { arms: ["37,36 35,45 47,46", "59,36 61,45 49,46"], hands: [], head: "on-desk" },
  idle: { arms: ["37,36 35,47", "59,36 61,47"], hands: [], head: "ahead" },
};

function Character({ pose }: { pose: Pose }) {
  const f = FIGURE[pose];
  const arms = f.arms.map((points) => <polyline key={points} className="sc-arm" points={points} />);
  const visorY = f.head === "down" ? 18 : 16.5;
  return (
    <svg className="seat-figure" viewBox="0 0 96 72" aria-hidden focusable="false">
      <rect className="sc-chair" x="32" y="22" width="32" height="30" rx="5" />
      {f.armsBehind && arms}
      <path className="sc-body" d="M35 48V38a10 10 0 0 1 10-8h6a10 10 0 0 1 10 8v10z" />
      {f.head !== "on-desk" && (
        <g>
          <line className="sc-antenna" x1="48" y1="11.5" x2="48" y2="7" />
          <circle className="sc-light" cx="48" cy="6" r="2" />
          <rect className="sc-head" x="39.5" y="11.5" width="17" height="16" rx="5" />
          <rect className="sc-visor" x="41.5" y={visorY} width="13" height="6" rx="3" />
          <circle className="sc-light" cx="45.5" cy={visorY + 3} r="1.2" />
          <circle className="sc-light" cx="50.5" cy={visorY + 3} r="1.2" />
          {f.smile && <path className="sc-mouth" d="M45.5 24.5q2.5 1.6 5 0" />}
        </g>
      )}
      <path className="sc-lid" d="M38 48l2-14h16l2 14z" />
      <circle className="sc-light" cx="48" cy="41" r="1.6" />
      {!f.armsBehind && arms}
      {f.hands.map(([x, y], i) => (
        <circle key={i} className="sc-head sc-hand" cx={x} cy={y} r="2.6" />
      ))}
      {f.head === "on-desk" && (
        <g>
          <line className="sc-antenna" x1="57" y1="41" x2="62" y2="45" />
          <circle className="sc-light" cx="63" cy="46" r="2" />
          <rect className="sc-head" x="38" y="35" width="20" height="13" rx="5" />
          <rect className="sc-visor" x="41" y="40" width="14" height="5" rx="2.5" />
          <path className="sc-cross" d="M44 41.5l2 2m0-2l-2 2M50 41.5l2 2m0-2l-2 2" />
        </g>
      )}
      <rect className="sc-desk" x="8" y="48" width="80" height="5" rx="1.5" />
      <rect className="sc-desk-front" x="13" y="53" width="70" height="17" rx="1" />
    </svg>
  );
}

/**
 * A chat's team as characters at their desks: its reply first, then each subagent after the one that started it, so a
 * team sits together. `moves`: the system allows motion; then only a running, current character types.
 */
function RoomScene({ room, profile, moves, onOpen }: { room: Room; profile: string; moves: boolean; onOpen: (room: Room, desk: Desk) => void }) {
  const nameId = useId();
  return (
    <section className="scene-team" aria-labelledby={nameId}>
      <RoomName room={room} profile={profile} id={nameId} />
      <ul className="scene-seats">
        {room.desks.map((d) => {
          const Icon = STATE_ICON[d.state];
          const parent = parentOf(room, d);
          const pose = POSE[d.state];
          return (
            <li key={d.key}>
              <button
                className={`seat state-${d.state}${d.stale ? " is-stale" : ""}${d.agent.kind === "reply" ? " is-reply" : ""}`}
                data-desk={d.key}
                data-pose={pose}
                data-moving={moves && d.state === "running" && !d.stale ? "" : undefined}
                aria-label={deskLabel(room, d, profile)}
                onClick={() => onOpen(room, d)}
              >
                <span className="seat-stage" aria-hidden>
                  <Character pose={pose} />
                  <span className="seat-badge">
                    <Icon size={12} />
                  </span>
                </span>
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
