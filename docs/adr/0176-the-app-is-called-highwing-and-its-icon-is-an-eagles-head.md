# The app is called Highwing, and its icon is an eagle's head

"Hermes Chat" said what the app talks to, not what it is. It reads as if it were Hermes, or a Nous Research product, beside the official Hermes Desktop app. The icon was the letter H, Hermes's own initial. The owner asked for a new name and a new icon. A council of three models first picked Flagstop with an F drawn as a bus-stop sign. The owner turned that down: the name didn't suit the app, and a letter isn't a picture. They asked for an icon that is an image of something, with an eagle as their example. From five drawn drafts they picked Highwing.

## Decisions

- **The name is Highwing.** An eagle flies highest and sees furthest. From here the owner watches what their Hermes agents are doing and sends them out. The name names the client, not the agent. It is two plain words joined, easy to say and type, and it sorts under H, beside Hermes Desktop but not inside its name.
- **The name always comes with what the app is.** The launcher has `GenericName=Hermes Agent Client`, `Comment=Desktop client for your Hermes Agent servers` and `Keywords=hermes;agent;chat;`, so typing "hermes" still finds it. The README's first line says the same.
- **Only the shown name changes.** `productName`, the window title, the tray menu, notifications, and app text say Highwing. The bundle identifier `net.l0cky12.hermes-chat`, the binary and command `hermes-chat` (`--show`, `--toggle`, `--screenshot`), the AUR package, the `hermes-chat://` link scheme, the session bus name, the keyring entries and every data folder keep their names, so no data, keybinding or link breaks. Strings written into files or sent to Hermes, such as an export's format name, keep "Hermes Chat", so old files still import.
- **The icon is an eagle's head in profile.** It faces right, and its neck runs off the bottom of the tile like a bust, with three feather points down the back of the neck. The head is the near-black ink, and the hooked beak and the eye are cream (`#f4dccb`). The brow is a stroke of darker clay. The tile, colours, gradient, rim and shadow are ADR 0049's.
- **Small sizes are drawn pixel by pixel.** The master shrunk to 16 px loses the eye and the hook of the beak. So `icon-16.svg` is drawn by hand on the 16 px grid: one cream eye pixel, a three-pixel beak with a notch under its hook, and stepped feathers. 22, 24 and 32 px grow that drawing with Scale3x and are fixed by hand. From 48 px up the master's own curves are used. The tray image is the 16 px drawing at four times the size, so a 16 px panel shows exactly the hinted eagle. The Inbox dot sits over the crown and leaves the eye and beak clear. The symbolic icon is the tile in one colour with the eagle cut out and the eye left standing.
- **The rail mark is the master's eagle.** `BrandMark` draws the master's curves, not pixel art, because the rail is drawn at any zoom and on high-DPI screens. Themes change the accent, so the head takes the tile's text colour (`--on-accent`). The beak and eye are a pale tint of the accent, and the brow is the accent itself. That keeps the eagle readable on every theme. `.rail-brand` clips to its rounded corners, so the neck ends at the tile's edge.
- **The Windows installer removes Hermes Chat first.** Tauri's NSIS installer keys an install by product name: its folder, its Start-menu entry and its uninstall entry. Without help, Highwing would install beside Hermes Chat. `NSIS_HOOK_PREINSTALL` runs Hermes Chat's own uninstaller silently, in place, as Tauri's reinstall page does, then removes the uninstaller and the empty folder. Its "delete app data" box stays off in silent mode. The data folder is named by the identifier, so chats, settings and the sign-in carry over.

## Considered options

- **Flagstop, with an F drawn as a bus-stop sign.** The council's pick after five rounds. The owner turned it down: the name didn't suit a Hermes client, and a letter mark isn't a picture.
- **The four other drawn drafts.** Swiftwing (a swift in flight), Wingbeat (Hermes's winged helmet), Shellsong (the lyre Hermes made from a tortoise shell) and Homing (a carrier pigeon with a sealed letter). Of these, the eagle stays clearest at 16 px, and the pigeon's wing and letter run together there.
- **Taken bird names.** Falconer, Aerie, Eyrie, Kestrel and Aquila already name AI agent or chat products.
- **Hermes-myth names** (Talaria, Caduceus, Petasos, Herald, Keryx, Kyllene, Herm). Other Hermes Agent clients already use every one.
- **The council's earlier names** (Bellpull, Wingtip, Haildock, Hailkey, Pointpost, Fingerpost, Underwing, Wingdock). Each collided with another product, or its icon read as something else.

## Consequences

- An insurance analytics firm is called Highwing. It isn't in chat, AI agents or desktop software.
- On Windows the install folder (`%LOCALAPPDATA%\Highwing`), the uninstall entry and the shortcuts take the new name. The program file stays `hermes-chat.exe`. Installing over Hermes Chat 0.1.4 on a Windows runner left one install, kept the app data, and moved the `hermes-chat://` handler to the new name. That run used the name Flagstop. The hook doesn't depend on the new name, only on the old one.
- The hinted SVGs are now runs of one-pixel rectangles. To change the eagle at a small size, edit that size's SVG on its own grid, then run `tools/icons/build.sh`.
- Code comments, older ADRs and the repository still say Hermes Chat or `hermes-chat`. The repository name is how people find and install the app, so it stays.
- The README screenshots show the old H until they are next taken.
