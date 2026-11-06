# Rail inbox

The rail's Inbox button opens a list of what needs the owner or has finished, in every profile: Approvals, failures, running replies and Unread chats. Each entry can be dismissed by hand. Clear done dismisses every completed entry shown. Settings → Chats, Rail inbox, "Auto-dismiss finished chats after" dismisses completed entries older than the set time on their own. Dismissals are kept on this computer only.

## Sub-features

- `open`: the rail button, labelled `Inbox, N need you`, opens the list. Check now reads the other profiles again.
- `dismiss`: an entry's × dismisses that one.
- `clear-done`: Clear done, in the header, dismisses the completed entries under the current filter.
- `auto-dismiss`: the setting, Off by default, dismisses completed entries older than 1 day, 2 days, 1 week or 2 weeks.

## How to get to it (user POV)

- The Inbox button on the rail.
- Settings (Ctrl+,) → Chats → Rail inbox, for the auto-dismiss setting.

## Driving it with wd.mjs

Preconditions:

- `HV_INBOX=1 $S/hv up`, so `work` holds "Morning brief, Monday" (Unread, 3 days old) and "Convert 12 GB to MB" (Unread, an hour old). Then sign in per [sign-in.md](sign-in.md).

- **A failure and an Approval.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'fail this one\n'` and `$S/wd.mjs wait .msg overloaded`. Then do the same with `'needs approval to run\n'`. The rail button reads `Inbox, 4 need you`.
- **Open.** Run `$S/wd.mjs click button "Inbox, 4 need you"`, then `$S/wd.mjs click button "Check now"`. List the rows with `$S/wd.mjs eval 'return [...document.querySelectorAll(".inbox-row")].map(r=>r.className+" | "+r.querySelector(".inbox-title").textContent).join("\n")'`. There are four: approval, failed, and two completed.
- **Auto-dismiss.** Run `$S/wd.mjs press Escape`, `$S/wd.mjs press Control+,`, `$S/wd.mjs click button Chats` and `$S/wd.mjs click '[aria-labelledby=inbox-auto-dismiss-label] button' "2 days"`. The rail button reads `Inbox, 3 need you` at once. Open the inbox and press Check now. "Morning brief, Monday" is gone, and the other three stay.
- **It is stored.** Read `$S/wd.mjs eval 'return Object.entries(localStorage).filter(([k])=>k.startsWith("hermes-chat.inbox-dismissed.")).map(([k,v])=>v).join("\n")'`. It shows `completed work brief` with `[its time, now]`. Set the setting back to Off, then `$S/wd.mjs close`, `$S/wd.mjs open` and sign in again. The entry is still gone.
- **Clear done.** With the inbox open, run `$S/wd.mjs click button "Clear done"`. Every completed row goes, Approvals and failures stay, and the button is gone.
- **Nothing reaches Hermes.** `bridge.log` has no PATCH for `brief` or `convert`.

## Gotchas

- A failure is seen only on the socket, and Hermes keeps no error row a reload can read. After a relaunch, make a new one with a `fail…` prompt.
- The other profiles are read every two minutes. Press Check now rather than waiting.
