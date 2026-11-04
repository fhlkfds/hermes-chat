// @vitest-environment jsdom
// The global shortcut (ADR 0033), driven the way the owner would. Rust is faked by a small stand-in that answers as
// summon.rs does: a change registers first and keeps the old key on a failure. Settings is checked for what it says
// is registered; the app for where the cursor goes when the window is brought forward.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { SummonApi, SummonStatus } from "../hermes/summon";
import { hyprlandBind, swayBind } from "../hermes/summon";
import { GlobalShortcutSettings, useSummonStatus } from "./GlobalShortcutSettings";
import { ScreenshotSettings } from "./ScreenshotSettings";
import { getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const base: SummonStatus = {
  backend: "x11",
  wayland: false,
  desktop: "other",
  unavailable: null,
  shortcut: null,
  hideWhenActive: false,
  state: "off",
  trigger: null,
  hyprlandName: null,
  failure: null,
  paused: false,
};

/** Rust's side. `taken`: keys another app has. `deny`: the desktop portal refuses. */
function fakeRust(initial: Partial<SummonStatus> = {}) {
  let s: SummonStatus = { ...base, ...initial };
  const taken = new Set<string>();
  const calls: string[] = [];
  const statusFns = new Set<(s: SummonStatus) => void>();
  const summonedFns = new Set<() => void>();
  let deny = false;
  const register = (key: string): SummonStatus["failure"] =>
    taken.has(key)
      ? { shortcut: key, kind: "conflict", message: `${key} is already used by another app.` }
      : deny
        ? { shortcut: key, kind: "denied", message: "Your desktop didn't allow the shortcut. It may have asked you to confirm it." }
        : null;
  const working = (): SummonStatus["state"] => (s.backend === "none" ? "unavailable" : s.shortcut ? "working" : "off");
  const api: SummonApi = {
    status: async () => s,
    set: async (key) => {
      calls.push(`set ${key}`);
      if (key === null) s = { ...s, shortcut: null, failure: null, paused: false };
      else if (s.backend === "none") s = { ...s, shortcut: key };
      else {
        const failure = register(key);
        s = failure ? { ...s, failure } : { ...s, shortcut: key, failure: null, paused: false };
      }
      return (s = { ...s, state: working() });
    },
    retry: async () => {
      calls.push("retry");
      return s.failure ? api.set(s.failure.shortcut) : s;
    },
    setHide: async (hide) => {
      calls.push(`hide ${hide}`);
      return (s = { ...s, hideWhenActive: hide });
    },
    pause: async (paused) => {
      calls.push(`pause ${paused}`);
      return (s = { ...s, paused: paused && !!s.shortcut });
    },
    onStatus: (fn) => (statusFns.add(fn), () => statusFns.delete(fn)),
    onSummoned: (fn) => (summonedFns.add(fn), () => summonedFns.delete(fn)),
  };
  return {
    api,
    calls,
    taken,
    setDeny: (d: boolean) => (deny = d),
    /** Rust reports a status by itself, as after the desktop changes the key. */
    report: (patch: Partial<SummonStatus>) => act(() => statusFns.forEach((fn) => fn((s = { ...s, ...patch })))),
    summon: () => act(() => summonedFns.forEach((fn) => fn())),
  };
}

function Section({ api, screenshotShortcut = "Ctrl+Shift+S" }: { api: SummonApi; screenshotShortcut?: string | null }) {
  const { status, setStatus, error } = useSummonStatus(api);
  return <GlobalShortcutSettings api={api} status={status} setStatus={setStatus} loadError={error} screenshotShortcut={screenshotShortcut} />;
}

const shortcutButton = () => screen.getByRole("button", { name: "Global shortcut" });
const statusLine = () => screen.getByTestId("global-shortcut-status").textContent;

async function show(rust: ReturnType<typeof fakeRust>) {
  const user = userEvent.setup();
  render(<Section api={rust.api} />);
  await waitFor(() => expect(shortcutButton().hasAttribute("disabled")).toBe(false));
  return user;
}

describe("Global shortcut settings", () => {
  it("says what is actually registered, and turns it on with the default", async () => {
    const rust = fakeRust();
    const user = await show(rust);
    expect(shortcutButton().textContent).toBe("Off");
    expect(statusLine()).toBe("Off. No key is registered.");
    await user.click(screen.getByRole("button", { name: "Reset to Ctrl+Alt+H" }));
    await waitFor(() => expect(statusLine()).toBe("Working: Ctrl+Alt+H brings Hermes Chat forward from any app."));
    expect(shortcutButton().textContent).toBe("Ctrl+Alt+H");
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("records a new shortcut with the grab let go, and changes to it", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    const user = await show(rust);
    await user.click(shortcutButton());
    await waitFor(() => expect(rust.calls).toContain("pause true"));
    await user.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
    await waitFor(() => expect(statusLine()).toBe("Working: Ctrl+Alt+J brings Hermes Chat forward from any app."));
    expect(rust.calls).toContain("set Ctrl+Alt+J");
    await waitFor(() => expect(rust.calls).toContain("pause false"));
  });

  it("keeps the working shortcut when another app has the new one, and retries it", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    rust.taken.add("Ctrl+Alt+P");
    const user = await show(rust);
    await user.click(shortcutButton());
    await user.keyboard("{Control>}{Alt>}p{/Alt}{/Control}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Ctrl+Alt+P is already used by another app.");
    expect(alert.textContent).toContain("Ctrl+Alt+H still works.");
    expect(shortcutButton().textContent).toBe("Ctrl+Alt+H");
    expect(statusLine()).toBe("Working: Ctrl+Alt+H brings Hermes Chat forward from any app.");
    // Still taken: Retry says so again.
    await user.click(within(alert).getByRole("button", { name: "Retry Ctrl+Alt+P" }));
    await waitFor(() => expect(rust.calls.filter((c) => c === "retry")).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toContain("already used");
    // Freed in the other app: Retry takes it.
    rust.taken.delete("Ctrl+Alt+P");
    await user.click(screen.getByRole("button", { name: "Retry Ctrl+Alt+P" }));
    await waitFor(() => expect(statusLine()).toBe("Working: Ctrl+Alt+P brings Hermes Chat forward from any app."));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("won't retry keys the screenshot shortcut took since they failed", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    rust.taken.add("Ctrl+Shift+F9");
    const user = userEvent.setup();
    const { rerender } = render(<Section api={rust.api} screenshotShortcut={null} />);
    await waitFor(() => expect(shortcutButton().hasAttribute("disabled")).toBe(false));
    await user.click(shortcutButton());
    await user.keyboard("{Control>}{Shift>}{F9}{/Shift}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("Ctrl+Shift+F9 is already used by another app.");
    // The screenshot shortcut is then set to the same keys, and the other app lets go of them.
    rerender(<Section api={rust.api} screenshotShortcut="Ctrl+Shift+F9" />);
    rust.taken.delete("Ctrl+Shift+F9");
    await user.click(screen.getByRole("button", { name: "Retry Ctrl+Shift+F9" }));
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("Ctrl+Shift+F9 is already the screenshot shortcut.");
    expect(rust.calls).not.toContain("retry");
    expect(shortcutButton().textContent).toBe("Ctrl+Alt+H");
  });

  it("says when the saved shortcut didn't register at startup", async () => {
    const rust = fakeRust({
      shortcut: "Ctrl+Alt+H",
      state: "failed",
      failure: { shortcut: "Ctrl+Alt+H", kind: "conflict", message: "Ctrl+Alt+H is already used by another app." },
    });
    await show(rust);
    expect(screen.getByRole("alert").textContent).toContain("No global shortcut works now.");
    expect(screen.queryByTestId("global-shortcut-status")).toBeNull();
  });

  it("turns the shortcut off", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    const user = await show(rust);
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(statusLine()).toBe("Off. No key is registered."));
    expect(rust.calls).toContain("set null");
  });

  it("refuses keys other apps type with, terminals copy with, or the screenshot shortcut, without registering", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    const user = await show(rust);
    for (const [keys, error] of [
      ["{Shift>}h{/Shift}", "Add Ctrl, Alt or Super"],
      ["{F5}", "Add Ctrl, Alt or Super"],
      ["{Control>}{Shift>}c{/Shift}{/Control}", "copies in terminals"],
      ["{Control>}{Shift>}s{/Shift}{/Control}", "already the screenshot shortcut"],
      ["{Control>}k{/Control}", "opens Search in Hermes Chat"],
    ]) {
      await user.click(shortcutButton());
      await user.keyboard(keys);
      expect(screen.getByRole("alert").textContent).toContain(error);
      await user.keyboard("{Escape}");
    }
    expect(rust.calls.filter((c) => c.startsWith("set"))).toEqual([]);
    expect(shortcutButton().textContent).toBe("Ctrl+Alt+H");
  });

  it("refuses Reset when the default is the screenshot shortcut", async () => {
    const rust = fakeRust();
    const user = userEvent.setup();
    render(<Section api={rust.api} screenshotShortcut="Ctrl+Alt+H" />);
    await waitFor(() => expect(shortcutButton().hasAttribute("disabled")).toBe(false));
    await user.click(screen.getByRole("button", { name: "Reset to Ctrl+Alt+H" }));
    expect(screen.getByRole("alert").textContent).toContain("Ctrl+Alt+H is already the screenshot shortcut.");
    expect(rust.calls.filter((c) => c.startsWith("set"))).toEqual([]);
  });

  it("through the portal, asks again for the default when the desktop set another key", async () => {
    const rust = fakeRust({ backend: "portal", wayland: true, desktop: "kde", shortcut: "Ctrl+Alt+H", state: "working", trigger: "Meta+H" });
    const user = await show(rust);
    expect(statusLine()).toBe("Working: your desktop says the shortcut is Meta+H.");
    await user.click(screen.getByRole("button", { name: "Reset to Ctrl+Alt+H" }));
    await waitFor(() => expect(rust.calls).toContain("set Ctrl+Alt+H"));
  });

  it("saves whether a press while in front hides the window", async () => {
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    const user = await show(rust);
    const toggle = screen.getByRole("switch", { name: "Hide when already in front" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(rust.calls).toContain("hide true");
  });

  it("on a desktop with no global shortcuts, gives bind lines for the dedicated command", async () => {
    const rust = fakeRust({ backend: "none", wayland: true, desktop: "sway", state: "unavailable", unavailable: "the desktop portal here has no GlobalShortcuts" });
    const user = await show(rust);
    expect(statusLine()).toContain("This desktop doesn't let apps register a global shortcut (the desktop portal here has no GlobalShortcuts)");
    const section = document.querySelector(".global-shortcut-settings")!;
    expect(section.textContent).toContain("bind = CTRL ALT, H, exec, hermes-chat --show");
    expect(section.textContent).toContain("bindsym Ctrl+Mod1+h exec hermes-chat --show");
    // The keys chosen and the hide setting go into the lines.
    await user.click(shortcutButton());
    await user.keyboard("{Meta>}{Shift>}{F9}{/Shift}{/Meta}");
    await waitFor(() => expect(section.textContent).toContain("bind = SHIFT SUPER, F9, exec, hermes-chat --show"));
    await user.click(screen.getByRole("switch", { name: "Hide when already in front" }));
    await waitFor(() => expect(section.textContent).toContain("bindsym Shift+Mod4+F9 exec hermes-chat --toggle"));
  });

  it("through the portal, shows the key the desktop set, and follows its changes", async () => {
    const rust = fakeRust({ backend: "portal", wayland: true, desktop: "kde", shortcut: "Ctrl+Alt+H", state: "working", trigger: "Ctrl+Alt+H" });
    await show(rust);
    expect(statusLine()).toBe("Working: your desktop says the shortcut is Ctrl+Alt+H.");
    rust.report({ trigger: "Meta+H" });
    await waitFor(() => expect(statusLine()).toBe("Working: your desktop says the shortcut is Meta+H."));
    rust.report({ trigger: null });
    await waitFor(() => expect(statusLine()).toContain("hasn't set a key for it yet"));
  });

  it("on Hyprland, gives the global bind for the name Hyprland lists", async () => {
    const rust = fakeRust({ backend: "portal", wayland: true, desktop: "hyprland", shortcut: "Ctrl+Alt+H", state: "working", hyprlandName: "hermes-chat:hermes-chat" });
    await show(rust);
    expect(statusLine()).toContain("bind = CTRL ALT, H, global, hermes-chat:hermes-chat");
    expect(document.querySelector(".global-shortcut-settings")!.textContent).toContain("bind = CTRL ALT, H, exec, hermes-chat --show");
  });

  it("says when the desktop refused, keeping the shortcut in use", async () => {
    const rust = fakeRust({ backend: "portal", wayland: true, desktop: "gnome", shortcut: "Ctrl+Alt+H", state: "working", trigger: "Ctrl+Alt+H" });
    rust.setDeny(true);
    const user = await show(rust);
    await user.click(shortcutButton());
    await user.keyboard("{Control>}{Alt>}m{/Alt}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("Your desktop didn't allow the shortcut.");
    expect(screen.getByRole("alert").textContent).toContain("Ctrl+Alt+H still works.");
  });

  it("outside the desktop app says it isn't there", () => {
    render(<GlobalShortcutSettings status={undefined} setStatus={() => {}} screenshotShortcut={null} />);
    expect(screen.getByText("A global shortcut works only in the desktop app.")).toBeTruthy();
  });
});

describe("The screenshot shortcut beside it", () => {
  it("won't take the global shortcut's keys, recorded or by its default button", async () => {
    setUIPrefs({ screenshotShortcut: null });
    const user = userEvent.setup();
    render(<ScreenshotSettings globalShortcut="Ctrl+Shift+S" />);
    await user.click(screen.getByRole("button", { name: "Use Ctrl+Shift+S" }));
    expect(screen.getByRole("alert").textContent).toContain("Ctrl+Shift+S already shows Hermes Chat from any app.");
    expect(getUIPrefs().screenshotShortcut).toBeNull();
    await user.click(screen.getByRole("button", { name: "Screenshot shortcut" }));
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(screen.getByRole("alert").textContent).toContain("already shows Hermes Chat from any app.");
    expect(getUIPrefs().screenshotShortcut).toBeNull();
  });
});

describe("Bind lines", () => {
  it("writes each desktop's names for keys", () => {
    expect(hyprlandBind("Ctrl+Alt+H", "exec, hermes-chat --show")).toBe("bind = CTRL ALT, H, exec, hermes-chat --show");
    expect(hyprlandBind("Super+PrintScreen", "global, :hermes-chat")).toBe("bind = SUPER, Print, global, :hermes-chat");
    expect(swayBind("Ctrl+Alt+H", "hermes-chat --toggle")).toBe("bindsym Ctrl+Mod1+h exec hermes-chat --toggle");
    expect(swayBind("Super+ScrollLock", "hermes-chat --show")).toBe("bindsym Mod4+Scroll_Lock exec hermes-chat --show");
  });
});

describe("Being brought forward", () => {
  const panes = () => Array.from(document.querySelectorAll<HTMLElement>(".pane"));
  const composerIn = (i: number) => within(panes()[i]).getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");

  async function signedIn() {
    const server = new FakeHermes();
    server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
    server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "How full is the NAS?" }] };
    const hermes = await connect(server.openPipe);
    running.push(hermes);
    const rust = fakeRust({ shortcut: "Ctrl+Alt+H", state: "working" });
    const user = userEvent.setup();
    render(
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} summon={rust.api} onSignOut={async () => {}} />,
    );
    await screen.findByRole("button", { name: /Nightly backup/ });
    await act(async () => void (await hermes.idle()));
    return { hermes, rust, user };
  }

  it("puts the cursor back in the selected pane's composer, with its draft as it was", async () => {
    const { hermes, rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /^Nightly backup/ }));
    await act(async () => void (await hermes.idle()));
    await user.click(screen.getByRole("button", { name: "Split into two panes" }));
    await user.click(screen.getByRole("button", { name: /^NAS disks/ }));
    await act(async () => void (await hermes.idle()));
    await user.click(composerIn(0));
    await user.keyboard("left draft");
    await user.click(composerIn(1));
    await user.keyboard("right draft");
    // The owner went to another app; focus left the composer.
    composerIn(1).blur();
    expect(document.activeElement).toBe(document.body);
    await rust.summon();
    expect(document.activeElement).toBe(composerIn(1));
    expect(composerIn(0).value).toBe("left draft");
    expect(composerIn(1).value).toBe("right draft");
    // The other pane selected: that one gets it.
    await user.keyboard("{Control>}1{/Control}");
    composerIn(0).blur();
    await rust.summon();
    expect(document.activeElement).toBe(composerIn(0));
  }, 30_000);

  it("leaves Settings open as it was", async () => {
    const { rust, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const heading = await screen.findByRole("heading", { name: "Show Hermes Chat from anywhere" });
    const toggle = screen.getByRole("switch", { name: "Hide when already in front" });
    toggle.focus();
    await rust.summon();
    expect(heading.isConnected).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole("button", { name: "Global shortcut" }).textContent).toBe("Ctrl+Alt+H");
  }, 30_000);
});
