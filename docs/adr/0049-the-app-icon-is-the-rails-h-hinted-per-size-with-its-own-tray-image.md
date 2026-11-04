# The app icon is the rail's H, hinted per size, with its own tray image

Issue #177 asks for a real app icon in place of the green placeholder square. It should match the "H" at the top of the rail, come in every size Tauri and the Arch package need, and include a tray version that reads at 16–22 px on light and dark panels.

## Decisions

- **The icon is the rail's brand mark, drawn as an app icon.** It is a clay rounded square with a dark H, the same colours as `.rail-brand` in the Hermes theme (`#d08b6e` and `#19110d`) and the same corner rounding (30% of the side). The H is a drawn path, not text, so it doesn't depend on which fonts are installed. The 512 px master (`assets/icon.svg`) follows freedesktop and GNOME conventions:
  - a 416 px tile with transparent padding
  - a soft gradient (`#df9d80` to `#c27859`) and a light top rim
  - a soft drop shadow
  - every edge on an 8 px grid, so 64 px and larger renders are sharp
- **Small sizes have their own hinted sources.** A 16 px icon scaled down from the master blurs. `assets/icons/icon-{16,22,24,32,48}.svg` are each drawn on their own pixel grid, with whole-pixel stems and no shadow. 16 and 22 px have a flat fill; 24 and 32 px keep the master's gradient. The 16–32 px icons have the tray's 1 px `#a56549` rim, which lifts the tile above 3:1 against light menus. 48 px gets a 1 px shadow instead. They render hicolor 16–48, and Tauri's `32x32.png`. The master renders 64 px and up.
- **One script draws everything, with Tauri's own renderer.** `tools/icons/build.sh` runs `tauri icon` for Tauri's suite (`32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`, `icon.icns`), the hicolor sizes in `src-tauri/icons/hicolor/`, and the two tray images. It needs no ImageMagick or Inkscape. The Windows Store and mobile outputs `tauri icon` also writes are left out: the app is built for Linux only.
- **The window icon is the 256 px render.** On Linux, Tauri uses the first PNG in `bundle.icon` as the window icon, which the title bar and taskbar show. That used to be `32x32.png`, scaled up. `128x128@2x.png` now comes first.
- **The package installs the icon at every hicolor size.** The launcher's `Icon=hermes-chat` finds it in hicolor at 16, 22, 24, 32, 48, 64, 128, 256 and 512 px, in `scalable/` (the master SVG), and in `symbolic/` (`hermes-chat-symbolic.svg`). The symbolic icon is a one-colour tile with the H cut out, which GTK recolours for high-contrast and symbolic themes.
- **The tray has its own image, one that reads on any panel.** The app can't find out what colour the panel is, and a single-colour glyph that suits a dark bar disappears on a light one. So the tray icon is the clay tile itself:
  - The tile fills the image edge to edge, and the H is 4× the hinted 16 px H.
  - A darker 1 px rim (`#a56549`) separates the tile from light panels (about 3.7:1 against `#e8e8e8`). The tile itself stands out on dark panels (about 5:1 against `#2b2b2b`).
  - It's one 64 px PNG (`icons/tray.png`), because Tauri's tray takes a single image and the panel scales it. 64 is 4× 16 and 2× 32, so those sizes are exact.
- **The Inbox dot is drawn into a second tray image.** `icons/tray-inbox.png` is the same picture with a red dot in the top-right corner (`#e5483a`, radius 12 of 64, centred at 52, 12), ringed clear of the tile by a 4 px transparent gap (1 px at 16). The H stays put when the Inbox fills; the dot covers the top of its right stem, as a badge does. Red against clay is low contrast on its own, so the ring must stay at least 1 px at 16. Before this, `tray.rs` drew a dot over the app icon at run time.

## Considered options

- **The tile reversed, a dark tile with a clay H.** Its edge disappears on dark panels and docks (about 1.1:1 against `#202124`), and it reverses the rail's colours.
- **The tile as a chat bubble with a tail.** At 22 and 16 px the tail turns into a smear of one or two pixels, and it shrinks the space left for the H.
- **A monochrome tray glyph that follows the desktop's colour scheme.** The panel's colour often differs from the desktop's light or dark preference (GNOME's top bar is always dark, for example), so the app would guess wrong. The symbolic icon is installed for themes that want one.
- **A smaller H moved to the bottom left when the Inbox has items, clear of the dot.** It keeps the H whole, but the glyph jumps at panel size each time the Inbox changes, and at 16 px its counters are 2 px holes.
- **A tray image sized for 22 px panels (88 px).** That would make KDE's 22 px panel sharp at the cost of 16 px. 64 px favours 16 px (GNOME's AppIndicator extension, small XEmbed trays) and HiDPI 32 px.

## Consequences and gaps

- At 22 and 24 px the tray icon is slightly soft, because the panel scales a 64 px image by a fraction. Hinted tray sizes would need the tray to load a themed icon by name, but Tauri's tray (the `tray-icon` crate) writes the image to a temporary PNG and gives libayatana that file's path.
- `icon.ico` and `icon.icns` are generated for completeness but not used: the app isn't built for Windows or macOS.
- After changing a source SVG, run `tools/icons/build.sh` and commit the PNGs. Nothing checks that the PNGs match their sources. A rebuild reproduces every PNG and `icon.ico` byte for byte, but not `icon.icns`, whose encoder isn't deterministic; leave it out of a commit unless the master changed.
- The design was scored over several rounds by a Claude and a Codex reviewer for looks, clarity, contrast and scaling, on contact sheets of each size on dark and light panels. The PR records the rounds.
