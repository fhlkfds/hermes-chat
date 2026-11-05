# The agent office is desks drawn from the inbox and the subagent trees, read-only

Issue #105, its first delivery stage: a read-only office. The owner wants agent work shown as an optional visual office, with a practical list beside it, built on the attention inbox (ADR 0019, #67) and the subagent tree (ADR 0072, #95). Task assignment and decorative customization are later stages and aren't built here.

## Decisions

- **No new source of truth.** `officeRooms` (`src/hermes/office.ts`) is a pure function of what the app already has: the Rail inbox's entries (`inboxEntries`) and each chat's subagent tree (`Chat.subagents`). It reads nothing from Hermes, keeps nothing, and is worked out only while the office is open.
- **A room per chat, a desk per agent.** A room is a chat the inbox lists, in any profile, in the inbox's order, then a chat in the profile shown whose subagents this connection has heard of. Its first desk is the chat's reply. Its subagents follow, depth first, each after the one that started it.
- **The reply's state is the inbox's.** When the inbox has several entries for one chat, the desk shows the most pressing: an Approval, then running, failed, may not have sent, completed. Running work and a waiting Approval always show. Failures and completions go once the owner dismisses them in the inbox, so the office and the inbox agree on what is still news. A chat with subagents but no entry shows its reply as **Not running**.
- **A subagent's state is the tree's.** Queued, running, finished, failed (Hermes's `failed`, `error` and `timeout`), stopped (`interrupted`), ended and not known yet map one to one.
- **Finished only on Hermes's word.** A subagent is Finished only after Hermes's `subagent.complete` says `completed`. A reply is Finished only when the inbox says Completed. A subagent that ended without Hermes saying how is Ended, never Finished. There is no celebration effect, only the word and a check mark.
- **Stale never looks current.** A desk is "as last seen" when the app isn't connected, when the inbox's check of its profile failed, or when its chat's tree is lost or unchecked (ADR 0072). Such a desk says so in its label and in words, is dashed and greyed, and its screen doesn't move. While disconnected, a reply with no entry is **Not known yet**, since the transport clears a reply's running state on a drop.
- **A desk only opens.** The reply's desk goes where its inbox entry goes: its chat, switching profile first (asking if something would be left behind, as the inbox does), at the Approval card or the failure. A subagent's desk opens its chat and the subagent's own view in the Subagents panel, which focuses its heading. Nothing is approved, answered, retried, steered, stopped or sent from the office. Steer and Stop stay in the Subagents panel, behind its own confirmation.
- **Desks and List are one view of the same rooms.** Both render the same `Room[]`, give each desk the same accessible name, and call the same open. The arrow keys, Home and End move between desks in reading order in either view; Enter opens; Escape closes.
- **Motion is decoration, and stops.** Only a running, current desk moves: three dots on its screen pulse. They stop when the system asks for reduced motion (`prefers-reduced-motion`, read in JS and CSS), while the page is hidden, and while the window is hidden to the tray. Closed, the office isn't mounted. The Rail inbox's checks of other profiles run while the office is open and the window shows, and stop when either changes.
- **One setting, three values.** `agentOffice` in the display preferences: `desks` (the default), `list`, or `off`. Off removes the rail button and the office with it. Picking Desks or List in the office writes the same setting. It is kept on this computer only.
- **The look.** Each room is a bordered card titled with the chat, and its profile when it isn't the one shown. Each desk is a small monitor on a desk top, with the agent's name and state under it. The monitor's screen carries the state as an icon and a tint from the theme's status colors: accent for running, warn for an Approval or a message that may not have sent, bad for failed, ok for finished, and a dark, switched-off screen for stopped, ended, not running and not known yet. The reply's desk top is accent-colored, so it reads as the room's lead. The state is always in words too, so nothing depends on color. The drawing is CSS on the existing tokens: no images, no new dependencies, and it follows the theme, light and dark.

## Considered options

- **A canvas or sprite office with characters walking between desks.** More charming, but it needs a render loop, art, and its own accessibility layer, and the issue asks to limit animation and CPU. Rejected for this stage. Decorative customization is a later stage, and can build on these rooms.
- **Its own feed of agents**, such as Hermes's `subagent.roster` or a poll of every chat's `subagent.list`. That would be a second source that could disagree with the inbox and the Subagents panel. Rejected: the issue asks to build on them.
- **A desk per inbox entry**, rather than per agent. A chat with a failure and an unread reply would show two desks for one reply. Rejected.
- **Showing every chat's room, idle ones too.** A month of chats as empty rooms buries the ones at work. Rejected.
- **Turning the office on and off with a boolean, beside a desks-or-list boolean.** Two flags that must agree. One three-valued setting can't disagree with itself.

## Consequences

- The office knows subagents only for chats in the profile shown that this connection has resumed since the app started (ADR 0072 keeps trees in memory). Chats in other profiles show only their reply's desk. This is stated in the office's foot and in the README.
- A reply's state is only as fresh as the inbox. Other profiles come from its periodic checks, which run every 30 seconds while the office is open, as they do while the inbox is open.
- A large office is cheap: at most 100 subagents per chat (ADR 0072), and the rooms are worked out only while it is open. The tests render ten chats of 101 desks each in both views.
- Checked in tests against the real transport and a fake Hermes, through a run, an Approval, failures, a completion and a reconnect (`src/ui/office.test.tsx`), and live against a real Hermes `f0d94882` that delegates (PR body).
