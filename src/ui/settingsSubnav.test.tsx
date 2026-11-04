// @vitest-environment jsdom
// Settings' sub-navigation (ADR 0051): General shows one of four groups beside a sub-nav, a search shows every group,
// and the Memory tab lists the two memory files and every profile beside the detail.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { HONCHO } from "../hermes/fakeMemoryProviders";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const highlights = new Map<string, { ranges: Range[] }>();
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  (CSS as unknown as { highlights: typeof highlights }).highlights = highlights;
  (globalThis as unknown as { Highlight: typeof FakeHighlight }).Highlight = FakeHighlight;
});
afterAll(() => {
  delete (CSS as unknown as { highlights?: unknown }).highlights;
  delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  highlights.clear();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

function Shell({ hermes, guard, providers = false }: { hermes: Hermes; guard?: (go: () => void) => void; providers?: boolean }) {
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  return (
    <SettingsScreen
      status="connected"
      route={{ kind: "ssh", target: "liam@hermes" }}
      unsecure={false}
      username="liam"
      passwordSaved
      profile="default"
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      memory={hermes.memory}
      memoryProviders={providers ? hermes.memoryProviders : undefined}
      guard={guard}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => {}}
    />
  );
}

async function shown(opts: { guard?: (go: () => void) => void; providers?: boolean; server?: FakeHermes } = {}) {
  const s = opts.server ?? new FakeHermes();
  s.memory = { default: { memory: ["Owner prefers short answers."], profile: ["Name: Sam."] } };
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  render(<Shell hermes={hermes} guard={opts.guard} providers={opts.providers} />);
  return { s, hermes, user: userEvent.setup() };
}

const nav = (name: string) => screen.getByRole("navigation", { name });
const heading = (name: string | RegExp) => screen.queryByRole("heading", { name });

describe("Settings → General groups", () => {
  it("shows one group beside the sub-nav, Connection first", async () => {
    await shown();
    expect(within(nav("General")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Connection", "Launch, tray & updates", "Voice & screenshots", "Storage & data"]);
    expect(within(nav("General")).getByRole("button", { name: "Connection" }).getAttribute("aria-current")).toBe("true");
    expect(heading("Connection in use")).toBeTruthy();
    expect(heading("Local cache")).toBeNull();
    expect(heading("On launch")).toBeNull();
  });

  it("switches groups by click and by arrow keys", async () => {
    const { user } = await shown();
    await user.click(within(nav("General")).getByRole("button", { name: "Storage & data" }));
    expect(heading("Local cache")).toBeTruthy();
    expect(heading("History")).toBeTruthy();
    expect(heading("Connection in use")).toBeNull();
    await user.keyboard("{ArrowUp}");
    expect(heading("Voice")).toBeTruthy();
    expect(within(nav("General")).getByRole("button", { name: "Voice & screenshots" }).getAttribute("aria-current")).toBe("true");
    await user.keyboard("{Home}");
    expect(heading("Connection in use")).toBeTruthy();
  });

  it("shows every group's sections while searching, and the chosen group again after", async () => {
    const { user } = await shown();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "cache");
    expect(screen.queryByRole("navigation", { name: "General" })).toBeNull();
    expect(heading("Local cache")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    expect(heading("Connection in use")).toBeTruthy();
    expect(heading("Local cache")).toBeNull();
  });
});

describe("Settings → Memory list", () => {
  it("lists the two files, shows the picked one, and marks it", async () => {
    const { user } = await shown();
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(within(nav("Memory")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent notes", "User profile"]);
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Memory files" })).toBeNull();
    await user.click(within(nav("Memory")).getByRole("button", { name: "User profile" }));
    expect(within(nav("Memory")).getByRole("button", { name: "User profile" }).getAttribute("aria-current")).toBe("true");
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
    expect(screen.getByText("/home/liam/.hermes/memories/USER.md")).toBeTruthy();
  });

  it("lists every profile under External memory once read, and shows one profile's providers beside the list", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { research: [], work: [] };
    const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] });
    fake.active = { default: "honcho", research: "honcho", work: "" };
    const { user } = await shown({ server, providers: true });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    await waitFor(() => expect(within(nav("Memory")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Agent notes", "User profile", "default", "research", "work"]));
    expect(within(nav("Memory")).getByText("External memory")).toBeTruthy();
    // The provider part stays mounted but hidden until a profile is picked.
    expect(screen.queryByRole("list", { name: "Memory providers for default" })).toBeNull();
    await user.click(within(nav("Memory")).getByRole("button", { name: "research" }));
    expect(await screen.findByRole("list", { name: "Memory providers for research" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Provider for/ }).textContent).toBe("Provider for research");
    // The all-profiles table is under a fold, still there for a reader.
    expect(screen.getByText("All profiles and their stores")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Memory provider by profile", hidden: true })).toBeTruthy();
    await user.click(within(nav("Memory")).getByRole("button", { name: "Agent notes" }));
    expect(await screen.findByRole("list", { name: "Agent notes entries" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Memory providers for research" })).toBeNull();
  });

  it("asks through the same guard as a tab switch before leaving an unsaved entry", async () => {
    const asked: (() => void)[] = [];
    let unsaved = false;
    // App's guard runs at once while nothing is unsaved and asks otherwise; this one asks once the edit is typed.
    const { user } = await shown({ guard: (go) => (unsaved ? void asked.push(go) : go()) });
    await user.click(screen.getByRole("tab", { name: /Memory/ }));
    const entries = await screen.findByRole("list", { name: "Agent notes entries" });
    await user.click(within(entries).getByRole("button", { name: /Owner prefers/ }));
    await user.type(screen.getByRole("textbox", { name: /Entry in/ }), " Really.");
    unsaved = true;
    await user.click(within(nav("Memory")).getByRole("button", { name: "User profile" }));
    // The guard holds the switch: the entry stays open and the list still shows Agent notes.
    expect(asked).toHaveLength(1);
    expect(within(nav("Memory")).getByRole("button", { name: "Agent notes" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("textbox", { name: /Entry in/ })).toBeTruthy();
    asked[0]();
    expect(await screen.findByRole("list", { name: "User profile entries" })).toBeTruthy();
  });
});
