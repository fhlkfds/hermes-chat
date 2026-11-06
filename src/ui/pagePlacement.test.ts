// @vitest-environment jsdom
// Where the Preview's own page view goes (ADR 0081): over its box, with holes where the app's floating layers are on
// top. jsdom lays nothing out, so each element's rectangle and what is topmost at a point are given here.
import { afterEach, describe, expect, it } from "vitest";
import { floatingLayers, placementOf } from "./pagePlacement";

type Box = { x: number; y: number; width: number; height: number };
const at = (el: Element, r: Box) => {
  el.getBoundingClientRect = () => ({ ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => r }) as DOMRect;
  return el;
};
const add = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(...host.children);
};
/** What is drawn on top at a point: the last of `order` whose rectangle holds it. */
const topmost = (...order: Element[]) => {
  document.elementFromPoint = (x, y) =>
    [...order].reverse().find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    }) ?? null;
};

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("The app's floating layers", () => {
  it("are its fixed-position rules, in media queries too, and nothing else", () => {
    document.head.innerHTML = `<style>
      .toast { position: fixed; left: 50%; }
      .side { position: absolute; }
      @media (max-width: 100000px) { .menu, .palette { position: fixed; } }
    </style>`;
    expect(floatingLayers()).toBe(".toast, .menu, .palette");
  });
});

describe("Where the page goes", () => {
  const PAGE = { x: 800, y: 120, width: 480, height: 700 };

  it("covers its box, with a hole for a toast drawn over it and none for a menu beside it", () => {
    add(`<main><div id="box"></div></main><div class="toast">Copied</div><div class="menu" role="menu"></div>`);
    const box = at(document.getElementById("box")!, PAGE);
    const toast = at(document.querySelector(".toast")!, { x: 500, y: 760, width: 400, height: 40 });
    at(document.querySelector(".menu")!, { x: 600, y: 120, width: 180, height: 200 });
    topmost(box, toast);
    expect(placementOf(box, ".toast, .menu")).toEqual({ rect: PAGE, holes: [{ x: 800, y: 760, width: 100, height: 40 }] });
  });

  it("makes no hole for a layer under it, nor for one it is inside", () => {
    add(`<div class="inbox"></div><aside class="overlay-panel"><div id="box"></div></aside>`);
    const box = at(document.getElementById("box")!, PAGE);
    const inbox = at(document.querySelector(".inbox")!, { x: 60, y: 0, width: 900, height: 820 });
    const panel = at(document.querySelector(".overlay-panel")!, { x: 0, y: 0, width: 1280, height: 820 });
    // The panel covers the window, the inbox under it.
    topmost(inbox, panel);
    expect(placementOf(box, ".inbox, .overlay-panel")).toEqual({ rect: PAGE, holes: [] });
  });

  it("goes nowhere while its box has no size", () => {
    add(`<div id="box"></div>`);
    const box = at(document.getElementById("box")!, { x: 800, y: 120, width: 0, height: 700 });
    expect(placementOf(box, "")).toBeNull();
  });
});
