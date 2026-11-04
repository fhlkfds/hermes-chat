// Settings for screenshots: the in-app shortcut (kept in the display preferences, uiPrefs.ts), how to add one that works
// from anywhere on the desktop, and how screenshots are taken on this desktop.
import { type KeyboardEvent, useEffect, useState, useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import type { ScreenshotSupport } from "../hermes/tauriScreenshot";
import { DEFAULT_SCREENSHOT_SHORTCUT, checkShortcut, onlyModifiers, shortcutLabel, shortcutOf } from "./shortcut";

const COMMAND = "hermes-chat --screenshot";

/** `checkSupport`: how screenshots are taken on this desktop, or why they can't be. */
export function ScreenshotSettings({ checkSupport }: { checkSupport?: () => Promise<ScreenshotSupport> }) {
  const { screenshotShortcut } = useSyncExternalStore(subscribe, getUIPrefs);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [support, setSupport] = useState<ScreenshotSupport>();

  useEffect(() => {
    let live = true;
    checkSupport?.().then(
      (s) => live && setSupport(s),
      (e) => live && setSupport({ ok: false, summary: `Couldn't check: ${e instanceof Error ? e.message : String(e)}` }),
    );
    return () => void (live = false);
  }, [checkSupport]);

  const warning = screenshotShortcut ? checkShortcut(screenshotShortcut).warning : undefined;

  const record = (e: KeyboardEvent) => {
    if (!recording) return;
    // Nothing pressed while recording reaches the app's own shortcuts, or the screenshot one.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setRecording(false);
      setProblem(undefined);
      return;
    }
    if (onlyModifiers(e)) return;
    const s = shortcutOf(e.nativeEvent);
    if (!s) return setProblem("Use a letter, a number, F1 to F24, or Print Screen, with Ctrl, Alt, Shift or Super.");
    const { error } = checkShortcut(s);
    if (error) return setProblem(`${shortcutLabel(s)}: ${error}`);
    setUIPrefs({ screenshotShortcut: s });
    setProblem(undefined);
    setRecording(false);
  };

  return (
    <section className="screenshot-settings">
      <h2>Screenshots</h2>
      <p className="muted">
        Take a screenshot of a region or a window and attach it to the message you're writing. You see it in the composer before you send it, and
        can remove it. It stays on this computer until you send the message, and is deleted from this computer once Hermes has the message or you
        remove it.
      </p>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="screenshot-shortcut-label">
            Screenshot shortcut
          </div>
          <div className="muted small">Works while Hermes Chat is the window you're using.</div>
        </div>
        <div className="shortcut-controls">
          <button
            className={`btn shortcut-key ${recording ? "recording" : ""}`}
            aria-labelledby="screenshot-shortcut-label"
            aria-describedby="screenshot-shortcut-help"
            onClick={() => {
              setRecording(true);
              setProblem(undefined);
            }}
            onKeyDown={record}
            onBlur={() => setRecording(false)}
          >
            {recording ? "Press the shortcut…" : screenshotShortcut ? shortcutLabel(screenshotShortcut) : "Off"}
          </button>
          {screenshotShortcut ? (
            <button className="btn" onClick={() => setUIPrefs({ screenshotShortcut: null })}>
              Turn off
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => setUIPrefs({ screenshotShortcut: DEFAULT_SCREENSHOT_SHORTCUT })}
            >
              Use {DEFAULT_SCREENSHOT_SHORTCUT}
            </button>
          )}
        </div>
      </div>
      <p id="screenshot-shortcut-help" className="muted settings-note">
        {recording ? "Press the keys together, or Esc to keep the current shortcut." : "Click the shortcut to change it."}
      </p>
      {problem && (
        <p className="sign-in-error settings-note" role="alert">
          {problem}
        </p>
      )}
      {!problem && warning && (
        <p className="warn-note settings-note" role="status">
          {warning}
        </p>
      )}

      <h3>From anywhere on your desktop</h3>
      <p className="muted small">
        On Wayland, apps can't see key presses meant for other windows, so a shortcut that works while you're in another app has to be set up in
        your desktop's own keyboard settings. Make it run <code>{COMMAND}</code>. If Hermes Chat is open, the screenshot goes to the chat on screen;
        if not, Hermes Chat opens and takes it once you're signed in.
      </p>
      <ul className="muted small shortcut-examples">
        <li>
          Hyprland, in <code>hyprland.conf</code>: <code>bind = SUPER SHIFT, S, exec, {COMMAND}</code>
        </li>
        <li>
          Sway, in its config: <code>bindsym $mod+Shift+s exec {COMMAND}</code>
        </li>
        <li>GNOME or KDE Plasma: add a custom shortcut in the Keyboard settings with that command.</li>
      </ul>
      <p className="muted small">
        Pick keys your desktop doesn't already use. If Hermes Chat might not be open yet, run{" "}
        <code>env WEBKIT_DISABLE_DMABUF_RENDERER=1 {COMMAND}</code> instead, as the app's launcher does.
      </p>
      <p className="muted small">
        To bring Hermes Chat forward from any app, bind a key the same way to <code>hermes-chat --toggle</code> (or <code>--show</code>, which
        never hides it), for example <code>bind = SUPER, H, exec, hermes-chat --toggle</code> in <code>hyprland.conf</code>.
      </p>

      <h3>On this desktop</h3>
      <p className={`small ${support && !support.ok ? "sign-in-error" : "muted"}`} role={support && !support.ok ? "alert" : undefined}>
        {support ? support.summary : checkSupport ? "Checking…" : "Screenshots work only in the desktop app."}
      </p>
    </section>
  );
}
