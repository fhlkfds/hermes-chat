// Settings → General → Tray: Close to tray, and whether this desktop shows the tray icon (tray.rs, ADR 0034). The
// setting is kept by Rust in the app's config folder, for this computer, and what shows is what Rust read back.
import { useEffect, useState } from "react";
import type { TrayStatus, TrayWiring } from "../hermes/tauriTray";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function where(s: TrayStatus): { text: string; problem: boolean } {
  if (s.tray === "shown") return { text: "The tray icon is showing. Its menu has Show or Hide, New chat, Open Inbox and Quit.", problem: false };
  if (s.tray === "noTray")
    return {
      text:
        "This desktop isn't showing tray icons right now. GNOME needs the AppIndicator extension for them; KDE Plasma, Xfce, waybar and i3bar show them. " +
        "Until one does, closing the window quits even with Close to tray on, so the window never disappears with no way back.",
      problem: true,
    };
  return { text: `${s.why ?? "The tray icon couldn't be made."} Closing the window quits.`, problem: true };
}

/** `tray`: left out where there's no desktop app to ask. */
export function TraySettings({ tray }: { tray?: TrayWiring }) {
  const [status, setStatus] = useState<TrayStatus>();
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!tray) return;
    let live = true;
    tray.status().then(
      (s) => live && setStatus(s),
      () => live && setChecked(true),
    );
    const stop = tray.onStatus((s) => live && setStatus(s));
    return () => {
      live = false;
      stop();
    };
  }, [tray]);

  const turn = async (on: boolean) => {
    if (!tray || saving) return;
    setSaving(true);
    setProblem(undefined);
    try {
      setStatus(await tray.setCloseToTray(on));
    } catch (e) {
      setProblem(`Couldn't ${on ? "turn on" : "turn off"} Close to tray: ${messageOf(e)}`);
      // Show what Rust has now, whichever way the write went.
      await tray.status().then(setStatus, () => {});
    } finally {
      setSaving(false);
    }
  };

  const on = !!status?.closeToTray;
  const here = status && where(status);
  return (
    <section>
      <h2>Tray</h2>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="close-to-tray-label">
            Close to tray
          </div>
          <div className="muted small" id="close-to-tray-help">
            Closing the window hides it in the tray instead of quitting. Replies keep arriving, drafts stay, and the tray icon or opening Hermes Chat
            again brings the same window back. Hiding it stops Dictation and Read aloud. Quit in the tray menu always exits. Off: closing the window
            quits.
          </div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-labelledby="close-to-tray-label"
          aria-describedby="close-to-tray-help"
          disabled={!status || saving}
          onClick={() => void turn(!on)}
        >
          <span className="switch-knob" />
        </button>
      </div>
      {/* Announced only when the tray can't be used, as Settings → Screenshots does. */}
      <p className={`small settings-note tray-note ${here?.problem ? "warn-note" : "muted"}`} role={here?.problem ? "status" : undefined}>
        {here ? here.text : !tray || checked ? "The tray works only in the desktop app." : "Checking the tray…"}
      </p>
      {problem && (
        <p className="sign-in-error settings-note" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
