// The side panel's Screen: a profile's Bot Desktop on the Hermes server (ADR 0033). It is Hermes's own headless Xfce
// screen, where the agent's `computer_use` and its browser run. The owner watches it live, and can take over (for a
// sign-in, a 2FA code or a CAPTCHA) and hand back. Hermes owns all of it: whether the screen runs, and who may drive it
// (the lease). This app asks with `display.*` over `/api/ws` and draws the RFB stream Rust relays from
// `/api/display/ws` (src-tauri/src/display.rs). Wire shapes: `tui_gateway/methods_display.py` and
// `hermes_cli/web_routers/display.py`, read at v2026.9.24.

/** Who may drive the screen. The holder's viewer id never leaves Hermes; `viewer_hash` lets a holder know itself. */
export type DisplayLease = { holder: "agent" | "human"; viewer_hash?: string | null; since: number; epoch: number; reason?: string };

/** `display.status`, as far as this app reads it. */
export type DisplayStatus = {
  supported: boolean;
  installed: boolean;
  missing: string[];
  running: boolean;
  geometry?: string;
  install_command?: string | null;
  blocker?: string | null;
  lease: DisplayLease;
  profile_key: string;
};

/** `display.observe`: a single-use ticket for `/api/display/ws`, good for 30 s, and the viewer id minted for it. */
export type DisplayObserve = DisplayStatus & { ticket: string; viewer_id: string };

/** An RFB stream Rust relays. `onData` gets the screen's bytes; `onClose` once, with the WebSocket close code. */
export type ScreenSocket = { send(bytes: Uint8Array): void; close(): void };
export type OpenScreenSocket = (
  ticket: string,
  onData: (bytes: ArrayBuffer) => void,
  onClose: (code: number, reason: string) => void,
) => Promise<ScreenSocket>;

export interface ScreenApi {
  status(): Promise<DisplayStatus>;
  start(): Promise<DisplayStatus>;
  /** `viewerId`: one this connection minted before, so a reconnect keeps the lease it holds. */
  observe(viewerId?: string): Promise<DisplayObserve>;
  takeOver(viewerId: string): Promise<DisplayLease>;
  handBack(viewerId: string): Promise<DisplayLease>;
  /** Lease changes Hermes broadcasts, for this profile's screen and others'. */
  onLease(listener: (profileKey: string, lease: DisplayLease) => void): () => void;
  openSocket: OpenScreenSocket;
}

/** Hermes's close codes on `/api/display/ws`. */
export const CLOSE_CONTROL_TAKEN = 4000;
export const CLOSE_SCREEN_GONE = 4001;
export const CLOSE_BAD_TICKET = 4401;

/** JSON-RPC "method not found": this Hermes predates the Bot Desktop. */
export function isUnavailable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return message.includes("method not found") || message.includes("unknown method");
}

/** What the Screen shows before it can stream, from `display.status`; `live` once there is a screen to watch. */
export type ScreenPhase =
  | { kind: "unsupported" }
  | { kind: "not-installed"; missing: string[]; command?: string }
  | { kind: "blocked"; why: string }
  | { kind: "stopped" }
  | { kind: "live" };

export function phaseOf(s: DisplayStatus): ScreenPhase {
  if (!s.supported) return { kind: "unsupported" };
  if (s.running) return { kind: "live" };
  if (!s.installed) return { kind: "not-installed", missing: s.missing ?? [], ...(s.install_command && { command: s.install_command }) };
  if (s.blocker) return { kind: "blocked", why: s.blocker };
  return { kind: "stopped" };
}

/** The first 12 hex digits of the viewer id's SHA-256, as Hermes names the lease's holder. */
export async function viewerHash(viewerId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerId));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** Whether this viewer holds the lease. */
export const heldBy = (lease: DisplayLease | undefined, hash: string | undefined) => !!lease && !!hash && lease.holder === "human" && lease.viewer_hash === hash;

/** A lease older than the one already known: an answer overtaken by a broadcast. */
export const isOlder = (known: DisplayLease | undefined, next: DisplayLease) => !!known && next.epoch < known.epoch;

/**
 * A WebSocket-shaped stand-in that noVNC drives (its `Websock.attach` takes any object with these members), backed by
 * the stream Rust relays. noVNC sets `onopen`, `onmessage`, `onclose` and `onerror` after it is handed the channel, so
 * the open event goes out on the next task, and bytes or a close that came before then are held until it has.
 */
export class RelayedSocket {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = 0; // CONNECTING
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  /** The close code, once closed, for telling Hermes's 4000 (control taken) from a plain end. */
  closeCode: number | undefined;
  private socket: ScreenSocket | undefined;
  private held: (ArrayBuffer | { code: number; reason: string })[] = [];

  /** Opens the relayed stream with `ticket`; rejects if Rust can't. */
  static async open(open: OpenScreenSocket, ticket: string): Promise<RelayedSocket> {
    const s = new RelayedSocket();
    s.socket = await open(
      ticket,
      (bytes) => s.deliver(bytes),
      (code, reason) => s.deliver({ code, reason }),
    );
    setTimeout(() => s.opened(), 0);
    return s;
  }

  private deliver(e: ArrayBuffer | { code: number; reason: string }) {
    if (this.readyState === 0) this.held.push(e);
    else this.dispatch(e);
  }

  private dispatch(e: ArrayBuffer | { code: number; reason: string }) {
    if (this.readyState === 3) return;
    if (e instanceof ArrayBuffer) return this.onmessage?.({ data: e });
    this.readyState = 3; // CLOSED
    this.closeCode = e.code;
    this.onclose?.({ code: e.code, reason: e.reason, wasClean: e.code === 1000 });
  }

  private opened() {
    if (this.readyState !== 0) return;
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
    for (const e of this.held.splice(0)) this.dispatch(e);
  }

  /** noVNC hands over a view of a send buffer it reuses at once, so the bytes are copied before they go. */
  send(data: ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    this.socket?.send(data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)));
  }

  /** Closes normally (1000), which hands control the owner took back to the agent. */
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closeCode = 1000;
    this.held = [];
    this.socket?.close();
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }
}
