// How the agent office shows (ADR 0077, ADR 0089): as a 3D building, as a list, or not at all. Kept in the display preferences
// (uiPrefs.ts), on this computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe, type OfficeView } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

const CHOICES: { value: OfficeView; label: string }[] = [
  { value: "building", label: "Building" },
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
        hint="Every reply and subagent at work, opened from the rail in place of the chats. Off hides the rail button."
        more={
          <p>
            <b>Building</b> draws a 3D building with a room for each state: the Workroom for agents at work, the Waiting
            room for those waiting for you, the Trouble room for failures, and the Lounge for the rest. Each agent is a
            character in its chat's team color. Hover a character for its name; a "!" marks each one waiting for you.
            Click one for its card. Drag to turn the view, scroll to zoom, double-click a room to look into it.{" "}
            <b>List</b> shows the same agents as rows, and is what the office shows on a computer that can't draw 3D.
            The office only shows what the Inbox and each chat's Subagents panel already know, and it never approves or
            starts anything. It draws nothing while no one moves, while it is closed, or while the window is hidden or
            not focused, and nothing moves when the system asks for reduced motion.
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
