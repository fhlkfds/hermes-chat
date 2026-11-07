// The office as a 3D building (ADR 0089): the canvas three.js draws on, the agents' name tags over it, and the card of
// the one picked. three.js loads with the scene (office3d/scene.ts) the first time this mounts, as its own chunk.
// Where everyone stands is officeFloor's to say; the scene only draws it. The tags are real buttons named as List
// names its rows, so the building and List read the same to a screen reader and the arrow keys move between them.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { RotateCcw } from "lucide-react";
import type { Desk, Room } from "../hermes/office";
import { EMPTY_FLOOR_MEMORY, TEAM_COLORS, officeFloor, type BuildingRoom, type Floor } from "../hermes/officeFloor";
import type { OfficeScene, ScreenPoint } from "./office3d/scene";
import { OfficeCard } from "./OfficeCard";
import { deskLabel } from "./officeText";
import { usePageHidden, useWindowFocused } from "./windowState";

const ROOM_NAME: Record<BuildingRoom, string> = { workroom: "Workroom", waiting: "Waiting room", trouble: "Trouble room", lounge: "Lounge" };

/** Why this computer can't draw the building, or undefined when it can. Asked before three.js is fetched. */
export function webglMissing(): string | undefined {
  if (typeof WebGLRenderingContext === "undefined") return "This computer's web view has no WebGL, which the building needs.";
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "This computer's graphics didn't offer WebGL, which the building needs.";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return undefined;
  } catch {
    return "This computer's graphics didn't offer WebGL, which the building needs.";
  }
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)");
const subscribeMotion = (fn: () => void) => {
  const q = reducedMotion();
  q?.addEventListener?.("change", fn);
  return () => q?.removeEventListener?.("change", fn);
};
const subscribeMode = (fn: () => void) => {
  const watch = new MutationObserver(fn);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => watch.disconnect();
};
const modeNow = () => (document.documentElement.dataset.mode === "light" ? "light" : "dark");

/** What changes the picture: who stands where, how, in which color. Text on the tags and the card changes no frame. */
const pictureOf = (f: Floor) => f.characters.map((c) => `${c.key}|${c.spot.x},${c.spot.z}|${c.pose}|${c.color}|${c.stale ? 1 : 0}`).join(";");

/** A tag's size on screen, measured once per tag and text: reading it every frame would lay the page out each time. */
const sizes = new WeakMap<HTMLElement, { text: string; w: number; h: number }>();
function tagSize(el: HTMLElement | undefined): { w: number; h: number } {
  if (!el) return { w: 0, h: 0 };
  const known = sizes.get(el);
  if (known && known.text === el.textContent) return known;
  const size = { text: el.textContent ?? "", w: el.offsetWidth, h: el.offsetHeight };
  sizes.set(el, size);
  return size;
}

/**
 * Tags that would cover each other, as a team's at one group of desks do from afar, lifted until they don't. A tag
 * sits centred above its point. The one lowest on screen, nearest the camera, stays where it is.
 */
export function unstacked(at: ReadonlyMap<string, ScreenPoint>, size: (key: string) => { w: number; h: number }): Map<string, ScreenPoint> {
  const out = new Map<string, ScreenPoint>();
  const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const [key, p] of [...at].sort((a, b) => b[1].y - a[1].y)) {
    if (p.off) {
      out.set(key, p);
      continue;
    }
    const { w, h } = size(key);
    let y = p.y;
    for (let hit = taken.find((r) => r.x0 < p.x + w / 2 && r.x1 > p.x - w / 2 && r.y0 < y && r.y1 > y - h); hit; hit = taken.find((r) => r.x0 < p.x + w / 2 && r.x1 > p.x - w / 2 && r.y0 < y && r.y1 > y - h)) y = hit.y0 - 1;
    taken.push({ x0: p.x - w / 2, x1: p.x + w / 2, y0: y - h, y1: y });
    out.set(key, { ...p, y });
  }
  return out;
}

/** A tag's text: a subagent's name; for a chat's reply, which all share one name, the chat's title. */
const tagText = (room: Room, d: Desk) => (d.agent.kind === "reply" ? room.title : d.name);

export function OfficeBuilding({
  rooms,
  profile,
  onOpen,
  onFallback,
  onMore,
}: {
  rooms: readonly Room[];
  profile: string;
  onOpen: (room: Room, desk: Desk) => void;
  /** The building can't be drawn here, and why: the office shows List instead. */
  onFallback: (why: string) => void;
  /** "+N more": show every agent, in List. */
  onMore: () => void;
}) {
  const memory = useRef(EMPTY_FLOOR_MEMORY);
  const floor = useMemo(() => {
    const f = officeFloor(rooms, memory.current);
    memory.current = f.memory;
    return f;
  }, [rooms]);
  const picture = pictureOf(floor);
  const latest = useRef(floor);
  latest.current = floor;

  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, HTMLElement>());
  const roomTags = useRef(new Map<BuildingRoom, HTMLElement>());
  const more = useRef<HTMLButtonElement>(null);
  const [scene, setScene] = useState<OfficeScene>();
  const [selected, setSelected] = useState<string>();
  const mode = useSyncExternalStore(subscribeMode, modeNow);
  const moves = !useSyncExternalStore(subscribeMotion, () => !!reducedMotion()?.matches);
  const focused = useWindowFocused();
  const pageHidden = usePageHidden();
  const awake = focused && !pageHidden;
  const fallback = useRef(onFallback);
  fallback.current = onFallback;

  useEffect(() => {
    const why = webglMissing();
    if (why) return fallback.current(why);
    let live = true;
    let made: OfficeScene | undefined;
    // Written only when it moved: while agents type and the camera stays, a frame changes nothing on the page.
    const place = (el: HTMLElement | null | undefined, p: ScreenPoint) => {
      if (!el) return;
      const at = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px)`;
      if (el.style.transform !== at) el.style.transform = at;
      if (el.hasAttribute("data-off") !== p.off) el.toggleAttribute("data-off", p.off);
    };
    import("./office3d/scene")
      .then(({ mountOfficeScene }) => {
        if (!live || !canvas.current) return;
        made = mountOfficeScene(
          canvas.current,
          {
            onPick: setSelected,
            onDrawn(at, rooms, door) {
              for (const [key, p] of unstacked(at, (key) => tagSize(tags.current.get(key)))) place(tags.current.get(key), p);
              for (const [r, p] of Object.entries(rooms) as [BuildingRoom, ScreenPoint][]) place(roomTags.current.get(r), p);
              place(more.current, door);
            },
            // The frame counter, for proof that nothing draws while nothing moves. Written straight to the page.
            onFrame: (n) => host.current?.setAttribute("data-frames", String(n)),
            onLost: (why) => live && fallback.current(why),
          },
          { mode: modeNow(), moves: !reducedMotion()?.matches },
        );
        setScene(made);
      })
      .catch((e: unknown) => live && fallback.current(`The building couldn't be loaded: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      live = false;
      made?.dispose();
    };
  }, []);

  useEffect(() => scene?.setFloor(latest.current), [scene, picture]);
  useEffect(() => scene?.setMode(mode), [scene, mode]);
  useEffect(() => scene?.setMotion(moves), [scene, moves]);
  useEffect(() => scene?.setAwake(awake), [scene, awake]);
  useEffect(() => scene?.setSelected(selected), [scene, selected]);

  const picked = floor.characters.find((c) => c.key === selected);
  const close = () => {
    const key = selected;
    setSelected(undefined);
    if (key) tags.current.get(key)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && picked) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={host} className="office-building" data-frames="0" onKeyDown={onKeyDown}>
      {/* Focusable, so after a click on it the office's keys, Escape among them, still reach it. */}
      <canvas ref={canvas} className="office-canvas" aria-hidden tabIndex={-1} />
      {!scene ? (
        <div className="office-note inbox-note">Opening the building…</div>
      ) : (
        floor.characters.length === 0 && floor.more === 0 && <div className="office-note inbox-note">No agent is at work. One shows here while a reply runs, waits for you or failed, and for each subagent it starts.</div>
      )}
      <div className="office-overlay">
        {(Object.keys(ROOM_NAME) as BuildingRoom[]).map((r) => (
          <span key={r} className="office-room-label" aria-hidden data-off ref={(el) => void (el ? roomTags.current.set(r, el) : roomTags.current.delete(r))}>
            {ROOM_NAME[r]}
          </span>
        ))}
        <div className="office-tags" role="group" aria-label="Agents in the building">
          {floor.characters.map((c) => (
            <button
              key={c.key}
              className={`office-tag state-${c.desk.state}${c.stale ? " is-stale" : ""}${c.key === selected ? " on" : ""}`}
              style={{ borderColor: TEAM_COLORS[c.color] }}
              data-desk={c.key}
              data-off
              aria-label={deskLabel(c.room, c.desk, profile)}
              aria-haspopup="dialog"
              ref={(el) => void (el ? tags.current.set(c.key, el) : tags.current.delete(c.key))}
              onClick={() => setSelected(c.key)}
            >
              <span className="office-dot" aria-hidden />
              <span className="office-tag-name">{tagText(c.room, c.desk)}</span>
            </button>
          ))}
        </div>
        {floor.more > 0 && (
          <button ref={more} className="office-more" data-off onClick={onMore} aria-label={`${floor.more} more agents aren't drawn. Show them all in List.`}>
            +{floor.more} more
          </button>
        )}
      </div>
      <div className="office-tools">
        <span className="office-hint">Drag to turn · scroll to zoom · double-click a room</span>
        <button className="btn" onClick={() => scene?.resetCamera()} disabled={!scene}>
          <RotateCcw size={13} aria-hidden /> Reset view
        </button>
      </div>
      {picked && (
        <OfficeCard room={picked.room} desk={picked.desk} profile={profile} color={TEAM_COLORS[picked.color]} onOpen={() => onOpen(picked.room, picked.desk)} onClose={close} />
      )}
    </div>
  );
}
