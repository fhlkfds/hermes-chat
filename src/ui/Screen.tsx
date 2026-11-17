// The side panel's Screen (ADR 0039): Hermes's Bot Desktop for the profile shown, the screen on the server where the
// agent's computer use and its browser run. The owner watches it live, takes over for something only they should type
// (a sign-in, a 2FA code, a CAPTCHA) and hands back. Hermes keeps who may drive it (the lease): while the owner holds
// it, Hermes's computer use waits, and only the holder's keys and pointer reach the screen. noVNC draws the stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ClipboardCopy, ClipboardPaste, Hand, MonitorPlay, MousePointer2, Play, RefreshCw } from "lucide-react";
import {
  BROWSER_FIX,
  CLOSE_CONTROL_TAKEN,
  CLOSE_SCREEN_GONE,
  RelayedSocket,
  browserOf,
  heldBy,
  isOlder,
  isUnavailable,
  phaseOf,
  viewerHash,
  type DisplayLease,
  type DisplayStatus,
  type ScreenApi,
} from "../hermes/screen";
import {
  SCREEN_APPS,
  canSetUp,
  installSystem,
  namesOf,
  recheckBrowser,
  setUpApps,
  skip,
  unfinished,
  type AppState,
  type AppsSetup,
  type InstallSystem,
  type ScreenAppId,
  type SetupDeps,
} from "../hermes/screenApps";
import { ClipboardBridge, copyOutFrom, MAX_TEXT_BYTES, type CopyOutcome, type LocalClipboard, type PasteOutcome } from "../hermes/screenClipboard";
import { CopyCommand, Spinner } from "./bits";
import { tauriClipboard } from "./tauriClipboard";
import { errorText } from "../hermes/values";

/** What the Screen needs of noVNC's RFB client. */
export type RfbClient = {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  background: string;
  qualityLevel: number;
  addEventListener(type: "connect" | "disconnect", handler: (e: { detail?: { clean?: boolean } }) => void): void;
  disconnect(): void;
  focus(): void;
  /** Sends `text` as the screen's clipboard; nothing while `viewOnly`. */
  clipboardPasteFrom(text: string): void;
};
export type RfbConstructor = new (target: HTMLElement, channel: RelayedSocket, options: { shared: boolean }) => RfbClient;

/**
 * noVNC loads only when a screen is first shown. As it loads it asks WebCodecs whether H.264 decodes (a top-level await
 * in `core/util/browser.js`). In WebKitGTK 2.54 without an H.264 GStreamer decoder, `VideoDecoder.isConfigSupported`
 * crashes the page's web process, the whole app's page. So noVNC loads with no `VideoDecoder` to find, and it then
 * never asks for H.264, which Hermes's Xvnc doesn't send anyway. It is put back once noVNC has loaded.
 */
export async function loadNoVnc(): Promise<RfbConstructor> {
  const global = globalThis as Record<string, unknown>;
  const decoder = Object.getOwnPropertyDescriptor(global, "VideoDecoder");
  if (decoder?.configurable) delete global.VideoDecoder;
  try {
    return (await import("@novnc/novnc")).default as RfbConstructor;
  } finally {
    if (decoder?.configurable) Object.defineProperty(global, "VideoDecoder", decoder);
  }
}

/** Takeovers by someone else this soon after attaching, this many times in a row, stop the re-attaching. */
const EVICTION_WINDOW_MS = 5_000;
const MAX_EVICTIONS = 3;

type Conn = { kind: "idle" } | { kind: "attaching" } | { kind: "live" } | { kind: "lost"; why: string };

export function ScreenTab({
  api,
  shown,
  connected,
  loadRfb = loadNoVnc,
  onHeld,
  system,
  clipboard = tauriClipboard,
}: {
  api: ScreenApi;
  shown: boolean;
  connected: boolean;
  /** Installs the terminal and the text editor through the connection's ssh; undefined without an SSH target. */
  system?: InstallSystem;
  loadRfb?: () => Promise<RfbConstructor>;
  /** Whether the owner holds the screen, so the panel can say so while the tab isn't shown. */
  onHeld?: (held: boolean) => void;
  /** This computer's clipboard, for copy and paste with the screen while the owner holds it. */
  clipboard?: LocalClipboard;
}) {
  const [status, setStatus] = useState<DisplayStatus>();
  const [lease, setLease] = useState<DisplayLease>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<Conn>({ kind: "idle" });
  const [viewer, setViewer] = useState<{ id: string; hash: string }>();
  const [evicted, setEvicted] = useState(false);
  /** The browser a Check again found where there was none, said once until the next read. */
  const [found, setFound] = useState<string>();
  const [setup, setSetup] = useState<AppsSetup>({ kind: "unchecked" });
  /** What Paste here or Copy out did, said until the next one. */
  const [clipNote, setClipNote] = useState<{ text: string; bad?: boolean }>();
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RfbClient | null>(null);
  // Bumped by every attach and detach, so a late answer from an earlier one does nothing.
  const generation = useRef(0);
  const evictions = useRef({ count: 0, at: 0 });
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const [bridge] = useState(() => new ClipboardBridge(clipboard));
  // Bumped when the connection drops and when the tab goes (switching profile remounts it). A setup run from before
  // then stops: `api` would answer for the new connection or profile.
  const setupRun = useRef(0);
  useEffect(() => () => void setupRun.current++, []);

  const held = heldBy(lease, viewer?.hash);
  // Viewers this tab held the screen as on connections since gone. Hermes keeps such a hold when a connection drops,
  // so the owner can be told it is still theirs.
  const pastHolds = useRef(new Set<string>());
  if (held && viewer) pastHolds.current.add(viewer.hash);
  const onHeldRef = useRef(onHeld);
  onHeldRef.current = onHeld;
  useEffect(() => onHeldRef.current?.(held), [held]);
  // Not cleared when the tab goes: leaving the connection hands back what the owner still holds.
  useEffect(() => api.noteHeld(held ? viewer?.id : undefined), [api, held, viewer?.id]);
  useEffect(() => () => onHeldRef.current?.(false), []);

  const noteLease = useCallback((next: DisplayLease) => setLease((known) => (isOlder(known, next) ? known : next)), []);
  const noteStatus = useCallback(
    (s: DisplayStatus) => {
      setStatus(s);
      if (s.lease) noteLease(s.lease);
    },
    [noteLease],
  );

  const refresh = useCallback(async () => {
    setFound(undefined);
    try {
      const s = await api.status();
      noteStatus(s);
      setError(undefined);
      return s;
    } catch (e) {
      if (isUnavailable(e)) setUnavailable(true);
      else setError(errorText(e));
    }
  }, [api, noteStatus]);

  /** Lets go of the stream. A normal close: Hermes hands control the owner took back to the agent. */
  const detach = useCallback(() => {
    generation.current++;
    const client = rfb.current;
    rfb.current = null;
    try {
      client?.disconnect();
    } catch {
      // Already closed itself.
    }
  }, []);

  const attach = useCallback(async () => {
    detach();
    bridge.forget();
    const gen = generation.current;
    setConn({ kind: "attaching" });
    try {
      const Rfb = await loadRfb();
      // A viewer id this connection minted before keeps the lease it holds across a re-attach.
      const observed = await api.observe(viewerRef.current?.id);
      const minted = { id: observed.viewer_id, hash: await viewerHash(observed.viewer_id) };
      if (gen !== generation.current) return;
      noteStatus(observed);
      setViewer(minted);
      const socket = await RelayedSocket.open(api.openSocket, observed.ticket);
      if (gen !== generation.current || !host.current) return socket.close();
      const client = new Rfb(host.current, socket, { shared: true });
      client.scaleViewport = true;
      client.resizeSession = false;
      client.focusOnClick = true;
      client.background = "transparent";
      client.qualityLevel = 7;
      client.viewOnly = !heldBy(observed.lease, minted.hash);
      client.addEventListener("connect", () => {
        if (gen !== generation.current) return;
        setConn({ kind: "live" });
        setEvicted(false);
      });
      client.addEventListener("disconnect", (e) => {
        if (rfb.current === client) rfb.current = null;
        if (gen !== generation.current) return;
        const code = socket.closeCode;
        if (code === CLOSE_CONTROL_TAKEN) {
          // Someone else took over: watch again on a fresh ticket, unless it keeps happening straight away.
          const now = Date.now();
          evictions.current = { count: now - evictions.current.at < EVICTION_WINDOW_MS ? evictions.current.count + 1 : 1, at: now };
          if (evictions.current.count > MAX_EVICTIONS) setConn({ kind: "lost", why: "Someone else keeps taking over this screen." });
          else {
            setEvicted(true);
            setConn({ kind: "idle" });
          }
        } else if (code === CLOSE_SCREEN_GONE) {
          setConn({ kind: "idle" });
        } else {
          setConn({ kind: "lost", why: code === 1000 && e.detail?.clean ? "The stream ended." : "The stream from the server was lost." });
        }
        void refresh();
      });
      rfb.current = client;
    } catch (e) {
      if (gen === generation.current) setConn({ kind: "lost", why: errorText(e) });
    }
  }, [api, bridge, detach, loadRfb, noteStatus, refresh]);

  // What the screen is doing: asked on first show and after each reconnect to Hermes, which watches again a stream
  // the drop ended. The stream isn't let go here: a normal close would tell Hermes the owner left, and hand control
  // they hold back to the agent mid-sign-in. Rust drops it with the connection, which Hermes reads as a dropped link.
  useEffect(() => {
    if (connected) {
      setConn((c) => (c.kind === "lost" ? { kind: "idle" } : c));
      void refresh();
    }
    else {
      // A viewer id is good only on the connection that minted it.
      setViewer(undefined);
      setupRun.current++;
    }
  }, [connected, refresh]);

  useEffect(() => api.onLease((key, l) => key === status?.profile_key && noteLease(l)), [api, status?.profile_key, noteLease]);

  /** For a setup run that starts now. */
  const setupDeps = (): SetupDeps => {
    const run = setupRun.current;
    return { api, system, update: setSetup, onStatus: noteStatus, alive: () => run === setupRun.current };
  };
  const depsRef = useRef(setupDeps);
  depsRef.current = setupDeps;
  // The first time the tab is shown on a screen they can go on, and once more on each later connection while the last
  // run was cut off or couldn't tell what the server has.
  const setUpOn = useRef<number | undefined>(undefined);
  // Apart from the setup, which a later run replaces before it knows what is missing.
  const skipped = useRef(new Set<ScreenAppId>());
  useEffect(() => {
    if (!shown || !connected || !status || !canSetUp(status) || setUpOn.current === setupRun.current) return;
    setUpOn.current = setupRun.current;
    if (unsettled(setup)) void setUpApps(depsRef.current(), status, [...skipped.current], unfinished(setup));
  }, [shown, connected, status, setup]);

  // A running screen is watched as soon as it can be.
  useEffect(() => {
    if (connected && status?.running && conn.kind === "idle") void attach();
  }, [connected, status?.running, conn.kind, attach]);

  // Only the lease's holder sends keys and pointer; Hermes's bridge drops anyone else's anyway.
  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.viewOnly = !held;
    if (held) rfb.current.focus();
    else setClipNote(undefined);
  }, [held, conn.kind]);

  // Aborted when the owner stops holding the screen, the connection drops or the tab goes, which stops a copy or paste
  // under way.
  const hold = useRef<AbortSignal | undefined>(undefined);
  useEffect(() => {
    if (!held || !connected) return;
    const c = new AbortController();
    hold.current = c.signal;
    return () => c.abort();
  }, [held, connected]);
  const copyOut = copyOutFrom(status, setup);
  const syncs = held && conn.kind === "live";
  /** This computer's clipboard text into the screen's. `always`: even if it went in or came out last. */
  const pasteIn = (always = false): Promise<PasteOutcome | undefined> => {
    const client = rfb.current;
    const signal = hold.current;
    return client && signal ? bridge.paste((text) => client.clipboardPasteFrom(text), signal, always) : Promise.resolve(undefined);
  };
  /** The screen's clipboard text onto this computer's. */
  const copyOutOf = (always = false): Promise<CopyOutcome | undefined> => {
    const signal = hold.current;
    return copyOut && signal ? bridge.copy(() => api.readClipboard(copyOut, signal), signal, always) : Promise.resolve(undefined);
  };
  // Each way only when it changed, and quietly: the buttons say what happened.
  const syncIn = () => void (syncs && pasteIn().catch(() => {}));
  const syncOut = () => void (syncs && copyOutOf().catch(() => {}));

  useEffect(() => () => detach(), [detach]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      noteStatus(await api.start());
      setConn({ kind: "idle" });
    });
  const checkAgain = () =>
    act(async () => {
      setFound(undefined);
      // Once the Screen has tried to add the browser, one found now is added, and the dock is written again.
      const s = setup.kind === "checked" ? await recheckBrowser(setupDeps()) : await refresh();
      const b = s && browserOf(s);
      setFound(b?.kind === "found" ? b.path : undefined);
    });
  /** Stops the screen (Hermes refuses while a person holds it), lets its dock be written again, and starts it. */
  const restart = () =>
    act(async () => {
      await api.stop();
      detach();
      if (status) await api.resetDock(status.profile_key);
      noteStatus(await api.start());
      setConn({ kind: "idle" });
      setSetup((s) => (s.kind === "checked" ? { ...s, dock: { kind: "current" } } : s));
    });
  const pasteHere = () =>
    act(async () => {
      setClipNote(undefined);
      const outcome = await pasteIn(true).catch((e: unknown) => void (isAbort(e) || setClipNote({ text: errorText(e), bad: true })));
      if (outcome) setClipNote({ text: PASTED[outcome], bad: outcome !== "pasted" });
      rfb.current?.focus();
    });
  const copyOutNow = () =>
    act(async () => {
      setClipNote(undefined);
      const outcome = await copyOutOf(true).catch((e: unknown) => void (isAbort(e) || setClipNote({ text: errorText(e), bad: true })));
      if (outcome) setClipNote({ text: COPIED[outcome], bad: outcome === "empty" });
    });
  const takeOver = () => act(async () => viewer && noteLease(await api.takeOver(viewer.id)));
  const handBack = () => act(async () => viewer && noteLease(await api.handBack(viewer.id)));

  const phase = status && phaseOf(status);
  const heldBefore = lease?.holder === "human" && !held && !!lease.viewer_hash && pastHolds.current.has(lease.viewer_hash);
  const someoneElse = lease?.holder === "human" && !held && !heldBefore;

  let body;
  if (unavailable)
    body = <Note title="This Hermes has no screen">The Bot Desktop came with Hermes in September 2026. Update Hermes on the server to use it.</Note>;
  else if (!status)
    body = error ? (
      <Note title="Couldn't ask Hermes about its screen" bad>
        {error}
      </Note>
    ) : (
      <div className="preview-state" role="status">
        <Spinner /> {connected ? "Asking Hermes about its screen…" : "Waiting for the connection…"}
      </div>
    );
  else if (phase?.kind === "unsupported") body = <Note title="This server can't run a screen">Hermes runs its Bot Desktop only on a Linux server.</Note>;
  else if (phase?.kind === "not-installed")
    body = (
      <Note title="The screen isn't installed on the server">
        Hermes needs {phase.missing.length ? <span className="mono">{phase.missing.join(", ")}</span> : "a few desktop packages"} for it.
        {phase.command && (
          <>
            {" "}
            Run this on the server, in the Terminal tab for one, then refresh:
            <CopyCommand command={phase.command} />
          </>
        )}
      </Note>
    );
  else if (phase?.kind === "blocked") body = <Note title="The screen can't start now">{phase.why}</Note>;
  else if (phase?.kind === "stopped")
    body = (
      <div className="screen-start">
        <MonitorPlay size={28} aria-hidden />
        <p>
          Hermes's own screen on the server{status.geometry ? ` (${status.geometry})` : ""}, where its computer use and its browser run. Start it to watch
          the agent work, and take over when it needs you for a sign-in or a CAPTCHA.
        </p>
        <p className="muted small">The agent drives it with the Computer use toolset (Settings → Toolsets). Hermes stops a screen nobody has used for a while.</p>
        <button className="btn primary" disabled={busy || !connected} onClick={() => void start()}>
          {busy ? <Spinner /> : <Play size={14} />} Start the screen
        </button>
      </div>
    );

  const live = phase?.kind === "live";
  const apps = setup.kind === "checked" ? setup.apps : {};
  // While the browser is being added, the note about none waits; it is what shows if adding it fails.
  const addingBrowser =
    (!!status && canSetUp(status) && setup.kind === "unchecked") || setup.kind === "checking" || apps.browser?.kind === "installing" || apps.browser?.kind === "added";
  const noBrowser = !unavailable && status && browserOf(status).kind === "missing" && !addingBrowser;
  return (
    <div className="screen-tab" hidden={!shown}>
      <div className="screen-bar">
        <span className={`screen-who ${held || heldBefore ? "you" : someoneElse ? "other" : ""}`} role="status">
          {!live
            ? "Bot Desktop"
            : held
              ? "You're in control. Hermes's computer use waits until you hand back."
              : heldBefore
                ? "You still have control from before the connection dropped, so Hermes's computer use is waiting. Take over to carry on here, then hand back."
                : someoneElse
                  ? "Someone else has taken over this screen."
                  : "Watching: Hermes is in control."}
        </span>
        <span className="terminal-spacer" />
        {live && held && (
          <>
            <button className="btn" disabled={busy || !connected || conn.kind !== "live"} onClick={() => void pasteHere()} title="Puts this computer's copied text on the screen's clipboard, for Ctrl+V there">
              <ClipboardPaste size={14} /> Paste here
            </button>
            {copyOut && (
              <button className="btn" disabled={busy || !connected} onClick={() => void copyOutNow()} title="Puts the text copied on the screen on this computer's clipboard">
                <ClipboardCopy size={14} /> Copy out
              </button>
            )}
          </>
        )}
        {live &&
          (held ? (
            <button className="btn primary" disabled={busy || !connected} onClick={() => void handBack()} title="Gives the screen back to Hermes">
              <Hand size={14} /> Hand back
            </button>
          ) : (
            <button className="btn" disabled={busy || !connected || !viewer || conn.kind !== "live"} onClick={() => void takeOver()} title="Your keys and pointer drive the screen; Hermes's computer use waits">
              <MousePointer2 size={14} /> Take over
            </button>
          ))}
        <button className="icon-btn" title="Ask Hermes again" aria-label="Refresh the screen" disabled={!connected} onClick={() => void refresh()}>
          <RefreshCw size={15} />
        </button>
      </div>
      {error && status && (
        <div className="attach-note" role="alert">
          {error}
        </div>
      )}
      {clipNote && (
        <div className={`attach-note ${clipNote.bad ? "" : "screen-found"}`} role="status">
          {clipNote.text}
        </div>
      )}
      {found && (
        <div className="attach-note screen-found" role="status">
          Hermes found a browser on the server: <span className="mono">{found}</span>
        </div>
      )}
      {noBrowser && (
        <Note title="No Chrome or Chromium on the Hermes server" className="screen-browser">
          {apps.browser?.kind === "failed" && <div className="screen-apps-why">Highwing couldn't install Chromium: {apps.browser.why}</div>}
          So the agent can't open a browser on its screen. Run this on the server, in the Terminal tab for one, then check again:
          <CopyCommand command={BROWSER_FIX} />
          <div className="small">Or set browser.executable_path in this profile's config to a Chrome or Chromium on the server.</div>
          <div className="preview-state-actions">
            <button className="btn" disabled={busy || !connected} onClick={() => void checkAgain()}>
              {busy ? <Spinner /> : <RefreshCw size={14} />} Check again
            </button>
          </div>
        </Note>
      )}
      {setup.kind === "checked" && (
        <AppsNote
          setup={setup}
          busy={busy}
          connected={connected}
          onPassword={(password) => void installSystem(setupDeps(), idsIn(setup, "needs-password"), password)}
          onAgain={(ids) => void installSystem(setupDeps(), ids)}
          onSkip={(ids) => {
            for (const id of ids) skipped.current.add(id);
            setSetup(skip(ids));
          }}
          onRestart={() => void restart()}
        />
      )}
      {evicted && conn.kind !== "live" && (
        <div className="attach-note" role="status">
          Someone else took over, so you're watching again.
        </div>
      )}
      {body}
      <div
        className={`screen-view ${held ? "held" : ""}`}
        hidden={!live}
        role="region"
        aria-label="Hermes's screen"
        onFocus={syncIn}
        onPointerEnter={syncIn}
        onBlur={syncOut}
        onPointerLeave={syncOut}
      >
        <div className="screen-canvas" ref={host} />
        {live && conn.kind !== "live" && (
          <div className="preview-state preview-loading" role={conn.kind === "lost" ? "alert" : "status"}>
            {conn.kind === "lost" ? (
              <>
                <AlertTriangle size={18} />
                <div>
                  <div className="preview-state-title">Not showing the screen</div>
                  <div>{conn.why}</div>
                  <div className="preview-state-actions">
                    <button className="btn" disabled={!connected} onClick={() => void attach()}>
                      <RefreshCw size={14} /> Reconnect
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Spinner /> Connecting to the screen…
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const PASTED: Record<PasteOutcome, string> = {
  pasted: "Pasted on the screen's clipboard. Press Ctrl+V on the screen to paste it there.",
  same: "Pasted on the screen's clipboard. Press Ctrl+V on the screen to paste it there.",
  empty: "This computer's clipboard has no text to paste.",
  "too-long": `This computer's clipboard holds more than ${MAX_TEXT_BYTES / 1024} KiB of text, more than the screen takes.`,
};
const COPIED: Record<CopyOutcome, string> = {
  copied: "Copied the screen's clipboard to this computer.",
  same: "Copied the screen's clipboard to this computer.",
  empty: "The screen's clipboard has no text to copy.",
};

const idsIn = (setup: Extract<AppsSetup, { kind: "checked" }>, kind: AppState["kind"]) =>
  (Object.keys(setup.apps) as ScreenAppId[]).filter((id) => setup.apps[id]?.kind === kind);

/** Not run, cut off, or not able to tell what the server has. */
const unsettled = (setup: AppsSetup) => setup.kind !== "checked" || idsIn(setup, "unknown").length > 0 || unfinished(setup).length > 0;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * What the Screen is adding to the screen (screenApps.ts), the terminal and editor's password, and what to do when
 * that can't be done. A browser that failed shows in the note about none instead.
 */
function AppsNote({
  setup,
  busy,
  connected,
  onPassword,
  onAgain,
  onSkip,
  onRestart,
}: {
  setup: Extract<AppsSetup, { kind: "checked" }>;
  busy: boolean;
  connected: boolean;
  onPassword: (password: string) => void;
  onAgain: (ids: ScreenAppId[]) => void;
  onSkip: (ids: ScreenAppId[]) => void;
  onRestart: () => void;
}) {
  const [password, setPassword] = useState("");
  const installing = idsIn(setup, "installing");
  const asking = idsIn(setup, "needs-password");
  const wrong = asking.some((id) => (setup.apps[id] as Extract<AppState, { kind: "needs-password" }>).wrong);
  const noSsh = idsIn(setup, "no-ssh");
  const failed = idsIn(setup, "failed").filter((id) => id !== "browser");
  const added = idsIn(setup, "added");
  const dockApps = added.filter((id) => SCREEN_APPS.find((a) => a.id === id)?.inDock);
  const others = added.filter((id) => !dockApps.includes(id));
  const firstOf = <K extends AppState["kind"]>(ids: ScreenAppId[]) => setup.apps[ids[0]] as Extract<AppState, { kind: K }>;
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    // Held no longer than the press: it goes to ssh's stdin and nowhere else.
    setPassword("");
    onPassword(password);
  };
  return (
    <>
      {installing.length > 0 && (
        <div className="attach-note screen-apps" role="status">
          <Spinner /> Adding {namesOf(installing)} to the screen…
        </div>
      )}
      {asking.length > 0 && (
        <Note title={`Adding ${namesOf(asking)} needs the server's sudo password`} className="screen-apps">
          {wrong ? "That password didn't work. Try it again." : "They come from the server's package manager, which needs root. Type the sudo password of the account Highwing signs in to over SSH."}
          <form className="screen-apps-password" onSubmit={send}>
            <input
              type="password"
              aria-label="Sudo password on the server"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!connected}
            />
            <button className="btn primary" type="submit" disabled={!password || !connected}>
              Install
            </button>
            <button className="btn" type="button" onClick={() => onSkip(asking)}>
              Not now
            </button>
          </form>
          <div className="small">It goes to sudo on the server and isn't kept.</div>
        </Note>
      )}
      {noSsh.length > 0 && (
        <Note title={`Highwing can't add ${namesOf(noSsh)} without SSH`} className="screen-apps">
          This connection has no SSH route, and they need root on the server. Run this there, in a terminal of your own, then check again:
          <CopyCommand command={firstOf<"no-ssh">(noSsh).command} />
          <div className="preview-state-actions">
            <button className="btn" disabled={!connected} onClick={() => onAgain(noSsh)}>
              <RefreshCw size={14} /> Check again
            </button>
          </div>
        </Note>
      )}
      {failed.length > 0 && (
        <Note title={`Couldn't add ${namesOf(failed)} to the screen`} className="screen-apps">
          <div className="screen-apps-why">{firstOf<"failed">(failed).why}</div>
          <div className="preview-state-actions">
            <button className="btn" disabled={!connected} onClick={() => onAgain(failed)}>
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        </Note>
      )}
      {added.length > 0 && (
        <div className="attach-note screen-apps screen-found" role="status">
          <Check size={14} aria-hidden />
          {others.length > 0 && <> Added {namesOf(others)}.</>}
          {dockApps.length > 0 && setup.dock.kind === "pending" && <> Added {namesOf(dockApps)} to the screen.</>}
          {dockApps.length > 0 && setup.dock.kind === "current" && <> Added {namesOf(dockApps)} to the screen's dock.</>}
          {dockApps.length > 0 && setup.dock.kind === "restart" && (
            <>
              {" "}
              Added {namesOf(dockApps)} to the screen. It is running on its old dock, so they show in the dock after a restart. Restarting stops whatever the agent
              is doing there, and a sign-in made on the screen in the last half minute may be lost.
              <button className="btn" disabled={busy || !connected} onClick={onRestart}>
                {busy ? <Spinner /> : <RefreshCw size={14} />} Restart the screen
              </button>
            </>
          )}
          {dockApps.length > 0 && setup.dock.kind === "failed" && (
            <>
              {" "}
              Added {namesOf(dockApps)} to the screen, but couldn't update its dock: {setup.dock.why}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Note({ title, bad, className = "", children }: { title: string; bad?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={`preview-state ${bad ? "preview-error" : ""} ${className}`} role={bad ? "alert" : "note"}>
      <AlertTriangle size={18} />
      <div>
        <div className="preview-state-title">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}
