// Settings for what the app shows when it starts. Kept in the display preferences (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";

export function StartupSettings() {
  const { reopenLastChat } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <section>
      <h2>On launch</h2>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="reopen-last-chat-label">
            Reopen last chat on launch
          </div>
          <div className="muted small">
            Open the chat you had on screen when the app closed, in each profile. Off: the app starts on a new chat.
          </div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={reopenLastChat}
          aria-labelledby="reopen-last-chat-label"
          onClick={() => setUIPrefs({ reopenLastChat: !reopenLastChat })}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </section>
  );
}
