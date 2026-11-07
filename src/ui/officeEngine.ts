// The office building's drawing (ADR 0089): one floor of four rooms and a hallway, low-poly furniture, and a faceless
// character per agent, drawn with three.js. It only draws what `floorLayout` (src/hermes/office.ts) says; the names,
// tags, "!" and card are HTML over it (OfficeBuilding.tsx), placed where `onProject` says each character is on screen.
//
// The budget: a frame is drawn only when something changes (the agents, the camera, the size, the theme) or while an
// agent types, then at most 30 a second. Nothing is drawn while `setActive(false)` (hidden, minimized or unfocused).
// No live shadows, instanced characters and furniture, and a pixel ratio of at most 1.5. This module and three.js are
// one chunk, loaded only when the office first opens.
import {
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Mesh,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from "three";
import type { DeskState, FloorRoom } from "../hermes/office";

/** One agent to draw: where `floorLayout` put it, its team's color, and whether it is as last seen. */
export type EngineAgent = { key: string; floorRoom: FloorRoom; spot: number; door?: boolean; team: number; state: DeskState; stale: boolean };

/** Where an agent stands on screen, in CSS pixels from the canvas's top left: its head at (x, y), `h` tall. */
export type ScreenSpot = { key: string; x: number; y: number; w: number; h: number; hidden: boolean };
export type ScreenPoint = { x: number; y: number; hidden: boolean };

export type EngineOptions = {
  canvas: HTMLCanvasElement;
  /** The element the camera's drag, scroll and double-click come from: the canvas and what is drawn over it. */
  surface: HTMLElement;
  /** After a frame in which the camera, size or agents changed: where each agent, room name and the door are on screen. */
  onProject: (agents: ScreenSpot[], rooms: Record<FloorRoom, ScreenPoint>, door: ScreenPoint) => void;
  /** After every frame drawn, with how many have been drawn in all. */
  onFrame?: (frames: number) => void;
};

export interface OfficeEngine {
  setAgents(agents: readonly EngineAgent[]): void;
  /** Whether characters may move: not when the system asks for reduced motion. */
  setMotion(on: boolean): void;
  /** Whether frames may be drawn at all: not while the office is hidden, minimized or the window unfocused. */
  setActive(on: boolean): void;
  /** The app's light or dark mode, and its background color, which the ground around the building takes. */
  setTheme(mode: "light" | "dark", bg?: string): void;
  resetView(): void;
  /** Whether the pointer just dragged the camera, so the click that ends a drag doesn't open a card. */
  dragged(): boolean;
  readonly frames: number;
  dispose(): void;
}

/** The team colors, the same in light and dark. Index = `Placement.team`. */
export const TEAM_PALETTE = ["#e0676b", "#4f9ad8", "#4fae62", "#e3a33b", "#9b6bd6", "#2bb3b1", "#d66bab", "#8f9c3a"];

// ---------------------------------------------------------------------------------------------------------------------
// The floor plan, in metres. The hallway runs east–west through the middle; the front door is at its east end.

type Rect = { x0: number; x1: number; z0: number; z1: number };
export const ROOM_RECTS: Record<FloorRoom, Rect> = {
  workroom: { x0: -13, x1: 4, z0: -9, z1: -1 },
  waiting: { x0: 4, x1: 13, z0: -9, z1: -1 },
  lounge: { x0: -13, x1: 4, z0: 1, z1: 9 },
  trouble: { x0: 4, x1: 13, z0: 1, z1: 9 },
};
const HALL: Rect = { x0: -13, x1: 13, z0: -1, z1: 1 };
const WALL_H = 0.9;
const WALL_T = 0.16;
/** Door gaps in the hallway walls, by x, and the front door in the east wall, by z. */
const DOORS_NORTH: [number, number][] = [
  [0.4, 2.4],
  [7.5, 9.5],
];
const DOORS_SOUTH = DOORS_NORTH;
const FRONT_DOOR: [number, number] = [-1, 1];

/** A Workroom desk's place: groups of three in pods of two facing groups, four pods across, two deep. */
function workSeat(seat: number): { x: number; z: number; rot: number; deskZ: number } {
  const group = Math.floor(seat / 3);
  const i = seat % 3;
  const pod = Math.floor(group / 2);
  const side = group % 2;
  const podX = -10.4 + (pod % 4) * 4;
  const podZ = Math.floor(pod / 4) ? -3.3 : -6.8;
  const x = podX + (i - 1) * 1.1;
  return side ? { x, z: podZ + 1.05, rot: Math.PI, deskZ: podZ + 0.35 } : { x, z: podZ - 1.05, rot: 0, deskZ: podZ - 0.35 };
}

/** `n` places spread over a room, in reading order, at least `least` of them so a few agents don't sprawl. */
function roomSpots(r: Rect, n: number, least: number): { x: number; z: number }[] {
  const count = Math.max(n, least);
  const w = r.x1 - r.x0 - 2.4;
  const h = r.z1 - r.z0 - 2.4;
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * w) / h)));
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, k) => ({ x: r.x0 + 1.2 + ((k % cols) + 0.5) * (w / cols), z: r.z0 + 1.2 + (Math.floor(k / cols) + 0.5) * (h / rows) }));
}

/** A queued agent's place in the line outside the Workroom's door, along the hallway. */
function queueSpot(i: number): { x: number; z: number } {
  return { x: 1.4 - (i % 16) * 0.85, z: i < 16 ? -0.3 : 0.4 };
}

const LEAST: Record<Exclude<FloorRoom, "workroom">, number> = { waiting: 6, trouble: 4, lounge: 6 };

// ---------------------------------------------------------------------------------------------------------------------
// Theme: the walls, floor and light follow the app's light or dark mode; team colors don't.

type Theme = { bg: string; ground: string; hall: string; rooms: Record<FloorRoom, string>; wall: string; wood: string; screen: string; seat: string; sofa: string; plant: string; head: string; stale: string; sky: string; under: string; light: number };
const THEMES: Record<"light" | "dark", Theme> = {
  dark: {
    bg: "#1b1c20",
    ground: "#202227",
    hall: "#33353d",
    rooms: { workroom: "#3a3c45", waiting: "#3d3b44", trouble: "#423a3d", lounge: "#38403c" },
    wall: "#5b5f6b",
    wood: "#7a6a58",
    screen: "#2b3442",
    seat: "#4a4e59",
    sofa: "#5c6b78",
    plant: "#4f8a5b",
    head: "#d9d4cb",
    stale: "#80838c",
    sky: "#c8d2e6",
    under: "#2a2b30",
    light: 1.15,
  },
  light: {
    bg: "#f6f6f4",
    ground: "#e7e5e0",
    hall: "#dad7d0",
    rooms: { workroom: "#f3f1ec", waiting: "#f1eef0", trouble: "#f4ecea", lounge: "#edf2ed" },
    wall: "#bdb8ae",
    wood: "#c2a07c",
    screen: "#3a4250",
    seat: "#8d93a0",
    sofa: "#8fa6b8",
    plant: "#5f9e69",
    head: "#e8e2d8",
    stale: "#a7a9ae",
    sky: "#ffffff",
    under: "#b9b4aa",
    light: 1.3,
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Characters: a body in the team's color, a ball head, legs and two arms, posed for the room.

type Pose = "typing" | "standing" | "hand-up" | "slumped" | "couch";
const POSE_OF = (a: EngineAgent): Pose =>
  a.floorRoom === "workroom" ? (a.door ? "standing" : "typing") : a.floorRoom === "waiting" ? "hand-up" : a.floorRoom === "trouble" ? "slumped" : "couch";
/** How tall each pose stands, for its tag's place. */
const TOP: Record<Pose, number> = { typing: 1.38, standing: 1.42, "hand-up": 1.6, slumped: 1.15, couch: 1.3 };
/** Characters are drawn larger than the furniture, so they read from across the building. */
const SCALE = 1.3;
/** Where a pose sits, which stays put as the character is scaled: a chair, a couch, or the floor. */
const SEAT: Record<Pose, number> = { typing: 0.45, slumped: 0.45, couch: 0.38, standing: 0, "hand-up": 0 };
const topOf = (pose: Pose) => SEAT[pose] + (TOP[pose] - SEAT[pose]) * SCALE;

/** A part's place on the character, which faces +z: centre, size (for the unit box), and tilt about x. */
type Part = { at: [number, number, number]; size?: [number, number, number]; tilt?: number };
type Figure = { body: Part; head: Part; legs: Part; arms: [Part, Part] };
const FIGURES: Record<Pose, Figure> = {
  typing: {
    body: { at: [0, 0.46, 0] },
    head: { at: [0, 1.2, 0.02] },
    legs: { at: [0, 0.43, 0.22], size: [0.3, 0.13, 0.44] },
    arms: [
      { at: [-0.21, 0.8, 0.24], size: [0.08, 0.08, 0.38] },
      { at: [0.21, 0.8, 0.24], size: [0.08, 0.08, 0.38] },
    ],
  },
  standing: {
    body: { at: [0, 0.5, 0] },
    head: { at: [0, 1.24, 0] },
    legs: { at: [0, 0.25, 0], size: [0.3, 0.5, 0.16] },
    arms: [
      { at: [-0.29, 0.8, 0], size: [0.08, 0.4, 0.08] },
      { at: [0.29, 0.8, 0], size: [0.08, 0.4, 0.08] },
    ],
  },
  "hand-up": {
    body: { at: [0, 0.5, 0] },
    head: { at: [0, 1.24, 0] },
    legs: { at: [0, 0.25, 0], size: [0.3, 0.5, 0.16] },
    arms: [
      { at: [-0.29, 0.8, 0], size: [0.08, 0.4, 0.08] },
      { at: [0.29, 1.32, 0], size: [0.08, 0.44, 0.08] },
    ],
  },
  slumped: {
    body: { at: [0, 0.46, 0], tilt: 0.5 },
    head: { at: [0, 0.86, 0.5] },
    legs: { at: [0, 0.43, 0.22], size: [0.3, 0.13, 0.44] },
    arms: [
      { at: [-0.24, 0.76, 0.46], size: [0.08, 0.08, 0.4] },
      { at: [0.24, 0.76, 0.46], size: [0.08, 0.08, 0.4] },
    ],
  },
  couch: {
    body: { at: [0, 0.4, -0.05], tilt: -0.12 },
    head: { at: [0, 1.12, -0.12] },
    legs: { at: [0, 0.4, 0.24], size: [0.3, 0.12, 0.46] },
    arms: [
      { at: [-0.29, 0.62, 0.02], size: [0.08, 0.08, 0.32] },
      { at: [0.29, 0.62, 0.02], size: [0.08, 0.08, 0.32] },
    ],
  },
};
const BODY_H = 0.56;

/** Where a placed agent is, which way it faces, and the furniture its spot brings. */
type Spot = { x: number; z: number; rot: number };
function spotOf(a: EngineAgent, counts: Record<FloorRoom, number>): Spot {
  if (a.floorRoom === "workroom") {
    if (a.door) return { ...queueSpot(a.spot), rot: Math.PI };
    const s = workSeat(a.spot);
    return { x: s.x, z: s.z, rot: s.rot };
  }
  const p = roomSpots(ROOM_RECTS[a.floorRoom], counts[a.floorRoom], LEAST[a.floorRoom])[a.spot];
  return { x: p.x, z: p.z, rot: FACING[a.floorRoom] };
}

/** Which way agents face in each room other than the Workroom: the Waiting room's door, the Trouble room's desks, and
 * the hallway from the Lounge's couches. A character faces its local +z, turned by this about y. */
export const FACING: Record<Exclude<FloorRoom, "workroom">, number> = { waiting: 0, trouble: Math.PI, lounge: Math.PI };

/** The way a character turned by `rot` faces, on the floor. */
export const forward = (rot: number) => ({ x: Math.sin(rot), z: Math.cos(rot) });

/**
 * The furniture a place in a room brings, as centres and sizes from the place: a desk in front of whoever is in
 * trouble, and a couch's seat and backrest under and behind whoever sits in the Lounge.
 */
export function furnitureAt(room: "trouble" | "lounge"): { at: [number, number, number]; size: [number, number, number] }[] {
  const f = forward(FACING[room]);
  const ahead = (d: number, y: number): [number, number, number] => [f.x * d, y, f.z * d];
  return room === "trouble"
    ? [{ at: ahead(0.62, 0.36), size: [1.04, 0.72, 0.62] }]
    : [
        { at: ahead(0.02, 0.19), size: [1.2, 0.38, 0.7] },
        { at: ahead(-0.4, 0.5), size: [1.2, 0.62, 0.18] },
      ];
}

// ---------------------------------------------------------------------------------------------------------------------

const MAX_AGENTS = 40;
const FRAME_MS = 1000 / 30;
/** Typing arms don't need more: 12 frames a second keeps a room of typing agents cheap. */
const TYPING_FRAME_MS = 1000 / 12;
const DPR_MAX = 1.5;
const POLAR_MIN = 0.12; // nearly straight down
const POLAR_MAX = 1.38; // nearly side-on
const DIST_MIN = 8;
const DIST_MAX = 44;
const HOME = { azimuth: 0.35, polar: 0.82, distance: 33, target: new Vector3(0, 0, 0.6) };

export function createOfficeEngine({ canvas, surface, onProject, onFrame }: EngineOptions): OfficeEngine {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_MAX));
  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.5, 200);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends BufferGeometry | Material>(x: T) => (disposables.push(x), x);

  const hemi = new HemisphereLight("#ffffff", "#444444", 1.6);
  const sun = new DirectionalLight("#ffffff", 1.6);
  sun.position.set(9, 16, 7);
  const ambient = new AmbientLight("#ffffff", 0.25);
  scene.add(hemi, sun, ambient);

  // Shared shapes and materials.
  const unitBox = keep(new BoxGeometry(1, 1, 1));
  const flat = (color = "#ffffff") => keep(new MeshLambertMaterial({ color, flatShading: true }));
  const mats = { ground: flat(), floor: flat(), wall: flat(), wood: flat(), screen: flat(), seat: flat(), sofa: flat(), plant: flat(), body: flat(), head: flat(), limb: flat() };
  const marker = flat("#e5484d");

  const ground = new Mesh(keep(new PlaneGeometry(90, 90)), mats.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const m4 = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();
  const s = new Vector3();
  const boxAt = (mesh: InstancedMesh, i: number, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0) =>
    mesh.setMatrixAt(i, m4.compose(v.set(x, y, z), q.setFromEuler(new Euler(0, rotY, 0)), s.set(w, h, d)));

  // Floors: the hallway and the four rooms, each its own tint.
  const floorRects: [Rect, FloorRoom | "hall"][] = [[HALL, "hall"], ...(Object.entries(ROOM_RECTS) as [FloorRoom, Rect][]).map(([k, r]) => [r, k] as [Rect, FloorRoom])];
  const floors = new InstancedMesh(unitBox, mats.floor, floorRects.length);
  floorRects.forEach(([r], i) => boxAt(floors, i, (r.x0 + r.x1) / 2, -0.01, (r.z0 + r.z1) / 2, r.x1 - r.x0, 0.04, r.z1 - r.z0));
  scene.add(floors);

  // Walls: the outside, the two hallway walls with a door into each room, and the walls between rooms.
  const walls: [number, number, number, number][] = []; // x0, z0, x1, z1 (axis-aligned)
  const run = (fixed: number, from: number, to: number, gaps: [number, number][], alongX: boolean) => {
    let at = from;
    for (const [g0, g1] of [...gaps].sort((a, b) => a[0] - b[0])) {
      if (g0 > at) walls.push(alongX ? [at, fixed, g0, fixed] : [fixed, at, fixed, g0]);
      at = g1;
    }
    if (to > at) walls.push(alongX ? [at, fixed, to, fixed] : [fixed, at, fixed, to]);
  };
  run(-9, -13, 13, [], true);
  run(9, -13, 13, [], true);
  run(-13, -9, 9, [], false);
  run(13, -9, 9, [FRONT_DOOR], false);
  run(-1, -13, 13, DOORS_NORTH, true);
  run(1, -13, 13, DOORS_SOUTH, true);
  run(4, -9, -1, [], false);
  run(4, 1, 9, [], false);
  const wallMesh = new InstancedMesh(unitBox, mats.wall, walls.length);
  walls.forEach(([x0, z0, x1, z1], i) => boxAt(wallMesh, i, (x0 + x1) / 2, WALL_H / 2, (z0 + z1) / 2, Math.max(x1 - x0, WALL_T), WALL_H, Math.max(z1 - z0, WALL_T)));
  scene.add(wallMesh);

  // The Workroom's furniture is always there: 48 desks, screens and chairs.
  const SEATS = 48;
  const desks = new InstancedMesh(unitBox, mats.wood, SEATS + MAX_AGENTS);
  const screens = new InstancedMesh(unitBox, mats.screen, SEATS);
  const chairs = new InstancedMesh(unitBox, mats.seat, SEATS * 2);
  for (let i = 0; i < SEATS; i++) {
    const w = workSeat(i);
    const toward = w.rot ? -1 : 1;
    boxAt(desks, i, w.x, 0.36, w.deskZ, 1.04, 0.72, 0.62);
    boxAt(screens, i, w.x, 0.92, w.deskZ + toward * 0.16, 0.56, 0.34, 0.05);
    boxAt(chairs, i * 2, w.x, 0.22, w.z, 0.46, 0.44, 0.46);
    boxAt(chairs, i * 2 + 1, w.x, 0.62, w.z - toward * 0.24, 0.46, 0.5, 0.08);
  }
  scene.add(desks, screens, chairs);

  // Couches in the Lounge, re-laid when how many sit there changes; a few plants by the walls.
  const sofas = new InstancedMesh(unitBox, mats.sofa, MAX_AGENTS * 2);
  scene.add(sofas);
  const plantGeo = keep(new CylinderGeometry(0, 0.38, 1.1, 6));
  plantGeo.translate(0, 0.55, 0);
  const plantSpots: [number, number][] = [
    [-12.4, -8.4],
    [12.4, -8.4],
    [-12.4, 8.4],
    [12.4, 8.4],
    [3.4, 8.4],
    [4.6, -8.4],
  ];
  const plants = new InstancedMesh(plantGeo, mats.plant, plantSpots.length);
  plantSpots.forEach(([x, z], i) => plants.setMatrixAt(i, m4.makeTranslation(x, 0, z)));
  scene.add(plants);

  // Characters, instanced: up to MAX_AGENTS of each part.
  const bodyGeo = keep(new CylinderGeometry(0.19, 0.25, BODY_H, 7));
  bodyGeo.translate(0, BODY_H / 2, 0);
  const headGeo = keep(new IcosahedronGeometry(0.17, 1));
  const shadowGeo = keep(new CircleGeometry(0.42, 12));
  shadowGeo.rotateX(-Math.PI / 2);
  const markerGeo = keep(new OctahedronGeometry(0.13, 0));
  const shadowMat = keep(new MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.16, depthWrite: false }));
  const bodies = new InstancedMesh(bodyGeo, mats.body, MAX_AGENTS);
  const heads = new InstancedMesh(headGeo, mats.head, MAX_AGENTS);
  const legs = new InstancedMesh(unitBox, mats.limb, MAX_AGENTS);
  const arms = new InstancedMesh(unitBox, mats.body, MAX_AGENTS * 2);
  const shadows = new InstancedMesh(shadowGeo, shadowMat, MAX_AGENTS);
  const markers = new InstancedMesh(markerGeo, marker, MAX_AGENTS);
  for (const m of [bodies, heads, legs, arms, shadows, markers]) {
    m.count = 0;
    m.frustumCulled = false;
  }
  scene.add(shadows, bodies, heads, legs, arms, markers);
  disposables.push(floors, wallMesh, desks, screens, chairs, sofas, plants, bodies, heads, legs, arms, shadows, markers);

  // ------------------------------------------------------------------------------------------------- state
  let agents: readonly EngineAgent[] = [];
  let signature = "";
  let spots: Spot[] = [];
  let counts: Record<FloorRoom, number> = { workroom: 0, waiting: 0, trouble: 0, lounge: 0 };
  let theme: Theme = THEMES.dark;
  let themeKey = "dark ";
  let motion = true;
  let active = true;
  let frames = 0;
  let disposed = false;
  let scheduled = 0;
  let loop: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = -Infinity;
  let projectDirty = true;
  const cam = { azimuth: HOME.azimuth, polar: HOME.polar, distance: HOME.distance, target: HOME.target.clone() };

  const color = new Color();
  const typingNow = () => motion && agents.some((a) => a.floorRoom === "workroom" && !a.door && a.state === "running" && !a.stale);

  function placeCamera() {
    const sinP = Math.sin(cam.polar);
    camera.position.set(
      cam.target.x + cam.distance * sinP * Math.sin(cam.azimuth),
      cam.target.y + cam.distance * Math.cos(cam.polar),
      cam.target.z + cam.distance * sinP * Math.cos(cam.azimuth),
    );
    camera.lookAt(cam.target);
    projectDirty = true;
  }

  /** Puts part `p` of a character at `spot` into `mesh` at `i`, typing arms raised by `lift`. */
  const local = new Matrix4();
  const lq = new Quaternion();
  const lv = new Vector3();
  const ls = new Vector3();
  const turn = new Euler();
  const partAt = (mesh: InstancedMesh, i: number, spot: Spot, pose: Pose, p: Part, lift = 0) => {
    const base = m4.compose(v.set(spot.x, -(SCALE - 1) * SEAT[pose], spot.z), q.setFromEuler(turn.set(0, spot.rot, 0)), s.set(SCALE, SCALE, SCALE));
    local.compose(lv.set(p.at[0], p.at[1] + lift, p.at[2]), lq.setFromEuler(turn.set(p.tilt ?? 0, 0, 0)), p.size ? ls.set(...p.size) : ls.set(1, 1, 1));
    mesh.setMatrixAt(i, base.multiply(local));
  };

  /** Lays out the characters and the furniture that comes with them. `t`: time for the typing arms, in seconds. */
  function layCharacters(t: number) {
    const n = Math.min(agents.length, MAX_AGENTS);
    let failed = 0;
    for (let i = 0; i < n; i++) {
      const a = agents[i];
      const spot = spots[i];
      const pose = POSE_OF(a);
      const f = FIGURES[pose];
      partAt(bodies, i, spot, pose, f.body);
      partAt(heads, i, spot, pose, f.head);
      partAt(legs, i, spot, pose, f.legs);
      const types = pose === "typing" && a.state === "running" && !a.stale && motion;
      const phase = (i * 1.7) % (Math.PI * 2);
      partAt(arms, i * 2, spot, pose, f.arms[0], types ? Math.max(0, Math.sin(t * 18 + phase)) * 0.05 : 0);
      partAt(arms, i * 2 + 1, spot, pose, f.arms[1], types ? Math.max(0, Math.sin(t * 18 + phase + Math.PI)) * 0.05 : 0);
      shadows.setMatrixAt(i, m4.compose(v.set(spot.x, 0.02, spot.z), q.identity(), s.set(SCALE, 1, SCALE)));
      if (a.floorRoom === "trouble") markers.setMatrixAt(failed++, m4.makeTranslation(spot.x, topOf(pose) + 0.4, spot.z));
    }
    for (const m of [bodies, heads, legs, arms, shadows, markers]) m.instanceMatrix.needsUpdate = true;
    markers.count = failed;
  }

  function paint() {
    const n = Math.min(agents.length, MAX_AGENTS);
    for (let i = 0; i < n; i++) {
      const a = agents[i];
      const shirt = a.stale ? theme.stale : TEAM_PALETTE[a.team % TEAM_PALETTE.length];
      bodies.setColorAt(i, color.set(shirt));
      arms.setColorAt(i * 2, color);
      arms.setColorAt(i * 2 + 1, color);
      heads.setColorAt(i, color.set(a.stale ? theme.stale : theme.head));
      legs.setColorAt(i, color.set(a.stale ? theme.stale : theme.seat).multiplyScalar(0.8));
    }
    for (const m of [bodies, arms, heads, legs]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  function applyTheme() {
    scene.background = new Color(theme.bg);
    mats.ground.color.set(theme.ground);
    mats.wall.color.set(theme.wall);
    mats.wood.color.set(theme.wood);
    mats.screen.color.set(theme.screen);
    mats.seat.color.set(theme.seat);
    mats.sofa.color.set(theme.sofa);
    mats.plant.color.set(theme.plant);
    floorRects.forEach(([, k], i) => floors.setColorAt(i, color.set(k === "hall" ? theme.hall : theme.rooms[k])));
    if (floors.instanceColor) floors.instanceColor.needsUpdate = true;
    hemi.color.set(theme.sky);
    hemi.groundColor.set(theme.under);
    hemi.intensity = 1.5 * theme.light;
    sun.intensity = 1.5 * theme.light;
    paint();
  }

  function layFurniture() {
    // Trouble-room desks, one per place, in front of who sits there; couches behind the Lounge's places.
    const trouble = roomSpots(ROOM_RECTS.trouble, counts.trouble, LEAST.trouble);
    const [desk] = furnitureAt("trouble");
    trouble.forEach((p, i) => boxAt(desks, SEATS + i, p.x + desk.at[0], desk.at[1], p.z + desk.at[2], ...desk.size));
    desks.count = SEATS + trouble.length;
    const lounge = roomSpots(ROOM_RECTS.lounge, counts.lounge, LEAST.lounge);
    const couch = furnitureAt("lounge");
    lounge.forEach((p, i) => couch.forEach((c, k) => boxAt(sofas, i * 2 + k, p.x + c.at[0], c.at[1], p.z + c.at[2], ...c.size)));
    sofas.count = lounge.length * 2;
    desks.instanceMatrix.needsUpdate = true;
    sofas.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------------- frames
  const project = (x: number, y: number, z: number, w: number, h: number): ScreenPoint => {
    v.set(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, hidden: v.z > 1 || v.z < -1 };
  };

  function sendProjection() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const out: ScreenSpot[] = [];
    agents.slice(0, MAX_AGENTS).forEach((a, i) => {
      const spot = spots[i];
      const top = project(spot.x, topOf(POSE_OF(a)) + 0.15, spot.z, w, h);
      const foot = project(spot.x, 0, spot.z, w, h);
      const tall = Math.max(18, Math.abs(foot.y - top.y));
      out.push({ key: a.key, x: top.x, y: top.y, w: Math.max(16, tall * 0.55), h: tall, hidden: top.hidden });
    });
    const rooms = Object.fromEntries((Object.entries(ROOM_RECTS) as [FloorRoom, Rect][]).map(([k, r]) => [k, project((r.x0 + r.x1) / 2, 0, k === "workroom" || k === "waiting" ? r.z0 + 0.7 : r.z1 - 0.7, w, h)])) as Record<FloorRoom, ScreenPoint>;
    onProject(out, rooms, project(13.6, 0, 0, w, h));
    projectDirty = false;
  }

  function draw(now: number) {
    scheduled = 0;
    if (disposed || !active) return;
    // At most 30 frames a second, whatever asks: a frame too soon waits for the next display refresh.
    if (now - lastFrame < FRAME_MS - 0.5) {
      scheduled = requestAnimationFrame(draw);
      return;
    }
    if (typingNow()) layCharacters(now / 1000);
    renderer.render(scene, camera);
    frames++;
    lastFrame = now;
    onFrame?.(frames);
    if (projectDirty) sendProjection();
    keepTyping();
  }

  /** Draws one frame soon, unless one is already on the way. */
  function invalidate() {
    if (disposed || !active || scheduled || loop) return;
    scheduled = requestAnimationFrame(draw);
  }

  /** While anyone types: the next frame a 12th of a second after the last. Otherwise nothing is scheduled. */
  function keepTyping() {
    if (loop || disposed || !active || !typingNow()) return;
    // Woken a little early, so the display refresh it waits for is the one a 30th of a second after the last frame.
    const wait = Math.max(0, TYPING_FRAME_MS - (performance.now() - lastFrame) - 12);
    loop = setTimeout(() => {
      loop = undefined;
      if (!scheduled) scheduled = requestAnimationFrame(draw);
    }, wait);
  }

  function stopLoop() {
    if (loop) clearTimeout(loop);
    loop = undefined;
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
  }

  // ------------------------------------------------------------------------------------------------- size
  const resize = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    projectDirty = true;
    invalidate();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(canvas);

  // ------------------------------------------------------------------------------------------------- camera input
  let press: { x: number; y: number; id: number; azimuth: number; polar: number } | undefined;
  let dragging = false;
  let dragEnded = -Infinity;
  // The card and the buttons over the drawing aren't the camera's: a drag, scroll or double-click there is theirs.
  const notMine = (e: Event) => e.target instanceof Element && !!e.target.closest("[data-camera-ignore]");
  const onDown = (e: PointerEvent) => {
    if (notMine(e)) return;
    if (e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, azimuth: cam.azimuth, polar: cam.polar };
    dragging = false;
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragging && Math.hypot(dx, dy) < 5) return;
    if (!dragging) {
      dragging = true;
      // Captured only once it is a drag, so a plain click still reaches the character it was on.
      surface.setPointerCapture?.(e.pointerId);
      surface.classList.add("is-turning");
    }
    cam.azimuth = press.azimuth - dx * 0.008;
    cam.polar = Math.min(POLAR_MAX, Math.max(POLAR_MIN, press.polar - dy * 0.006));
    placeCamera();
    invalidate();
  };
  const onUp = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    if (dragging) dragEnded = performance.now();
    press = undefined;
    dragging = false;
    surface.classList.remove("is-turning");
  };
  const onWheel = (e: WheelEvent) => {
    if (notMine(e)) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cam.distance = Math.min(DIST_MAX, Math.max(DIST_MIN, cam.distance * Math.exp(step * 0.0012)));
    // Zooming out past the whole building brings the view back to its middle.
    if (cam.distance >= HOME.distance) cam.target.lerp(HOME.target, 0.35);
    placeCamera();
    invalidate();
  };
  const ray = new Raycaster();
  const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  const onDouble = (e: MouseEvent) => {
    if (notMine(e)) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.ray.intersectPlane(groundPlane, new Vector3());
    if (!hit) return;
    const room = (Object.values(ROOM_RECTS) as Rect[]).find((b) => hit.x >= b.x0 && hit.x <= b.x1 && hit.z >= b.z0 && hit.z <= b.z1);
    if (!room) return;
    cam.target.set((room.x0 + room.x1) / 2, 0, (room.z0 + room.z1) / 2);
    // Far enough back that the whole room fills the view.
    cam.distance = Math.max(DIST_MIN, Math.min(24, Math.max(room.x1 - room.x0, (room.z1 - room.z0) * 1.6) * 1.2));
    placeCamera();
    invalidate();
  };
  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointercancel", onUp);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("dblclick", onDouble);

  applyTheme();
  placeCamera();
  resize();

  return {
    setAgents(next) {
      const sig = next.map((a) => `${a.key}|${a.floorRoom}|${a.spot}|${a.door ? 1 : 0}|${a.team}|${a.state}|${a.stale ? 1 : 0}`).join("\n");
      if (sig === signature) return;
      signature = sig;
      agents = next.slice(0, MAX_AGENTS);
      counts = { workroom: 0, waiting: 0, trouble: 0, lounge: 0 };
      for (const a of agents) counts[a.floorRoom]++;
      spots = agents.map((a) => spotOf(a, counts));
      for (const m of [bodies, heads, legs, shadows]) m.count = agents.length;
      arms.count = agents.length * 2;
      layFurniture();
      layCharacters(performance.now() / 1000);
      paint();
      projectDirty = true;
      invalidate();
    },
    setMotion(on) {
      if (on === motion) return;
      motion = on;
      layCharacters(performance.now() / 1000);
      invalidate();
    },
    setActive(on) {
      if (on === active) return;
      active = on;
      if (!on) stopLoop();
      else invalidate();
    },
    setTheme(mode, bg) {
      const next = `${mode} ${bg ?? ""}`;
      if (next === themeKey) return;
      themeKey = next;
      theme = { ...THEMES[mode], ...(bg && { bg }) };
      applyTheme();
      invalidate();
    },
    resetView() {
      cam.azimuth = HOME.azimuth;
      cam.polar = HOME.polar;
      cam.distance = HOME.distance;
      cam.target.copy(HOME.target);
      placeCamera();
      invalidate();
    },
    dragged: () => performance.now() - dragEnded < 250,
    get frames() {
      return frames;
    },
    dispose() {
      disposed = true;
      stopLoop();
      sizes.disconnect();
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onUp);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("dblclick", onDouble);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
