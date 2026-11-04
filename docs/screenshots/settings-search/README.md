# Settings search screenshots

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1280 × 900 with openbox (the window is 1280 × 840; the strip below it is the bare display). Nothing was composited or retouched. The app was signed in by URL to the repo's `FakeHermes` stub on loopback (`docs/screenshots/usage-analytics/bridge.ts`), so every chat and model is synthetic. The search was opened with Ctrl+F and typed with `xdotool`.

- `1-search-box.png`: Settings → General with the search box beside the heading.
- `2-tray.png`: "tray" shows only General → Tray, with the word marked.
- `3-model-tab-section.png`: "subagent" finds Model → Subagents once Hermes's model settings are read.
- `4-editor-tab-result.png`: "remembers" names the Memory tab, with Open Memory, rather than mounting its editor.
- `5-control-name.png`: "font size" finds Appearance → Fonts by its size pickers' names ("Interface font size"), which aren't visible text.
- `6-no-match.png`: nothing matches "kubernetes".
- `7-escape-back.png`: Escape ends the search and returns to the tab shown before (General).

Known gap: WebKitGTK leaves the marks unpainted on a few row titles that sit directly in a flex container, such as "Close to tray" and "Interface font"; those sections are still found. The native dropdowns' text is garbled under Xvfb with or without a search.
