# New chat and Search are labeled at the top of the list panel too, and every common action has a key

ADR 0001 put New chat and Search only on the rail, as unlabeled icons, to keep the list panel uncluttered. In practice the two most used actions in the app were the two least discoverable: an icon, with its key shown only in a tooltip. The UI polish overhaul adds them as labeled buttons at the top of the list panel, each showing its key (Ctrl N, Ctrl K), above the project switcher. The rail keeps its icons, which are the way in when the list panel is hidden (Ctrl+B).

## Decisions

- **Labeled, with the key showing.** "New chat" stands out as the primary action and "Search chats" sits below it. The key is drawn as a `kbd`, hidden from screen readers so the button's name stays "New chat" or "Search chats".
- **The rail splits chats from tools.** A short rule separates New chat, Search and the inbox from Server files, Scheduled jobs, Outputs, Usage and the Terminal.
- **A key for each common action.** Ctrl+N starts a new chat, Ctrl+K searches, Ctrl+, opens Settings, and Alt+Up and Alt+Down open the Active chat above or below the one showing, in the list's order (most recent first, in the shown project). Alt+arrows stop at the first and last chat, start from the top when a new chat is showing, and leave the keys alone when a list that uses them (the queue, Server files) has already handled the press. A new chat lists these keys under its prompt.

## Considered options

- **Labels on the rail**: the rail is 56 px wide, so labels would mean widening it into a second list panel.
- **Moving New chat and Search off the rail**: the list panel can be hidden, which would leave them with no button.
