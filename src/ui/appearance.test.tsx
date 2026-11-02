// @vitest-environment jsdom
// Appearance settings: what is kept, what reaches the page as CSS, and the Settings section driving both.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, appearanceStore, cssFamily, loadAppearance } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { statusBarStore } from "./StatusBar";

const KEY = "hermes-chat.appearance";

function memoryStorage(saved?: unknown) {
  const items = new Map<string, string>();
  if (saved !== undefined) items.set(KEY, typeof saved === "string" ? saved : JSON.stringify(saved));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

afterEach(cleanup);

describe("Kept appearance", () => {
  it("is the default when nothing, or nothing readable, is kept", () => {
    expect(loadAppearance(memoryStorage())).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(memoryStorage("{not json"))).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(memoryStorage("null"))).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps the owner's choices and puts anything not on offer back to its default", () => {
    const kept = { uiFont: "Noto Sans", uiSize: 16, monoFont: "Fira Code", monoSize: 15, wordWrap: true };
    expect(loadAppearance(memoryStorage(kept))).toEqual(kept);
    expect(loadAppearance(memoryStorage({ uiFont: 3, uiSize: 99, monoFont: "a\nb", monoSize: "13", wordWrap: "yes" }))).toEqual(DEFAULT_APPEARANCE);
  });

  it("survives a restart", () => {
    const storage = memoryStorage();
    appearanceStore(storage, document.createElement("html")).set({ monoFont: "Fira Code", wordWrap: true });
    expect(appearanceStore(storage, document.createElement("html")).get()).toMatchObject({ monoFont: "Fira Code", wordWrap: true });
  });
});

describe("Applied appearance", () => {
  it("sets the root's fonts, sizes and wrapping, and removes a font set back to the default", () => {
    const root = document.createElement("html");
    const store = appearanceStore(memoryStorage(), root);
    expect(root.style.fontSize).toBe("14px");
    expect(root.style.getPropertyValue("--mono-size")).toBe("13px");
    expect(root.style.getPropertyValue("--ui-font")).toBe("");
    expect(root.classList.contains("wrap-code")).toBe(false);

    store.set({ uiFont: "Noto Sans", uiSize: 17, monoSize: 15, wordWrap: true });
    expect(root.style.fontSize).toBe("17px");
    expect(root.style.getPropertyValue("--ui-font")).toBe('"Noto Sans"');
    expect(root.style.getPropertyValue("--mono-size")).toBe("15px");
    expect(root.classList.contains("wrap-code")).toBe(true);

    store.set({ uiFont: "", wordWrap: false });
    expect(root.style.getPropertyValue("--ui-font")).toBe("");
    expect(root.classList.contains("wrap-code")).toBe(false);
  });

  it("quotes a family name so quotes and backslashes in it stay part of the name", () => {
    expect(cssFamily('Odd "Font" \\ Name')).toBe('"Odd \\"Font\\" \\\\ Name"');
  });
});

describe("Settings, Appearance", () => {
  const fonts = async () => ({ all: ["Fira Code", "Noto Sans"], mono: ["Fira Code"] });

  function shown(saved?: unknown) {
    const storage = memoryStorage(saved);
    const root = document.createElement("html");
    const store = appearanceStore(storage, root);
    render(<AppearanceSettings store={store} statusBar={statusBarStore(storage)} listFonts={fonts} />);
    return { storage, root, store };
  }

  it("lists the installed fonts, monospace ones first for code", async () => {
    shown();
    const code = screen.getByRole<HTMLSelectElement>("combobox", { name: "Code font" });
    await screen.findAllByRole("option", { name: "Noto Sans" });
    expect([...code.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)])).toEqual([
      ["Monospace", ["Fira Code"]],
      ["Other fonts", ["Noto Sans"]],
    ]);
  });

  it("applies and keeps a font and size as soon as they're picked", async () => {
    const { root, storage } = shown();
    await screen.findAllByRole("option", { name: "Noto Sans" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface font" }), "Noto Sans");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Code font size" }), "16");
    expect(root.style.getPropertyValue("--ui-font")).toBe('"Noto Sans"');
    expect(root.style.getPropertyValue("--mono-size")).toBe("16px");
    expect(JSON.parse(storage.items.get(KEY)!)).toMatchObject({ uiFont: "Noto Sans", monoSize: 16 });
  });

  it("keeps a saved font listed after it's uninstalled", () => {
    shown({ uiFont: "Gone Sans" });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Interface font" }).value).toBe("Gone Sans");
  });

  it("resets a font row to the default, and offers the reset only when it differs", async () => {
    const { store } = shown({ monoFont: "Fira Code", monoSize: 18 });
    expect(screen.queryByRole("button", { name: "Reset interface font" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset code font" }));
    expect(store.get()).toMatchObject({ monoFont: "", monoSize: 13 });
    expect(screen.queryByRole("button", { name: "Reset code font" })).toBeNull();
  });

  it("turns Word wrap on and off", async () => {
    const { root } = shown();
    const wrap = screen.getByRole("switch", { name: "Word wrap" });
    expect(wrap.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(wrap);
    expect(wrap.getAttribute("aria-checked")).toBe("true");
    expect(root.classList.contains("wrap-code")).toBe(true);
    await userEvent.click(wrap);
    expect(root.classList.contains("wrap-code")).toBe(false);
  });
});
