// Where the Preview's own page view goes (ADR 0081). The view is a native widget drawn over the whole app, so it
// follows its box in the pane, and leaves bare the parts that the app's floating layers (menus, dialogs, toasts,
// drawers) cover, so those still show and take the pointer.
import { useEffect, type RefObject } from "react";
import type { NativePage, Placement, Rect } from "./tauriPreview";

/** The most often the page's place is worked out again, while the app keeps changing (a reply streaming, say). */
const CHECK_MS = 200;

/**
 * A selector for the app's floating layers: every `position: fixed` rule in its stylesheets, which float over
 * everything, the Preview included, so a new one is covered with no list to keep; and its separators, which sit on a
 * pane's edge, over the edge of the Preview's box.
 */
export function floatingLayers(sheets: Iterable<CSSStyleSheet> = document.styleSheets): string {
  const found = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (rule.style.position === "fixed") found.add(rule.selectorText);
      } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(sheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Another origin's sheet can't be read; the app has none.
    }
  }
  const probe = document.createDocumentFragment();
  return ["[role=separator]", ...found]
    .filter((selector) => {
      try {
        probe.querySelector(selector);
        return true;
      } catch {
        // A selector the stylesheet keeps but this engine can't query would break the whole list.
        return false;
      }
    })
    .join(", ");
}

const intersect = (a: Rect, b: Rect): Rect | undefined => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/**
 * Where the page goes: `box`'s rectangle in the window, with a hole for each layer drawn over it. A layer under the
 * box, such as one beneath the Preview when it covers the chat, makes no hole. `null`: the box has no size.
 */
export function placementOf(box: Element, layers: string): Placement | null {
  const r = box.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const holes: Rect[] = [];
  const doc = box.ownerDocument;
  if (layers)
    for (const layer of Array.from(doc.querySelectorAll(layers))) {
      if (layer.contains(box)) continue;
      const hole = intersect(rect, layer.getBoundingClientRect());
      const top = hole && doc.elementFromPoint(hole.x + hole.width / 2, hole.y + hole.height / 2);
      if (hole && top && layer.contains(top)) holes.push(hole);
    }
  return { rect, holes };
}

/** Keeps `page` placed over `box` while both are there, and hides it when either goes. */
export function usePlacement(box: RefObject<HTMLElement | null>, page: NativePage | undefined) {
  useEffect(() => {
    const el = box.current;
    if (!page || !el) return;
    const layers = floatingLayers();
    let last = "";
    let pending: ReturnType<typeof setTimeout> | undefined;
    let checked = 0;
    const measure = () => {
      pending = undefined;
      checked = performance.now();
      const placement = placementOf(el, layers);
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      page.place(placement);
    };
    // Anything that can move the box or open a layer over it: the box resizing, the window resizing, the app's DOM
    // changing (a menu, a dialog, a toast), the owner's input, and a layer's opening animation ending. A timer rather
    // than an animation frame, which would have the webview draw every time though nothing changed.
    const soon = () => {
      pending ??= setTimeout(measure, Math.max(0, checked + CHECK_MS - performance.now()));
    };
    const resized = new ResizeObserver(soon);
    resized.observe(el);
    const changed = new MutationObserver(soon);
    changed.observe(el.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
    const events = ["resize", "pointerup", "keyup", "contextmenu", "animationend", "transitionend"] as const;
    for (const e of events) addEventListener(e, soon, true);
    measure();
    return () => {
      resized.disconnect();
      changed.disconnect();
      clearTimeout(pending);
      for (const e of events) removeEventListener(e, soon, true);
      page.place(null);
    };
  }, [box, page]);
}
