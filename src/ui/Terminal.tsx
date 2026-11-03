// The Terminal screen: a shell on the server through the owner's own ssh (ADR 0022). It covers the chat panes like
// Server files, but stays alive behind them: going back to a chat leaves the session running, and the screen shows it
// again as it was. Ending the session, or ssh exiting, keeps what was printed, with a way to connect again.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plug, SquareTerminal, X } from "lucide-react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSession, endedText, type TerminalApi, type TerminalState } from "../hermes/terminal";
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

export function TerminalScreen({
  api,
  initialTarget,
  shown,
  onTarget,
  onRunning,
  onClose,
}: {
  api: TerminalApi;
  /** Where to connect: the target last used for the terminal, or the sign-in's. Empty asks the owner first. */
  initialTarget: string;
  /** False while the owner is back in a chat: the session keeps running out of sight. */
  shown: boolean;
  /** A target the owner typed and connected to, to use next time. */
  onTarget: (target: string) => void;
  /** Whether ssh is running, for the rail. */
  onRunning?: (running: boolean) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
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
    t.write(`\x1b[?25h\x1b[2m── ssh ${to.trim()} ──\x1b[0m\r\n`);
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
    if (initialTarget.trim()) connect(initialTarget);
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

  // Shown again: fit to the space it has now, and take the keys.
  useEffect(() => {
    if (!shown) return;
    fit.current?.fit();
    term.current?.focus();
  }, [shown]);

  const running = state.kind === "connecting" || state.kind === "open";
  const submit = () => {
    if (!target.trim() || running) return;
    onTarget(target.trim());
    connect(target);
  };

  return (
    <div className="terminal-screen" ref={screenRef} hidden={!shown}>
      <div className="terminal-head">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="terminal-title">
          <h1>
            <SquareTerminal size={18} /> Terminal
          </h1>
          {state.kind !== "idle" && <span className="mono muted">ssh {state.target}</span>}
          <span className={`terminal-status ${state.kind}`} role="status">
            {state.kind === "connecting" ? (
              <>
                <Spinner /> Connecting…
              </>
            ) : state.kind === "open" ? (
              "Connected"
            ) : state.kind === "ended" ? (
              "Ended"
            ) : state.kind === "failed" ? (
              "Couldn't start"
            ) : (
              "Not connected"
            )}
          </span>
          <span className="terminal-spacer" />
          {running && (
            <button className="btn" onClick={() => session.current?.end()} title="Ends ssh and the shell on the server">
              <X size={14} /> End session
            </button>
          )}
        </div>
      </div>
      {!running && (
        <form
          className="terminal-connect"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className={state.kind === "failed" ? "bad" : "muted"}>
            {state.kind === "ended"
              ? endedText(state)
              : state.kind === "failed"
                ? state.message
                : "A shell on the Hermes server, through your own ssh: your ~/.ssh/config, keys and agent apply, and ssh asks here for anything it needs."}
          </p>
          <div className="terminal-connect-row">
            <label>
              <span>SSH target</span>
              <input className="mono" value={target} placeholder="liam@hermes" spellCheck={false} autoCapitalize="off" onChange={(e) => setTarget(e.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={!target.trim()}>
              <Plug size={14} /> {state.kind === "idle" ? "Connect" : "Connect again"}
            </button>
          </div>
        </form>
      )}
      <div className="terminal-body">
        <div className="terminal-host" ref={host} aria-label="Terminal" />
      </div>
      <p className="terminal-foot faint">Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes. Going back to a chat keeps the session running.</p>
    </div>
  );
}
