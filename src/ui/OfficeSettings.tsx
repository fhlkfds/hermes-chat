// How the agent office shows (ADR 0077): as desks, as a list, or not at all. Kept in the display preferences
// (uiPrefs.ts), on this computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe, type OfficeView } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

const CHOICES: { value: OfficeView; label: string }[] = [
  { value: "desks", label: "Desks" },
  { value: "list", label: "List" },
  { value: "off", label: "Off" },
];

export function OfficeSettings() {
  const { agentOffice } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <SettingsSection title="Agent office">
      <SettingRow
        name="Office"
        nameId="agent-office-label"
        hint="Every reply and subagent at work as a desk, opened from the rail. Off hides the rail button."
        more={
          <p>
            <b>Desks</b> draws a room for each chat and a desk for each agent in it. <b>List</b> shows the same agents as rows,
            with the same actions. The office only shows what the Inbox and each chat's Subagents panel already know, and it
            never approves or starts anything. Nothing moves while it is closed, the window is hidden, or the system asks
            for reduced motion.
          </p>
        }
        control={
          <div className="segmented" role="group" aria-labelledby="agent-office-label">
            {CHOICES.map((c) => (
              <button key={c.value} type="button" aria-pressed={agentOffice === c.value} onClick={() => setUIPrefs({ agentOffice: c.value })}>
                {c.label}
              </button>
            ))}
          </div>
        }
      />
    </SettingsSection>
  );
}
