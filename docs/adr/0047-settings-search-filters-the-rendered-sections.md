# Settings search filters the sections on screen, and names the editor tabs

Issue #160 asks for a full-text search of Settings: seven tabs, and a General tab long enough that a setting is hard to find by scrolling.

## Decisions

- **The search reads the screen's own text.** Typing in the box under the Settings heading (or Ctrl+F) shows the General, Appearance, Model and Toolsets tabs together, each under its name. A section shows while its text, with its controls' names (`aria-label`, `title`, `placeholder`), holds every word typed, in any order and case; the others, and a tab left with none, are hidden. There is no index to keep in step: a new section, or new wording, is searchable as soon as it renders. A tab that reads from Hermes (Model, Toolsets) is searched again as its answer fills in, by watching the results for changes.
- **The words are marked with CSS highlights.** `::highlight(settings-search)` draws the marks over the text without changing the page, so React's nodes and the sections' controls are untouched. A WebView without `CSS.highlights` shows the same sections, unmarked.
- **Persona, Memory and Skills are named, not mounted.** Each edits one thing Hermes keeps (SOUL.md, memory entries, skill files) and holds an unsaved edit that leaving asks about. A search matches their names and a line about each, and offers Open; it never mounts their editors beside the others. Diagnostics (ADR 0044) is named the same way: it shows the server's own checks, which stay on its tab. A tab Hermes lacks the feature for shows its note in the results, as it does on the tab.
- **A search leaves the shown tab, so it asks as switching tabs does.** Starting one goes through the same unsaved-edit question. Escape, Clear search, Open, or picking a tab ends it; a tab picked ends it on that tab, and ending it otherwise returns to the tab shown before.

## Considered options

- **A hand-kept index of settings and keywords.** Fast and able to name every tab, but it drifts from the screen with each wording change, and this app's settings text changes often.
- **WebKitGTK's own find-in-page (`WebKitFindController`).** Needs Rust wiring through `with_webview` and finds only in the one tab rendered.
- **Mounting every tab, hidden, to search them all.** Would read Persona, Memory and Skills from Hermes and keep their editors open off screen with unsaved-edit guards.

## Consequences and gaps

- What's inside Persona, Memory and Skills (the persona text, memory entries, skill names) isn't searched here; Skills has its own search, and the other two are opened from the result.
- Opening a search reads the Model and Toolsets tabs from Hermes, as visiting them does.
- A Model draft made in the results is dropped when the search ends, as it is when leaving the Model tab.
