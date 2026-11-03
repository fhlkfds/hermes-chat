// A terminal on the server: the owner's own `ssh` run in a pseudo-terminal by Rust (src-tauri/src/terminal.rs,
// ADR 0022). This is the session's lifecycle, apart from the screen that draws it (src/ui/Terminal.tsx).

/** What the terminal sends back: bytes ssh printed, then, once, how it ended. */
export type TerminalEvent = { kind: "output"; data: Uint8Array } | { kind: "exit"; code: number | null };

/** Rust's terminal commands. `open` resolves to the terminal's id; its events may start before it resolves. */
export type TerminalApi = {
  open(target: string, cols: number, rows: number, onEvent: (e: TerminalEvent) => void): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  close(id: number): void;
};

export type TerminalState =
  | { kind: "idle" }
  | { kind: "connecting"; target: string }
  | { kind: "open"; target: string }
  /** `byOwner`: ended from this app. `code`: ssh's exit status, null when a signal ended it. */
  | { kind: "ended"; target: string; code: number | null; byOwner: boolean }
  /** ssh couldn't be started at all. */
  | { kind: "failed"; target: string; message: string };

/** Where the terminal goes: the target typed for it last, else the sign-in's own SSH target. */
export const TERMINAL_TARGET_KEY = "hermes-chat.terminal-target";

export function terminalTarget(signIn: { mode: "ssh" | "url"; sshTarget: string }, saved: string | null): string {
  if (saved?.trim()) return saved.trim();
  return signIn.mode === "ssh" ? signIn.sshTarget.trim() : "";
}

/** How a session's end reads under the terminal. */
export function endedText(s: Extract<TerminalState, { kind: "ended" }>): string {
  if (s.byOwner) return "You ended the session.";
  if (s.code === 0) return "The session ended.";
  // ssh's own failures (it couldn't connect, or the key was refused) are 255; ssh has printed why above.
  if (s.code === 255) return "ssh couldn't connect or lost the connection. What it said is above.";
  if (s.code === null) return "The session was ended by a signal.";
  return `The session ended with exit status ${s.code}.`;
}

/**
 * One terminal at a time. `output` gets every byte ssh prints; `onState` hears each change. Starting again keeps
 * what was printed before, so the screen keeps its scrollback.
 */
export class TerminalSession {
  state: TerminalState = { kind: "idle" };
  private id: number | undefined;
  /** Bumped by each start, so a late event from an earlier ssh can't touch the new one. */
  private run = 0;
  private endedByOwner = false;
  /** The size the screen last asked for; one asked for while ssh starts is sent once it has an id. */
  private size = { cols: 0, rows: 0 };

  constructor(
    private api: TerminalApi,
    private output: (data: Uint8Array) => void,
    private onState: (s: TerminalState) => void,
  ) {}

  private set(s: TerminalState) {
    this.state = s;
    this.onState(s);
  }

  get running() {
    return this.state.kind === "connecting" || this.state.kind === "open";
  }

  async start(target: string, cols: number, rows: number) {
    if (this.running) return;
    const run = ++this.run;
    this.id = undefined;
    this.endedByOwner = false;
    target = target.trim();
    this.size = { cols, rows };
    this.set({ kind: "connecting", target });
    const onEvent = (e: TerminalEvent) => {
      if (run !== this.run) return;
      if (e.kind === "output") {
        this.output(e.data);
        if (this.state.kind === "connecting") this.set({ kind: "open", target });
      } else {
        // Rust keeps the terminal until it is closed.
        if (this.id !== undefined) this.api.close(this.id);
        this.id = undefined;
        this.set({ kind: "ended", target, code: e.code, byOwner: this.endedByOwner });
      }
    };
    try {
      const id = await this.api.open(target, cols, rows, onEvent);
      if (run !== this.run || this.state.kind === "ended") {
        // Ended before `open` answered: it has nothing left to keep.
        this.api.close(id);
        return;
      }
      this.id = id;
      if (this.endedByOwner) this.api.close(id);
      else if (this.size.cols !== cols || this.size.rows !== rows) void this.api.resize(id, this.size.cols, this.size.rows).catch(() => {});
    } catch (e) {
      if (run === this.run) this.set({ kind: "failed", target, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** What the owner typed or pasted. Dropped while no ssh is running. */
  input(data: string) {
    if (this.id !== undefined && this.state.kind === "open") void this.api.write(this.id, data).catch(() => {});
  }

  resize(cols: number, rows: number) {
    this.size = { cols, rows };
    if (this.id !== undefined && this.running) void this.api.resize(this.id, cols, rows).catch(() => {});
  }

  /** Ends the running ssh; its end still arrives as `ended`, marked the owner's. */
  end() {
    if (!this.running) return;
    this.endedByOwner = true;
    if (this.id !== undefined) this.api.close(this.id);
  }

  /** Ends ssh and ignores anything it still sends: the screen is going away. */
  dispose() {
    this.run++;
    if (this.id !== undefined) this.api.close(this.id);
    this.id = undefined;
  }
}
