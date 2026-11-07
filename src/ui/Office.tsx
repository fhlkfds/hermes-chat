// The agent office (ADR 0077, ADR 0089): every agent at work on this connection, as a 3D building with a room per state
// and a character per agent (OfficeBuilding.tsx), or as a list, one group per chat. It opens from the rail in place of
// the chat panes. An agent opens what it stands for: the chat's reply opens the chat, at its Approval card or failure,
// and a subagent opens in the chat's Subagents panel. Nothing here answers, approves, retries or starts anything. App
// mounts it only while it is open and the window can be seen.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react";
import { Building as BuildingIcon, List, X } from "lucide-react";
import { officeTally, type Desk, type Room } from "../hermes/office";
import type { OfficeView } from "../hermes/uiPrefs";
import { composing, relTime, useReturnFocus } from "./bits";
import { Building, type EngineLoad } from "./OfficeBuilding";
import { STATE_ICON, STATE_LABEL, deskLabel } from "./officeLabels";

export { STATE_LABEL, deskLabel } from "./officeLabels";

const reducedMotionQuery = () => (typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-reduced-motion: reduce)"));
const subscribeReducedMotion = (fn: () => void) => {
  const q = reducedMotionQuery();
  q?.addEventListener?.("change", fn);
  return () => q?.removeEventListener?.("change", fn);
};
/** Whether characters may move: not when the owner asks for reduced motion. While hidden, the office isn't drawn at all. */
function useMotion(): boolean {
  return !useSyncExternalStore(subscribeReducedMotion, () => !!reducedMotionQuery()?.matches);
}

/**
 * `rooms`: from `officeRooms`. `view`: the building or a list, the owner's choice, kept by the caller. `leaving`: what
 * switching away from the shown profile leaves behind, asked about before an agent in another profile opens. `load`:
 * makes the building's drawing; tests pass a stand-in, since jsdom has no WebGL.
 */
export function Office({
  rooms,
  view,
  onView,
  server,
  profile,
  connected,
  leaving,
  load,
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
  load?: EngineLoad;
  onOpen: (room: Room, desk: Desk) => void;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState<{ room: Room; desk: Desk }>();
  /** List shown for now, without changing the setting: from the "+N more" sign, or because the building can't be drawn. */
  const [listNow, setListNow] = useState(false);
  const [cannot, setCannot] = useState<string>();
  const shows = view === "list" || listNow || cannot ? "list" : "building";
  const root = useRef<HTMLElement>(null);
  const headId = useId();
  const motion = useMotion();
  useReturnFocus();

  const desks = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-desk]") ?? []);
  // Opening, and switching views, puts focus on the first agent, or on Close when there is none.
  useEffect(() => void (desks()[0] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus(), [shows]);
  // An agent with focus can go, as when its reply ends and its room with it, or its button can be redrawn, as when the
  // building moves it to another room. Focus then goes to the same agent, the one now in its place, or Close, rather
  // than to the page, where the office's keys don't reach. Focus the owner moved away (a click on the floor) stays put.
  const lastDesk = useRef<{ key: string; index: number; el: HTMLButtonElement }>(undefined);
  const remember = (all: HTMLButtonElement[], at: number) => {
    if (at >= 0) lastDesk.current = { key: all[at].dataset.desk!, index: at, el: all[at] };
  };
  useEffect(() => {
    const all = desks();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at >= 0) return remember(all, at);
    const was = lastDesk.current;
    if (!was || was.el.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    (all.find((d) => d.dataset.desk === was.key) ?? all[Math.min(was.index, all.length - 1)] ?? root.current?.querySelector<HTMLElement>(".office-close"))?.focus();
  });
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const all = desks();
    remember(all, all.indexOf(e.target as HTMLButtonElement));
  };
  // Focus that leaves an agent still on screen, as for a click on the floor, was moved by the owner: nothing to put
  // back later. Checked once the blur has settled, since an agent's button removed while focused loses focus too.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const left = e.target;
    if (!(left instanceof HTMLElement) || !left.dataset.desk) return;
    setTimeout(() => {
      if (left.isConnected && lastDesk.current?.el === left && document.activeElement !== left) lastDesk.current = undefined;
    }, 0);
  };

  const open = (room: Room, desk: Desk) => (room.profile !== profile && leaving ? setAsking({ room, desk }) : onOpen(room, desk));
  // Staying puts focus back on the agent the question came from.
  const stay = () => {
    const key = asking?.desk.key;
    setAsking(undefined);
    if (key) root.current?.querySelector<HTMLElement>(`[data-desk="${CSS.escape(key)}"]`)?.focus();
  };

  // The arrow keys, Home and End move between agents in reading order, in either view; Escape goes back to the chats.
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

  const pickView = (v: Exclude<OfficeView, "off">) => {
    setListNow(false);
    onView(v);
  };

  const { working, waiting, failed, desks: count } = officeTally(rooms);
  const tally = [working && `${working} running`, waiting && `${waiting} waiting for you`, failed && `${failed} failed`, `${count} agent${count === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <section ref={root} className="office" aria-labelledby={headId} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
      <header className="inbox-head office-head">
        <div className="inbox-heading">
          <h2 id={headId}>Office</h2>
          <span className="inbox-server" title="The server these agents run on">
            {server}
          </span>
          {rooms.length > 0 && <span className="inbox-note office-tally">{tally}</span>}
        </div>
        <div className="segmented office-views" role="group" aria-label="Show as">
          <button type="button" aria-pressed={shows === "building"} disabled={!!cannot} onClick={() => pickView("building")}>
            <BuildingIcon size={13} aria-hidden /> Building
          </button>
          <button type="button" aria-pressed={shows === "list"} onClick={() => pickView("list")}>
            <List size={13} aria-hidden /> List
          </button>
        </div>
        <button className="icon-btn office-close" title="Back to the chats (Escape)" aria-label="Close the office" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="inbox-fresh" role="status">
        {!connected && <div className="inbox-note err">Not connected to Hermes: every agent is as last seen.</div>}
        {cannot && <div className="inbox-note office-cannot">{cannot}</div>}
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
      {shows === "building" ? (
        <Building rooms={rooms} profile={profile} motion={motion} load={load} onOpen={open} onList={() => setListNow(true)} onCannot={setCannot} />
      ) : rooms.length === 0 ? (
        <div className="empty-hint inbox-empty">No agent is at work. One shows here while a reply runs, waits for you or failed, and for each subagent it starts.</div>
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

