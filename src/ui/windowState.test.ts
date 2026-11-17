// @vitest-environment jsdom
// Following the window's visibility from Rust (windowState.ts, ADR 0034).
import { afterEach, describe, expect, it, vi } from "vitest";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";

const rust = vi.hoisted(() => ({
  hidden: false,
  handler: undefined as undefined | ((e: { payload: { hidden: boolean } }) => void),
  beforeAnswer: undefined as undefined | (() => void),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: typeof rust.handler) => {
    rust.handler = fn;
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    rust.beforeAnswer?.();
    return rust.hidden;
  },
}));

import { followWindowVisibility, setWindowHidden, useWindowHidden } from "./windowState";
import { renderHook, act } from "@testing-library/react";

afterEach(() => {
  act(() => setWindowHidden(false));
  rust.hidden = false;
  rust.beforeAnswer = undefined;
  document.body.innerHTML = "";
});

describe("The window's visibility", () => {
  it("counts a window hidden before the page started listening as hidden", async () => {
    rust.hidden = true;
    const { result } = renderHook(() => useWindowHidden());
    await act(() => followWindowVisibility());
    expect(result.current).toBe(true);
    act(() => rust.handler!({ payload: { hidden: false } }));
    expect(result.current).toBe(false);
  });

  it("lets an event that came while asking win over the answer", async () => {
    rust.hidden = false;
    rust.beforeAnswer = () => rust.handler!({ payload: { hidden: true } });
    const { result } = renderHook(() => useWindowHidden());
    await act(() => followWindowVisibility());
    expect(result.current).toBe(true);
  });

  it("puts focus back where it was, or in the active pane's composer if that is gone", async () => {
    document.body.innerHTML = `<section class="pane active"><textarea data-composer></textarea></section><input id="search" />`;
    const search = document.getElementById("search")!;
    search.focus();
    setWindowHidden(true);
    search.blur();
    setWindowHidden(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(search));

    setWindowHidden(true);
    search.remove();
    setWindowHidden(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-composer]")));
  });
});

describe("Endless animations", () => {
  const css: string = readFileSync("src/styles.css", "utf8");

  it("keep playing whatever the window's focus, so a running step still shows it is alive behind another app", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const endless = [...rules.matchAll(/([^{}@]+)\{[^{}]*\binfinite\b[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
    const pausing = [...rules.matchAll(/([^{}@]+)\{[^{}]*animation-play-state:\s*paused[^{}]*\}/g)].map((m) => m[1].trim());
    expect(endless).toEqual(expect.arrayContaining([".spinner", ".thinking span", ".spin"]));
    expect(pausing).toEqual([]);
  });
});
