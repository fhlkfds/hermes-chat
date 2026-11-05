// Settings for what the app shows when it starts. Kept in the display preferences (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

export function StartupSettings() {
  const { reopenLastChat } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <SettingsSection title="On launch">
      <SettingRow
        name="Reopen last chat on launch"
        nameId="reopen-last-chat-label"
        hint="Open the chat you had on screen when the app closed, in each profile. Off: the app starts on a new chat."
        control={
          <button
            className="switch"
            role="switch"
            aria-checked={reopenLastChat}
            aria-labelledby="reopen-last-chat-label"
            onClick={() => setUIPrefs({ reopenLastChat: !reopenLastChat })}
          >
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
