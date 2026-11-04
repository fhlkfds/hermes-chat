// @vitest-environment jsdom
// Following the window's visibility from Rust (windowState.ts, ADR 0033).
import { afterEach, describe, expect, it, vi } from "vitest";

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
