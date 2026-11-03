// @vitest-environment jsdom
// Closing the window with an unsaved memory edit asks first (LeaveMemoryEdit.tsx `useCloseGuard`).
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  handler: undefined as undefined | ((e: { preventDefault: () => void }) => void),
  unlisten: vi.fn(),
  destroy: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (fn: typeof win.handler) => {
      win.handler = fn;
      return win.unlisten;
    },
    destroy: win.destroy,
  }),
}));

import { useCloseGuard } from "./LeaveMemoryEdit";

function Guard({ unsaved, ask }: { unsaved: boolean; ask: (close: () => void) => void }) {
  useCloseGuard(unsaved, ask);
  return null;
}

const unload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  win.handler = undefined;
  win.unlisten.mockClear();
  win.destroy.mockClear();
});

describe("Closing the window with an unsaved memory edit", () => {
  it("holds a page reload only while there is an unsaved edit", () => {
    const { rerender } = render(<Guard unsaved={false} ask={() => {}} />);
    expect(unload()).toBe(false);
    rerender(<Guard unsaved ask={() => {}} />);
    expect(unload()).toBe(true);
    rerender(<Guard unsaved={false} ask={() => {}} />);
    expect(unload()).toBe(false);
  });

  it("stops the window closing and asks; Discard closes it, and nothing listens once the edit is gone", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const ask = vi.fn();
    const { rerender } = render(<Guard unsaved={false} ask={ask} />);
    expect(win.handler).toBeUndefined();
    rerender(<Guard unsaved ask={ask} />);
    await vi.waitFor(() => expect(win.handler).toBeDefined());
    const preventDefault = vi.fn();
    win.handler!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
    ask.mock.calls[0][0]();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    rerender(<Guard unsaved={false} ask={ask} />);
    expect(win.unlisten).toHaveBeenCalled();
  });
});
