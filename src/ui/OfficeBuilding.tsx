// The office as a building (ADR 0089): the floor of the profile shown, drawn by officeEngine.ts with three.js, and over
// it, in HTML, a button on each character. A character's button is its name tag (shown on hover or focus), its "!"
// while it waits for the owner, and what a screen reader and the keyboard reach, labelled as in List. Pressing one
// opens its card. three.js and the engine load only when this first mounts, as their own chunk.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { RotateCcw, X } from "lucide-react";
import { FLOOR_ROOM_NAME, floorLayout, type Desk, type FloorLayout, type FloorRoom, type Placement, type Room } from "../hermes/office";
import type { EngineAgent, EngineOptions, OfficeEngine, ScreenPoint, ScreenSpot } from "./officeEngine";
import { STATE_LABEL, deskLabel } from "./officeLabels";
import { relTime } from "./bits";

/** Makes the drawing, or says this computer can't (no WebGL). Tests pass a stand-in; the app loads three.js. */
export type EngineLoad = () => Promise<((o: EngineOptions) => OfficeEngine) | undefined>;

/** Whether this computer can draw the building at all. The context it opens to find out is let go at once. */
export function canDrawWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export const loadEngine: EngineLoad = async () => (canDrawWebGL() ? (await import("./officeEngine")).createOfficeEngine : undefined);

const subscribeFocus = (fn: () => void) => {
  window.addEventListener("focus", fn);
  window.addEventListener("blur", fn);
  return () => {
    window.removeEventListener("focus", fn);
    window.removeEventListener("blur", fn);
  };
};
/** Whether the window has the keyboard focus: the building draws nothing while it hasn't. */
const useWindowFocused = () => useSyncExternalStore(subscribeFocus, () => document.hasFocus());

const modeNow = (): "light" | "dark" => (document.documentElement.dataset.mode === "light" ? "light" : "dark");
const bgNow = () => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || undefined;

const isWaiting = (d: Desk) => d.state === "approval" || d.state === "uncertain";

/** How long an agent has run: its whole run once Hermes says it ended, else since it started while it still runs. */
function ranFor(d: Desk, now: number): string | undefined {
  const a = d.about;
  const live = (d.state === "running" || d.state === "approval" || d.state === "uncertain") && !d.stale;
  const secs = a?.durationS ?? (a?.startedAt && live ? (now - a.startedAt) / 1000 : undefined);
  if (secs === undefined || secs < 0) return undefined;
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`;
  return `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`;
}

export function Building({
  rooms,
  profile,
  motion,
  load = loadEngine,
  onOpen,
  onList,
  onCannot,
}: {
  rooms: Room[];
  profile: string;
  motion: boolean;
  load?: EngineLoad;
  onOpen: (room: Room, desk: Desk) => void;
  /** Show List instead, as the "+N more" sign does. */
  onList: () => void;
  /** This computer can't draw the building, and why. */
  onCannot: (why: string) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<OfficeEngine>(undefined);
  const [ready, setReady] = useState(false);
  const buttons = useRef(new Map<string, HTMLElement>());
  const labels = useRef(new Map<FloorRoom, HTMLElement>());
  const door = useRef<HTMLButtonElement>(null);
  const counter = useRef<HTMLSpanElement>(null);
  const [showFrames, setShowFrames] = useState(false);
  const [picked, setPicked] = useState<string>();
  const focused = useWindowFocused();

  // The layout keeps each working agent's desk and each team's color from the one before.
  const last = useRef<FloorLayout>(undefined);
  const layout = useMemo(() => (last.current = floorLayout(rooms, profile, last.current)), [rooms, profile]);
  const agents: EngineAgent[] = useMemo(
    () => layout.placed.map((p) => ({ key: p.desk.key, floorRoom: p.floorRoom, spot: p.spot, ...(p.door && { door: true }), team: p.team, state: p.desk.state, stale: !!p.desk.stale })),
    [layout],
  );

  // Where the drawing says each character, room name and the door are, applied straight to the HTML over it: moving the
  // camera re-renders nothing in React. Placed is `data-placed`, an attribute React never writes, so a re-render that
  // changes a button's class (picking it, a new state) can't unplace it.
  const project = (spots: ScreenSpot[], roomsAt: Record<FloorRoom, ScreenPoint>, doorAt: ScreenPoint) => {
    for (const s of spots) {
      const el = buttons.current.get(s.key);
      if (!el) continue;
      el.style.transform = `translate(${Math.round(s.x - s.w / 2)}px, ${Math.round(s.y)}px)`;
      el.style.width = `${Math.round(s.w)}px`;
      el.style.height = `${Math.round(s.h)}px`;
      el.toggleAttribute("data-placed", !s.hidden);
    }
    for (const [k, p] of Object.entries(roomsAt) as [FloorRoom, ScreenPoint][]) {
      const el = labels.current.get(k);
      if (!el) continue;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
      el.toggleAttribute("data-placed", !p.hidden);
    }
    if (door.current) {
      door.current.style.transform = `translate(${Math.round(doorAt.x)}px, ${Math.round(doorAt.y)}px) translate(-50%, -50%)`;
      door.current.toggleAttribute("data-placed", !doorAt.hidden);
    }
  };
  const projectRef = useRef(project);
  projectRef.current = project;

  // Start the drawing once, and stop it for good when the office closes.
  useEffect(() => {
    let gone = false;
    let made: OfficeEngine | undefined;
    load().then(
      (create) => {
        if (gone) return;
        if (!create) return onCannot("This computer can't draw the building (no WebGL), so the office shows List.");
        try {
          made = create({
            canvas: canvas.current!,
            surface: surface.current!,
            onProject: (a, r, d) => projectRef.current(a, r, d),
            onFrame: (n) => {
              surface.current?.setAttribute("data-frames", String(n));
              if (counter.current) counter.current.dataset.total = String(n);
            },
          });
        } catch (e) {
          return onCannot(`The building couldn't be drawn (${e instanceof Error ? e.message : String(e)}), so the office shows List.`);
        }
        engine.current = made;
        setReady(true);
      },
      (e) => !gone && onCannot(`The building couldn't load (${e instanceof Error ? e.message : String(e)}), so the office shows List.`),
    );
    return () => {
      gone = true;
      made?.dispose();
      engine.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => engine.current?.setActive(focused), [ready, focused]);
  useEffect(() => engine.current?.setMotion(motion), [ready, motion]);
  useEffect(() => engine.current?.setAgents(agents), [ready, agents]);
  useEffect(() => {
    if (!ready) return;
    const apply = () => engine.current?.setTheme(modeNow(), bgNow());
    apply();
    const themed = new MutationObserver(apply);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode", "class"] });
    return () => themed.disconnect();
  }, [ready]);

  // The frame counter, for proving the budget: total frames, and how many in the last second, read once a second.
  useEffect(() => {
    if (!showFrames) return;
    let before = engine.current?.frames ?? 0;
    const tick = () => {
      const now = engine.current?.frames ?? 0;
      if (counter.current) counter.current.textContent = `${now} frames · ${now - before} in the last second`;
      before = now;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [showFrames, ready]);

  const pick = (key: string) => {
    if (engine.current?.dragged()) return;
    setPicked(key);
  };
  const shown = picked ? layout.placed.find((p) => p.desk.key === picked) : undefined;
  useEffect(() => {
    if (picked && !shown) setPicked(undefined);
  }, [picked, shown]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && picked) {
      e.stopPropagation();
      const key = picked;
      setPicked(undefined);
      surface.current?.querySelector<HTMLElement>(`[data-desk="${CSS.escape(key)}"]`)?.focus();
    } else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) setShowFrames((s) => !s);
  };

  // Buttons in the order a screen reader reads the rooms: who needs the owner first.
  const byRoom = (["waiting", "trouble", "workroom", "lounge"] as FloorRoom[]).map((k) => [k, layout.placed.filter((p) => p.floorRoom === k)] as const);

  return (
    <div ref={surface} className="bld" data-frames="0" onKeyDown={onKeyDown}>
      <canvas ref={canvas} className="bld-canvas" aria-hidden />
      <div className="bld-labels" aria-hidden>
        {(Object.keys(FLOOR_ROOM_NAME) as FloorRoom[]).map((k) => (
          <span
            key={k}
            className={`bld-room-name room-${k}`}
            ref={(el) => {
              if (el) labels.current.set(k, el);
              else labels.current.delete(k);
            }}
          >
            {FLOOR_ROOM_NAME[k]}
            {layout.counts[k] > 0 && <b>{layout.counts[k]}</b>}
          </span>
        ))}
      </div>
      {byRoom.map(([k, placed]) =>
        placed.length ? (
          <ul key={k} className="bld-agents" aria-label={FLOOR_ROOM_NAME[k]}>
            {placed.map((p) => (
              <li key={p.desk.key}>
                <AgentButton
                  p={p}
                  profile={profile}
                  picked={picked === p.desk.key}
                  onPick={pick}
                  bind={(el) => {
                    if (el) buttons.current.set(p.desk.key, el);
                    else buttons.current.delete(p.desk.key);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null,
      )}
      {layout.more > 0 && (
        <button ref={door} className="bld-more" onClick={onList} title="Show every agent in List">
          +{layout.more} more
        </button>
      )}
      <div className="bld-tools" data-camera-ignore>
        {layout.elsewhere > 0 && (
          <button className="btn bld-elsewhere" onClick={onList} title="Agents in other profiles show in List">
            {layout.elsewhere} in other profiles
          </button>
        )}
        <button className="icon-btn bld-reset" title="Reset the view" aria-label="Reset the view" onClick={() => engine.current?.resetView()}>
          <RotateCcw size={15} />
        </button>
      </div>
      {showFrames && <span ref={counter} className="bld-frames" role="status" />}
      {layout.placed.length === 0 && <div className="bld-empty">No agent is on this floor. A character comes in while a reply runs, waits for you or failed, and for each subagent it starts.</div>}
      {shown && <Card p={shown} profile={profile} onOpen={onOpen} onClose={() => setPicked(undefined)} />}
    </div>
  );
}

function AgentButton({ p, profile, picked, onPick, bind }: { p: Placement; profile: string; picked: boolean; onPick: (key: string) => void; bind: (el: HTMLElement | null) => void }) {
  const d = p.desk;
  return (
    <button
      ref={bind}
      className={`bld-agent state-${d.state} team-${p.team}${d.stale ? " is-stale" : ""}${picked ? " is-picked" : ""}`}
      data-desk={d.key}
      aria-label={deskLabel(p.room, d, profile)}
      aria-haspopup="dialog"
      aria-expanded={picked}
      onClick={() => onPick(d.key)}
    >
      <span className="bld-tag" aria-hidden>
        <i className="bld-dot" />
        <span className="bld-tag-name">{d.name}</span>
        {d.stale && <span className="bld-tag-stale">as last seen</span>}
      </span>
      {isWaiting(d) && (
        <span className="bld-bang" aria-hidden>
          !
        </span>
      )}
    </button>
  );
}

/** A character's card: what the app knows about the agent, kept up to date while open, and Open chat. */
function Card({ p, profile, onOpen, onClose }: { p: Placement; profile: string; onOpen: (room: Room, desk: Desk) => void; onClose: () => void }) {
  const d = p.desk;
  const running = !!d.about?.startedAt && d.about.durationS === undefined && !d.stale && (d.state === "running" || d.state === "approval" || d.state === "uncertain");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const ran = ranFor(d, now);
  const rows: [string, string | undefined][] = [
    ["Chat", p.room.title],
    ["Profile", p.room.profile],
    ["State", `${STATE_LABEL[d.state]}${d.stale ? ", as last seen" : ""}`],
    ["Goal", d.about?.goal],
    ["Doing now", d.doing ? `${d.doing.text}${d.doing.at ? ` (${relTime(d.doing.at) === "now" ? "just now" : `${relTime(d.doing.at)} ago`})` : ""}` : undefined],
    ["Model", d.about?.model],
    ["Has run", ran],
  ];
  return (
    <aside className={`bld-card team-${p.team}`} role="dialog" aria-label={d.name} data-camera-ignore>
      <header className="bld-card-head">
        <h3>{d.name}</h3>
        <button className="icon-btn" aria-label="Close the card" title="Close (Escape)" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <dl>
        {rows
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, val]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
      </dl>
      {d.stale && <p className="bld-card-note">{d.stale}</p>}
      <button className="btn primary" autoFocus onClick={() => onOpen(p.room, d)}>
        Open chat
      </button>
      {p.room.profile !== profile && <p className="bld-card-note">Opens in profile {p.room.profile}.</p>}
    </aside>
  );
}
