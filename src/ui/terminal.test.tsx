// @vitest-environment jsdom
// The Terminal screen: it connects at once to a known target and asks for one otherwise, keeps the shell's keys from
// the app's shortcuts, ends and reconnects, and closes ssh when it goes. xterm.js itself is stood in for: jsdom can't
// draw it.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalApi, TerminalEvent } from "../hermes/terminal";

const xterms: FakeXTerm[] = [];
class FakeXTerm {
  cols = 100;
  rows = 30;
  written: string[] = [];
  options: Record<string, unknown> = {};
  data?: (d: string) => void;
  el?: HTMLElement;
  disposed = false;
  constructor() {
    xterms.push(this);
  }
  loadAddon() {}
  open(el: HTMLElement) {
    this.el = el;
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    el.appendChild(ta);
  }
  write(d: string | Uint8Array) {
    this.written.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  onData(f: (d: string) => void) {
    this.data = f;
    return { dispose() {} };
  }
  onResize() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  paste() {}
  focus() {}
  dispose() {
    this.disposed = true;
  }
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const { TerminalScreen } = await import("./Terminal");

class FakeTerminals implements TerminalApi {
  opened: { target: string; cols: number; rows: number; emit: (e: TerminalEvent) => void }[] = [];
  written: string[] = [];
  closed: number[] = [];
  open(target: string, cols: number, rows: number, emit: (e: TerminalEvent) => void) {
    this.opened.push({ target, cols, rows, emit });
    return Promise.resolve(this.opened.length);
  }
  write(_id: number, data: string) {
    this.written.push(data);
    return Promise.resolve();
  }
  resize() {
    return Promise.resolve();
  }
  close(id: number) {
    this.closed.push(id);
  }
}

const out = (s: string) => ({ kind: "output" as const, data: new TextEncoder().encode(s) });

afterEach(() => {
  cleanup();
  xterms.length = 0;
});

function show(initialTarget: string, api = new FakeTerminals()) {
  const onTarget = vi.fn();
  const onRunning = vi.fn();
  const onClose = vi.fn();
  const r = render(<TerminalScreen api={api} initialTarget={initialTarget} shown onTarget={onTarget} onRunning={onRunning} onClose={onClose} />);
  return { api, onTarget, onRunning, onClose, ...r };
}

describe("Terminal screen", () => {
  it("connects straight away to the sign-in's SSH target, at the terminal's size", async () => {
    const { api, onRunning } = show("liam@hermes");
    await act(async () => {});
    expect(api.opened).toMatchObject([{ target: "liam@hermes", cols: 100, rows: 30 }]);
    expect(screen.getByRole("status").textContent?.trim()).toBe("Connecting…");
    expect(screen.queryByLabelText("SSH target")).toBeNull();
    act(() => api.opened[0].emit(out("Welcome to hermes\r\nliam@hermes:~$ ")));
    expect(screen.getByRole("status").textContent).toBe("Connected");
    expect(xterms[0].written.join("")).toContain("Welcome to hermes");
    expect(onRunning).toHaveBeenLastCalledWith(true);
    act(() => xterms[0].data!("uptime\r"));
    expect(api.written).toEqual(["uptime\r"]);
  });

  it("asks for a target when the sign-in has none, and remembers the one typed", async () => {
    const { api, onTarget } = show("");
    expect(api.opened).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Not connected");
    const connect = screen.getByRole("button", { name: /connect/i }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("SSH target"), { target: { value: " root@hermes " } });
    await act(async () => fireEvent.click(connect));
    expect(onTarget).toHaveBeenCalledWith("root@hermes");
    expect(api.opened[0].target).toBe("root@hermes");
  });

  it("keeps the shell's keys from the app's own shortcuts", async () => {
    show("hermes");
    await act(async () => {});
    const appShortcut = vi.fn();
    window.addEventListener("keydown", appShortcut);
    try {
      fireEvent.keyDown(xterms[0].el!.querySelector("textarea")!, { key: "k", ctrlKey: true });
      expect(appShortcut).not.toHaveBeenCalled();
      // Outside the terminal itself, the app's keys still work.
      fireEvent.keyDown(screen.getByRole("button", { name: /back to chat/i }), { key: "k", ctrlKey: true });
      expect(appShortcut).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", appShortcut);
    }
  });

  it("ends the session, says so, and connects again below what was printed", async () => {
    const { api, onRunning } = show("hermes");
    await act(async () => {});
    act(() => api.opened[0].emit(out("$ ")));
    fireEvent.click(screen.getByRole("button", { name: /end session/i }));
    expect(api.closed).toEqual([1]);
    act(() => api.opened[0].emit({ kind: "exit", code: null }));
    expect(screen.getByText("You ended the session.")).toBeTruthy();
    expect(onRunning).toHaveBeenLastCalledWith(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /connect again/i })));
    expect(api.opened).toHaveLength(2);
    expect(xterms[0].written.join("")).toMatch(/\$ [^\n]*\r\n.*ssh hermes/);
  });

  it("shows ssh's own failure as it printed it", async () => {
    const { api } = show("nowhere");
    await act(async () => {});
    act(() => api.opened[0].emit(out("ssh: Could not resolve hostname nowhere\r\n")));
    act(() => api.opened[0].emit({ kind: "exit", code: 255 }));
    expect(screen.getByText(/ssh couldn't connect or lost the connection/)).toBeTruthy();
    expect(xterms[0].written.join("")).toContain("Could not resolve hostname");
  });

  it("closes ssh when the screen goes, as at sign out", async () => {
    const { api, unmount } = show("hermes");
    await act(async () => {});
    unmount();
    expect(api.closed).toEqual([1]);
    expect(xterms[0].disposed).toBe(true);
  });
});
