// Settings for the global shortcut that brings Hermes Chat forward from any app (ADR 0033). Rust registers it and
// keeps the setting (src-tauri/src/summon.rs); this shows what actually registered, never just what was chosen.
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import type { SummonApi, SummonStatus } from "../hermes/summon";
import { hyprlandBind, summonCommand, swayBind } from "../hermes/summon";
import { DEFAULT_GLOBAL_SHORTCUT, checkGlobalShortcut, onlyModifiers, shortcutLabel, shortcutOf } from "./shortcut";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The status Rust reports, read once and kept current. `set` takes a status a change answered with. */
export function useSummonStatus(api?: SummonApi) {
  const [status, setStatus] = useState<SummonStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.status().then(
      (s) => live && setStatus(s),
      (e) => live && setError(`Couldn't check the global shortcut: ${message(e)}`),
    );
    const stop = api.onStatus((s) => live && setStatus(s));
    return () => {
      live = false;
      stop();
    };
  }, [api]);
  return { status, setStatus, error };
}

export function GlobalShortcutSettings({
  api,
  status,
  setStatus,
  loadError,
  screenshotShortcut,
}: {
  /** Left out where there is no desktop app. */
  api?: SummonApi;
  status?: SummonStatus;
  setStatus: (s: SummonStatus) => void;
  loadError?: string;
  /** The screenshot shortcut, which this one mustn't take. */
  screenshotShortcut: string | null;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  // Recording lets go of the X11 grab, so pressing the key in use reaches the recorder; stopping takes it back.
  useEffect(() => {
    if (!recording || !api) return;
    void api.pause(true).then(setStatus, () => {});
    return () => void api.pause(false).then(setStatus, () => {});
  }, [recording, api, setStatus]);

  if (!api)
    return (
      <section className="global-shortcut-settings">
        <h2>Show Hermes Chat from anywhere</h2>
        <p className="muted small">A global shortcut works only in the desktop app.</p>
      </section>
    );

  const change = async (run: () => Promise<SummonStatus>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      setStatus(await run());
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  /** Every way of setting a shortcut goes through the same checks. */
  const choose = (s: string) => {
    const { error } = checkGlobalShortcut(s, screenshotShortcut);
    if (error) return setProblem(`${shortcutLabel(s)}: ${error}`);
    void change(() => api.set(s));
  };

  /** Retry too: the screenshot shortcut may have taken the keys since they failed. */
  const retry = (s: string) => {
    const { error } = checkGlobalShortcut(s, screenshotShortcut);
    if (error) return setProblem(`${shortcutLabel(s)}: ${error}`);
    void change(() => api.retry());
  };

  const record = (e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setRecording(false);
      setProblem(undefined);
      return;
    }
    if (onlyModifiers(e)) return;
    const s = shortcutOf(e.nativeEvent);
    if (!s) return setProblem("Use a letter, a number, F1 to F24, or Print Screen, with Ctrl, Alt or Super.");
    setRecording(false);
    choose(s);
  };

  const shortcut = status?.shortcut ?? null;
  const pending = busy || status?.state === "pending";
  const failure = status?.failure;
  const warning = shortcut ? checkGlobalShortcut(shortcut, null).warning : undefined;
  const command = summonCommand(!!status?.hideWhenActive);
  const keys = shortcut ?? DEFAULT_GLOBAL_SHORTCUT;
  const desktopBinding = status && (status.backend !== "x11" || status.wayland);

  return (
    <section className="global-shortcut-settings">
      <h2>Show Hermes Chat from anywhere</h2>
      <p className="muted">
        A shortcut that brings this window forward from any app, with the cursor in the message you were writing in the chat you had selected.
        It's kept on this computer, for every server and profile.
      </p>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="global-shortcut-label">
            Global shortcut
          </div>
          <div className="muted small">{status?.backend === "none" ? "Used for the desktop binding below." : "Works while you're in any app."}</div>
        </div>
        <div className="shortcut-controls">
          <button
            className={`btn shortcut-key ${recording ? "recording" : ""}`}
            aria-labelledby="global-shortcut-label"
            aria-describedby="global-shortcut-help"
            disabled={pending || !status}
            onClick={() => {
              setRecording(true);
              setProblem(undefined);
            }}
            onKeyDown={record}
            onBlur={() => setRecording(false)}
          >
            {recording ? "Press the shortcut…" : shortcut ? shortcutLabel(shortcut) : "Off"}
          </button>
          {shortcut && (
            <button className="btn" disabled={pending} onClick={() => void change(() => api.set(null))}>
              Turn off
            </button>
          )}
          {/* Through the portal the desktop may have set another key than the one asked for, so Reset asks again. */}
          {(shortcut !== DEFAULT_GLOBAL_SHORTCUT || status?.backend === "portal") && (
            <button className="btn" disabled={pending || !status} onClick={() => choose(DEFAULT_GLOBAL_SHORTCUT)}>
              Reset to {shortcutLabel(DEFAULT_GLOBAL_SHORTCUT)}
            </button>
          )}
        </div>
      </div>
      <p id="global-shortcut-help" className="muted settings-note">
        {recording
          ? `Press the keys together, or Esc to keep the current shortcut.${status?.backend === "x11" ? " If nothing happens, another app already has those keys." : ""}`
          : "Click the shortcut to change it."}
      </p>
      {(problem || loadError) && (
        <p className="sign-in-error settings-note" role="alert">
          {problem ?? loadError}
        </p>
      )}
      {failure && !pending && (
        <div className="shortcut-failure settings-note" role="alert">
          <p className="sign-in-error">
            {failure.message}{" "}
            {shortcut && status?.state === "working"
              ? `${shortcutLabel(shortcut)} still works.`
              : "No global shortcut works now."}
            {failure.kind === "conflict" && " Pick other keys, or free them in the other app and retry."}
          </p>
          <button className="btn" onClick={() => retry(failure.shortcut)}>
            Retry {shortcutLabel(failure.shortcut)}
          </button>
        </div>
      )}
      {status && <StatusLine status={status} pending={pending} />}
      {!problem && !failure && warning && status?.state !== "unavailable" && (
        <p className="warn-note settings-note" role="status">
          {warning}
        </p>
      )}

      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="global-shortcut-hide-label">
            Hide when already in front
          </div>
          <div className="muted small">
            Pressing the shortcut while Hermes Chat is the window you're using hides it. Off: it stays where it is.
          </div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={!!status?.hideWhenActive}
          aria-labelledby="global-shortcut-hide-label"
          disabled={!status || busy}
          onClick={() => status && void change(() => api.setHide(!status.hideWhenActive))}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {desktopBinding && (
        <>
          <h3>{status.backend === "none" ? "Bind a key in your desktop" : "Or bind a key in your desktop"}</h3>
          <p className="muted small">
            Make a key in your desktop's own keyboard settings run <code>{command}</code>.{" "}
            {status.hideWhenActive ? "It brings Hermes Chat forward, or hides it when it's already in front." : "It brings Hermes Chat forward."} If
            Hermes Chat isn't open, it starts.
          </p>
          <ul className="muted small shortcut-examples">
            <li>
              Hyprland, in <code>hyprland.conf</code>: <code>{hyprlandBind(keys, `exec, ${command}`)}</code>
            </li>
            <li>
              Sway, in its config: <code>{swayBind(keys, command)}</code>
            </li>
            <li>GNOME or KDE Plasma: add a custom shortcut in the Keyboard settings with that command.</li>
          </ul>
          <p className="muted small">
            If Hermes Chat might not be open yet, run <code>env WEBKIT_DISABLE_DMABUF_RENDERER=1 {command}</code> instead, as the app's launcher does.
          </p>
          {status.backend === "portal" && (
            <p className="muted small">Use one or the other: if your desktop already set the shortcut above to those keys, don't bind them again.</p>
          )}
        </>
      )}
    </section>
  );
}

function StatusLine({ status, pending }: { status: SummonStatus; pending: boolean }) {
  const label = status.shortcut ? shortcutLabel(status.shortcut) : "";
  let text: ReactNode;
  if (pending) text = status.backend === "portal" ? "Registering… your desktop may ask you to confirm the shortcut." : "Registering…";
  else if (status.state === "unavailable")
    text = (
      <>
        This desktop doesn't let apps register a global shortcut ({status.unavailable}). Bind a key in your desktop instead, as below.
      </>
    );
  else if (status.state === "off") text = "Off. No key is registered.";
  else if (status.state === "failed") return null;
  else if (status.paused) text = `${label} is paused while you record a new shortcut.`;
  else if (status.backend === "x11") text = `Working: ${label} brings Hermes Chat forward from any app.`;
  else if (status.trigger) text = `Working: your desktop says the shortcut is ${status.trigger}.`;
  else if (status.desktop === "hyprland")
    text = (
      <>
        Registered with Hyprland, which doesn't set keys for apps. Add this to <code>hyprland.conf</code> to use {label}:{" "}
        <code>{hyprlandBind(status.shortcut ?? DEFAULT_GLOBAL_SHORTCUT, `global, ${status.hyprlandName ?? ":hermes-chat"}`)}</code>
        {!status.hyprlandName && " (hyprctl didn't list it, so check its name with hyprctl globalshortcuts)"}
      </>
    );
  else text = "Registered with your desktop, which hasn't set a key for it yet. Set one in its keyboard settings, under Hermes Chat.";
  const bad = status.state === "unavailable";
  return (
    <p className={`small settings-note ${bad ? "warn-note" : "muted"}`} role="status" data-testid="global-shortcut-status">
      {text}
    </p>
  );
}
