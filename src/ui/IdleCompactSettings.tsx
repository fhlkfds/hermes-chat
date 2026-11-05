// Settings → Model → Idle compaction (idleCompact.ts, ADR 0056): whether this app has Hermes compact a chat that has sat
// idle with its context window past a mark, the mark, and how long idle means. Kept on this computer and saved as it
// is changed; nothing here is written to Hermes.
import { useState, useSyncExternalStore } from "react";
import { IDLE_COMPACT_MINUTES, IDLE_COMPACT_PERCENTS, getUIPrefs, setUIPrefs, subscribe, type IdleCompactPrefs } from "../hermes/uiPrefs";

const minutes = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);

/** The choices offered, with the current value added where a newer app or a hand edit set another. */
const withCurrent = <T extends number>(choices: readonly T[], current: number) => (choices.includes(current as T) ? [...choices] : [...choices, current].sort((a, b) => a - b));

export function IdleCompactSettings() {
  const prefs = useSyncExternalStore(subscribe, getUIPrefs).idleCompact;
  const [unsaved, setUnsaved] = useState(false);
  const change = (patch: Partial<IdleCompactPrefs>) => setUnsaved(!setUIPrefs({ idleCompact: { ...prefs, ...patch } }));
  const on = prefs.enabled;
  return (
    <section>
      <h2>Idle compaction</h2>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="idle-compact-label">
            Compact idle chats
          </div>
          <div className="muted small" id="idle-compact-help">
            When a chat open in this app has had nothing happen in it for a while and its context window is past the mark below, Hermes compacts it, as
            Compact now does: older messages are swapped for a summary the model reads in their place. By then the provider's prompt cache has gone
            cold, so your next message would pay for the whole context anyway. Each idle chat is compacted once, until something happens in it again.
          </div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-labelledby="idle-compact-label"
          aria-describedby="idle-compact-help"
          onClick={() => change({ enabled: !on })}
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="model-grid">
        <label className="field model-field">
          <span className="field-label">When the context window is at least</span>
          <select className="select" aria-label="Idle compaction context fullness" value={prefs.percent} disabled={!on} onChange={(e) => change({ percent: Number(e.target.value) })}>
            {withCurrent(IDLE_COMPACT_PERCENTS, prefs.percent).map((p) => (
              <option key={p} value={p}>
                {p}% full
              </option>
            ))}
          </select>
          <span className="field-hint">As Hermes last measured it, shown in the status bar's meter.</span>
        </label>
        <label className="field model-field">
          <span className="field-label">And the chat has been idle for</span>
          <select className="select" aria-label="Idle compaction idle time" value={prefs.idleMinutes} disabled={!on} onChange={(e) => change({ idleMinutes: Number(e.target.value) })}>
            {withCurrent(IDLE_COMPACT_MINUTES, prefs.idleMinutes).map((m) => (
              <option key={m} value={m}>
                {minutes(m)}
              </option>
            ))}
          </select>
          <span className="field-hint">No reply, no message sent, nothing waiting on you.</span>
        </label>
      </div>
      <p className="muted small model-note">
        Kept on this computer, for every connection and profile, and runs only while Hermes Chat is open and connected. Only chats opened in this app since
        it connected are measured, so only they are compacted. Each compaction is a call to the profile's Compression model (Auxiliary models, on this page).
        Hermes's own compaction when the window fills during a reply works as before.
      </p>
      {unsaved && (
        <p className="sign-in-error settings-note" role="alert">
          Couldn't save this on this computer; it applies only until Hermes Chat closes.
        </p>
      )}
    </section>
  );
}
