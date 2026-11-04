// Search across Settings: the screen's own rendered text, so there is no index to keep in step with it. A section
// shows while its text holds every word of the query; the rest are hidden, and the words are marked in what shows.

/** The words of a query, lower-cased. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `text` holds every one of `words`, ignoring case. */
export function textMatches(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

/** The CSS highlight the found words are drawn with (`::highlight(settings-search)`). */
export const HIGHLIGHT_NAME = "settings-search";

/** Attribute on a section, or a group of them, that the query hides. */
export const MISS_ATTR = "data-search-miss";

/** The outermost sections under `root`: the unit search shows or hides. */
function sectionsOf(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("section")].filter((s) => {
    const outer = s.parentElement?.closest("section");
    return !outer || !root.contains(outer);
  });
}

/** The ranges of each word in the text under `el`, for marking. Text inside a select's options isn't drawn, so isn't marked. */
function wordRanges(el: Element, words: string[]): Range[] {
  const ranges: Range[] = [];
  const doc = el.ownerDocument;
  const walk = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("option, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.textContent ?? "").toLowerCase();
    for (const w of words) {
      for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + w.length)) {
        const r = doc.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + w.length);
        ranges.push(r);
      }
    }
  }
  return ranges;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : undefined;

/** Removes the marks of found words. */
export function clearMarks(): void {
  registry()?.delete(HIGHLIGHT_NAME);
}

/**
 * Shows only the sections in each group under `root` (an element with `data-search-group`) whose text holds every word,
 * hides a group left with none, and marks the words where the WebView can draw CSS highlights. Returns how many sections show.
 */
export function applySearch(root: Element, words: string[]): number {
  let shown = 0;
  const ranges: Range[] = [];
  for (const group of root.querySelectorAll<HTMLElement>("[data-search-group]")) {
    let inGroup = 0;
    for (const s of sectionsOf(group)) {
      const hit = textMatches(s.textContent ?? "", words);
      s.toggleAttribute(MISS_ATTR, !hit);
      if (hit) {
        inGroup++;
        ranges.push(...wordRanges(s, words));
      }
    }
    group.toggleAttribute(MISS_ATTR, inGroup === 0);
    shown += inGroup;
  }
  const highlights = registry();
  if (highlights) {
    const Highlight = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }
  return shown;
}
