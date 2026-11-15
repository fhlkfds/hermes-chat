# The app is called Flagstop, and its icon is the F of a flag stop

"Hermes Chat" said what the app talks to, not what it is. It reads as if it were Hermes, or a Nous Research product, beside the official Hermes desktop app. The icon was the letter H, Hermes's own initial. The owner asked for a new name and a new icon, chosen by a council of three models (Claude Fable 5.2, GPT-6 Astra and Grok 4.7, each at xhigh effort) who all had to score the pick 10/10.

## Decisions

- **The name is Flagstop.** A flag stop is a stop where a bus or train pulls in only when someone signals it. Hermes is the messenger on the road; the app is the stop on the owner's side where they flag him down. The summon key is the flag, queued messages wait to be picked up, and the Inbox and returned results are what he drops off. The name names the client, not the agent. It is a dictionary word, two syllables, and sorts under F, away from Hermes Desktop.
- **The name always comes with what the app is.** The launcher has `GenericName=Hermes Agent Client`, `Comment=Desktop client for your Hermes Agent servers` and `Keywords=hermes;agent;chat;`, so typing "hermes" still finds it. The README's first line says the same. This also answers search: the bare word is shared with a car-wash app and a transit timetable, and "flagstop hermes" finds neither.
- **Only the shown name changes.** `productName`, the window title, the tray menu, notifications, and app text say Flagstop. The bundle identifier `net.l0cky12.hermes-chat`, the binary and command `hermes-chat` (`--show`, `--toggle`, `--screenshot`), the AUR package, the `hermes-chat://` link scheme, the session bus name, the keyring entries and every data folder keep their names, so no data, keybinding or link breaks. Strings written into files or sent to Hermes, such as an export's format name, keep "Hermes Chat", so old files still import.
- **The icon is an F drawn as the stop's sign.** A pole, the stop's flag at its top, and a smaller plate under it, with the pole running 24 px above the flag (`M176 120H224V144H352V208H224V248H320V288H224V376H176z` on the 512 master). It is the letter F and the object the name means at every size, from 16 px to 512 px, and it has no diagonal edge, so it hints with whole pixels like the H did. The tile, colours, gradient, rim, shadow, hinted sizes, tray images, Inbox dot and symbolic glyph follow ADR 0049 unchanged.
- **The rail mark is the same F.** `.rail-brand` was a CSS letter. It is now `BrandMark`, the F on the rail's 30 px grid (`M10 6h4v2h8v5h-8v3h6v3h-6v5h-4z`) in the tile's text colour, on the rail, the sign-in and first-run cards and the setup header.
- **The Windows installer removes Hermes Chat first.** Tauri's NSIS installer keys an install by product name: its folder, its Start-menu entry and its uninstall entry. Without help, Flagstop would install beside Hermes Chat. `NSIS_HOOK_PREINSTALL` runs Hermes Chat's own uninstaller silently, in place, as Tauri's reinstall page does, then removes the uninstaller and the empty folder. Its "delete app data" box stays off in silent mode, and the data folder is named by the identifier, so chats, settings and the sign-in carry over.

## Considered options

The council went through five rounds. Each name below failed on collisions or meaning; each icon on what it looked like at 16 or 512 px.

- **Hermes-myth names** (Talaria, Caduceus, Petasos, Herald, Keryx, Kyllene, Herm). Other Hermes Agent clients already use every one.
- **Bellpull.** An Android Hermes Agent client of that name ships a bell-cord icon. The cord-and-grip icon also read as a plunger.
- **Wingtip.** Synthreo sells an agent product called Wingtip, and Winglet is a Hermes Agent client. A W also reads as Windows or web.
- **Haildock.** On Linux a dock is a kind of program, and its bracket-and-bar icon is the sign-out glyph.
- **Hailkey.** A key names a credential tool in an app that handles SSH keys and a keyring. Its letter mark, an h, is today's H with pixels removed, not a new icon.
- **Pointpost.** A P on a square tile reads as a parking sign.
- **Fingerpost, Underwing, Wingdock.** An AI trip planner with a chat companion, an agent suite, and a Hermes client's near-namesake have them.

The collision bar: the exact name in any AI, chat or agent product with real presence blocks it; a one-syllable variant blocks it only among Hermes Agent clients and tools.

## Consequences

- "Flag stop" is North American usage; British English says "request stop". The README's first lines say what one is.
- On Windows the install folder (`%LOCALAPPDATA%\Flagstop`), the uninstall entry and the shortcuts take the new name; the program file stays `hermes-chat.exe`. Installing Flagstop over Hermes Chat 0.1.4 on a Windows runner left one install, kept the app data, and moved the `hermes-chat://` handler to Flagstop.
- Code comments, older ADRs and the repository still say Hermes Chat or `hermes-chat`. The repository name is how people find and install the app, so it stays.
- The README screenshots show the old H until they are next taken.
