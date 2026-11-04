// The side panel's Terminal (ADR 0022, ADR 0039, ADR 0051): a shell on the Hermes server through the owner's own ssh,
// and a shell on this computer, each in a terminal of its own. It opens on the one picked last, the server's until then. Both stay alive while the owner is in another tab or the panel is
// hidden. Ending a session, or its shell exiting, keeps what was printed, with a way to start again.
import { useEffect, useRef, useState } from "react";
import { Laptop, Play, Plug, Server, X } from "lucide-react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSession, endedText, type TerminalApi, type TerminalKind, type TerminalState } from "../hermes/terminal";
import { Spinner } from "./bits";

/** The terminal's colours and font, from the app's theme (appearance.ts sets these on the root). */
function look(): { theme: ITheme; fontFamily: string; fontSize: number } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    theme: {
      background: v("--code-bg", "#0d0d0f"),
      foreground: v("--text", "#e7e7ea"),
      cursor: v("--accent", "#d97757"),
      cursorAccent: v("--code-bg", "#0d0d0f"),
      selectionBackground: v("--accent-soft", "rgba(217, 119, 87, 0.3)"),
      scrollbarSliderBackground: v("--line-2", "rgba(255, 255, 255, 0.12)"),
      scrollbarSliderHoverBackground: v("--line-3", "rgba(255, 255, 255, 0.22)"),
      scrollbarSliderActiveBackground: v("--line-3", "rgba(255, 255, 255, 0.22)"),
    },
    fontFamily: v("--mono", "monospace"),
    fontSize: parseFloat(v("--mono-size", "13px")) || 13,
  };
}

/**
 * One terminal. `server`: ssh to `initialTarget`, or to one the owner types. `local`: the owner's own login shell on
 * this computer, which Rust picks; `initialTarget` only labels it.
 */
export function TerminalScreen({
  kind = "server",
  api,
  initialTarget,
  shown,
  onTarget,
  onRunning,
  onOther,
}: {
  kind?: TerminalKind;
  api: TerminalApi;
  /** Where to connect: the target last used for the terminal, or the sign-in's. Empty asks the owner first. */
  initialTarget: string;
  /** False while the owner is elsewhere: the session keeps running out of sight. */
  shown: boolean;
  /** A target the owner typed and connected to, to use next time. */
  onTarget?: (target: string) => void;
  /** Whether the shell is running, for the rail and the panel's tabs. */
  onRunning?: (running: boolean) => void;
  /** Show the other computer's shell instead: offered when the server has no SSH target. */
  onOther?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const targetField = useRef<HTMLInputElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const fit = useRef<FitAddon>(undefined);
  const session = useRef<TerminalSession>(undefined);
  const [state, setState] = useState<TerminalState>({ kind: "idle" });
  const [target, setTarget] = useState(initialTarget);
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;

  const connect = (to: string) => {
    const t = term.current;
    const s = session.current;
    if (!t || !s || !to.trim()) return;
    fit.current?.fit();
    if (s.state.kind !== "idle") t.write("\r\n");
    // The cursor shows only while a session runs.
    t.write(`\x1b[?25h\x1b[2m── ${kind === "local" ? "this computer" : `ssh ${to.trim()}`} ──\x1b[0m\r\n`);
    void s.start(to, t.cols, t.rows);
    t.focus();
  };

  useEffect(() => {
    const t = new XTerm({ ...look(), cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    const s = new TerminalSession(
      api,
      (data) => t.write(data),
      (st) => {
        if (st.kind === "ended" || st.kind === "failed") t.write("\x1b[?25l");
        setState(st);
        onRunningRef.current?.(st.kind === "connecting" || st.kind === "open");
      },
    );
    session.current = s;
    const typed = t.onData((d) => s.input(d));
    const resized = t.onResize(({ cols, rows }) => s.resize(cols, rows));
    // Copy and paste as other Linux terminals do; plain Ctrl+C and Ctrl+V go to the shell.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey) return true;
      if (e.code === "KeyC") {
        if (t.hasSelection()) void navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        e.preventDefault();
        return false;
      }
      if (e.code === "KeyV") {
        void navigator.clipboard?.readText().then((text) => t.paste(text)).catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });
    // Follow the app's theme and font as Appearance changes them.
    const themed = new MutationObserver(() => {
      const l = look();
      t.options.theme = l.theme;
      t.options.fontFamily = l.fontFamily;
      t.options.fontSize = l.fontSize;
      f.fit();
    });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode", "class"] });
    const sized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => host.current?.offsetParent && f.fit());
    sized?.observe(host.current!);
    // The app's own shortcuts (Ctrl+K, Ctrl+N, Ctrl+B, Ctrl+F…) listen on the window; in here those keys are the shell's.
    const screen = screenRef.current!;
    const keep = (e: KeyboardEvent) => {
      if (host.current?.contains(e.target as Node)) e.stopPropagation();
    };
    screen.addEventListener("keydown", keep);
    // A local shell starts at once, as any terminal does; the server's when there is a target to connect to.
    if (kind === "local") connect("this computer");
    else if (initialTarget.trim()) connect(initialTarget);
    else t.write("\x1b[?25l");
    return () => {
      screen.removeEventListener("keydown", keep);
      sized?.disconnect();
      themed.disconnect();
      typed.dispose();
      resized.dispose();
      s.dispose();
      onRunningRef.current?.(false);
      t.dispose();
    };
    // Made once for the life of the screen; `connect` and `initialTarget` are read at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Shown again: fit to the space it has now, and take the keys. With no target yet, the field to set one takes them.
  useEffect(() => {
    if (!shown) return;
    fit.current?.fit();
    if (kind === "server" && session.current?.state.kind === "idle" && !initialTarget.trim()) targetField.current?.focus();
    else term.current?.focus();
    // `initialTarget` is read once, as at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const running = state.kind === "connecting" || state.kind === "open";
  const submit = () => {
    if (!target.trim() || running) return;
    onTarget?.(target.trim());
    connect(target);
  };
  const what = kind === "local" ? "A shell on this computer" : "A shell on the Hermes server";
  // A URL sign-in has no SSH target, and none was typed for this connection yet: say so, rather than a bare field.
  const noTarget = kind === "server" && state.kind === "idle" && !initialTarget.trim();

  return (
    <div className="terminal-screen" ref={screenRef} hidden={!shown} data-kind={kind}>
      <div className="terminal-title">
        {state.kind !== "idle" && <span className="mono muted terminal-where">{kind === "local" ? "your login shell" : `ssh ${state.target}`}</span>}
        <span className={`terminal-status ${state.kind}`} role="status" aria-label={`${what}: ${statusWord(state)}`}>
          {state.kind === "connecting" ? (
            <>
              <Spinner /> {kind === "local" ? "Starting…" : "Connecting…"}
            </>
          ) : (
            statusWord(state)
          )}
        </span>
        <span className="terminal-spacer" />
        {running && (
          <button className="btn" onClick={() => session.current?.end()} title={kind === "local" ? "Ends the shell on this computer" : "Ends ssh and the shell on the server"}>
            <X size={14} /> End session
          </button>
        )}
      </div>
      {!running &&
        (kind === "local" ? (
          <div className="terminal-connect">
            <p className={state.kind === "failed" ? "bad" : "muted"}>
              {state.kind === "ended"
                ? endedText(state, kind)
                : state.kind === "failed"
                  ? state.message
                  : "Your own login shell on this computer, in your home folder. It runs as you, with everything you can do in any other terminal; Hermes never sees it."}
            </p>
            <div className="terminal-connect-row">
              <button className="btn primary" onClick={() => connect("this computer")}>
                <Play size={14} /> {state.kind === "idle" ? "Start" : "Start again"}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="terminal-connect"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {noTarget ? (
              <div className="terminal-no-target">
                <p>
                  <strong>No SSH target for the Hermes server.</strong>
                </p>
                <p className="muted">
                  This connection signs in with a web address, so the app doesn't know how to reach the server over ssh. Set an SSH target, such as liam@hermes, to open a shell there. The app keeps it for this connection. Your ~/.ssh/config, keys and agent apply.
                </p>
              </div>
            ) : (
              <p className={state.kind === "failed" ? "bad" : "muted"}>
                {state.kind === "ended"
                  ? endedText(state, kind)
                  : state.kind === "failed"
                    ? state.message
                    : "A shell on the Hermes server, through your own ssh: your ~/.ssh/config, keys and agent apply, and ssh asks here for anything it needs."}
              </p>
            )}
            <div className="terminal-connect-row">
              <label>
                <span>SSH target</span>
                <input ref={targetField} className="mono" value={target} placeholder="liam@hermes" spellCheck={false} autoCapitalize="off" onChange={(e) => setTarget(e.target.value)} />
              </label>
              <button className="btn primary" type="submit" disabled={!target.trim()}>
                <Plug size={14} /> {noTarget ? "Set and connect" : state.kind === "idle" ? "Connect" : "Connect again"}
              </button>
              {noTarget && onOther && (
                <button className="btn" type="button" onClick={onOther}>
                  <Laptop size={14} /> Use this computer instead
                </button>
              )}
            </div>
          </form>
        ))}
      <div className="terminal-body">
        <div className="terminal-host" ref={host} aria-label={kind === "local" ? "Terminal on this computer" : "Terminal on the server"} />
      </div>
      <p className="terminal-foot faint">Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes. The session keeps running in other tabs.</p>
    </div>
  );
}

function statusWord(s: TerminalState) {
  return s.kind === "connecting" ? "Connecting" : s.kind === "open" ? "Connected" : s.kind === "ended" ? "Ended" : s.kind === "failed" ? "Couldn't start" : "Not connected";
}

/**
 * The Terminal tab: the Hermes server's shell and this computer's, one shown at a time, switched at the top. `kind` is
 * the one picked last, which the app keeps (uiPrefs `terminalKind`); the server's until the owner picks. Each is made
 * the first time it is picked and kept from then on, so its session runs on while the other is shown.
 */
export function TerminalTab({
  server,
  local,
  shown,
  kind,
  onKind,
  onRunning,
}: {
  server: { api: TerminalApi; initialTarget: string; onTarget: (target: string) => void };
  local: { api: TerminalApi };
  shown: boolean;
  kind: TerminalKind;
  onKind: (k: TerminalKind) => void;
  /** Which shells are running, for the rail's dot. */
  onRunning?: (running: Record<TerminalKind, boolean>) => void;
}) {
  const [made, setMade] = useState<Record<TerminalKind, boolean>>({ server: kind === "server", local: kind === "local" });
  const [running, setRunning] = useState<Record<TerminalKind, boolean>>({ server: false, local: false });
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;
  useEffect(() => {
    if (!made[kind]) setMade((m) => ({ ...m, [kind]: true }));
  }, [kind, made]);
  useEffect(() => onRunningRef.current?.(running), [running]);
  const ran = (k: TerminalKind) => (on: boolean) => setRunning((r) => (r[k] === on ? r : { ...r, [k]: on }));
  return (
    <div className="terminal-tab" hidden={!shown}>
      <div className="segmented terminal-kinds" role="group" aria-label="Which computer">
        <button aria-pressed={kind === "server"} onClick={() => onKind("server")} title="A shell on the Hermes server, through your ssh">
          <Server size={13} /> Hermes server {running.server && <span className="dot run-dot" role="img" aria-label="(running)" />}
        </button>
        <button aria-pressed={kind === "local"} onClick={() => onKind("local")} title="A shell on this computer">
          <Laptop size={13} /> This computer {running.local && <span className="dot run-dot" role="img" aria-label="(running)" />}
        </button>
      </div>
      {made.server && <TerminalScreen kind="server" api={server.api} initialTarget={server.initialTarget} onTarget={server.onTarget} shown={shown && kind === "server"} onRunning={ran("server")} onOther={() => onKind("local")} />}
      {made.local && <TerminalScreen kind="local" api={local.api} initialTarget="" shown={shown && kind === "local"} onRunning={ran("local")} />}
    </div>
  );
}
