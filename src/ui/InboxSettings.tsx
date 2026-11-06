// How long a finished entry stays in the Rail inbox before it is dismissed on its own (hermes/inbox.ts `expire`). Kept
// in the display preferences (uiPrefs.ts), on this computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { INBOX_AUTO_DISMISS_DAYS, getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

const label = (days: number) => (days === 7 ? "1 week" : days === 14 ? "2 weeks" : `${days} ${days === 1 ? "day" : "days"}`);

export function InboxSettings() {
  const { inboxAutoDismissDays } = useSyncExternalStore(subscribe, getUIPrefs);
  // A time this version doesn't offer, from a newer app or a hand edit, shows as picked rather than as none.
  const days: number[] = [...INBOX_AUTO_DISMISS_DAYS];
  if (inboxAutoDismissDays !== null && !days.includes(inboxAutoDismissDays)) days.push(inboxAutoDismissDays);
  const choices = [null, ...days.sort((a, b) => a - b)];
  return (
    <SettingsSection title="Rail inbox">
      <SettingRow
        name="Auto-dismiss finished chats after"
        nameId="inbox-auto-dismiss-label"
        hint="Completed entries in the inbox opened from the rail, older than this, are dismissed on their own, as if dismissed by hand. Approvals, failures and running work never are."
        control={
          <div className="segmented" role="group" aria-labelledby="inbox-auto-dismiss-label">
            {choices.map((d) => (
              <button key={d ?? "off"} type="button" aria-pressed={inboxAutoDismissDays === d} onClick={() => setUIPrefs({ inboxAutoDismissDays: d })}>
                {d === null ? "Off" : label(d)}
              </button>
            ))}
          </div>
        }
      />
    </SettingsSection>
  );
}
