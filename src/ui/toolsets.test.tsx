// @vitest-environment jsdom
// Settings → Toolsets on screen, against the fake dashboard: the list and its scope, saving, refusals, read-back
// mismatches, changes made elsewhere, servers that can't change toolsets, running replies, and profile switching.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect } from "../hermes/transport";
import { ToolsetSettings } from "./ToolsetSettings";
import { SettingsScreen } from "./Settings";
import { appearanceStore } from "./appearance";

afterEach(cleanup);

async function shown(server = new FakeHermes(), props: { runningReplies?: number; connected?: boolean; profile?: string } = {}) {
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  const view = (p: typeof props) => (
    <ToolsetSettings key={p.profile ?? "default"} api={hermes.toolsets} profile={p.profile ?? "default"} connected={p.connected ?? true} runningReplies={p.runningReplies} />
  );
  const r = render(view(props));
  if (props.connected !== false) await screen.findByText(/Read from Hermes at/);
  return { server, hermes, user, rerender: (p: typeof props) => r.rerender(view(p)) };
}

const toggle = (name: string) => screen.getByRole("switch", { name: new RegExp(`^${name}`) });
const toolsetWrites = (server: FakeHermes) => server.toolsetWrites.map((w) => `${w.profile}:${w.name}=${w.enabled}`);

describe("Settings → Toolsets", () => {
  it("is a tab of Settings", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, "default");
    const user = userEvent.setup();
    const storage = new Map<string, string>();
    const appearance = appearanceStore({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) }, document.createElement("html"));
    render(
      <SettingsScreen
        status="connected"
        unsecure={false}
        username="liam"
        passwordSaved
        profile="default"
        olderPulled={false}
        cacheBytes={() => 0}
        appearance={appearance}
        listFonts={async () => ({ all: [], mono: [] })}
        modelSettings={hermes.modelSettings}
        toolsets={hermes.toolsets}
        onClearCache={() => {}}
        onPullOlder={async () => []}
        onSignOut={async () => {}}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Toolsets/ }));
    expect(await screen.findByRole("switch", { name: /^Web Search/ })).toBeTruthy();
  });

  it("lists the toolsets with their state, scope and when changes apply", async () => {
    await shown();
    expect(screen.getByRole("heading", { name: "Toolsets" })).toBeTruthy();
    expect(screen.getByText(/Hermes keeps this choice on the server, in the profile's settings/)).toBeTruthy();
    expect(screen.getByText(/in chats Hermes starts after the change/)).toBeTruthy();
    expect(screen.getByText(/Toolsets aren't Approvals/)).toBeTruthy();
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("web_search, web_extract")).toBeTruthy();
    // Needs setup on the server; another platform's toolset is apart and says whose it is.
    expect(screen.getByText("Needs setup")).toBeTruthy();
    const others = screen.getByRole("group", { name: "Toolsets for other platforms" });
    expect(within(others).getByText("Discord only")).toBeTruthy();
    expect(within(others).getByText(/Changes Hermes's Discord chats, not this app's/)).toBeTruthy();
    expect(screen.getByText(/turns speech-to-text on or off for the profile/)).toBeTruthy();
  });

  it("shows Saving while the change is on its way, blocks other changes, then reports the read-back", async () => {
    const { server, user } = await shown();
    let release!: () => void;
    server.toolsetGate = new Promise((r) => (release = r));
    await user.click(toggle("Web Search & Scraping"));
    expect(await screen.findByText("Saving: turning Web Search & Scraping off…")).toBeTruthy();
    // Every switch waits; a second click sends nothing.
    expect((toggle("File Operations") as HTMLButtonElement).disabled).toBe(true);
    await user.click(toggle("File Operations"));
    await user.click(toggle("Web Search & Scraping"));
    act(() => release());
    expect(await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/)).toBeTruthy();
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("false");
    expect(toolsetWrites(server)).toEqual(["default:web=false"]);
  });

  it("shows a change made elsewhere instead of overwriting it", async () => {
    const { server, user } = await shown();
    server.enabledToolsets("default").delete("terminal");
    await user.click(toggle("Terminal & Processes"));
    expect(await screen.findByText(/Not changed: Terminal & Processes was turned off elsewhere/)).toBeTruthy();
    expect(toggle("Terminal & Processes").getAttribute("aria-checked")).toBe("false");
    expect(server.toolsetWrites).toEqual([]);
  });

  it("reports a refused change and keeps the switch as Hermes has it", async () => {
    const { server, user } = await shown();
    server.toolsetRefusal = { status: 403, detail: "Profile is managed by an administrator" };
    await user.click(toggle("Web Search & Scraping"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Hermes didn't make the change (Profile is managed by an administrator). It reads Web Search & Scraping back as on.",
    );
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
  });

  it("doesn't claim success when the read-back disagrees", async () => {
    const { server, user } = await shown();
    server.toolsetSuppressed.add("image_gen");
    await user.click(toggle("Image Generation"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes took the change but reads Image Generation back as off/);
    expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("false");
  });

  it("says when the outcome is unknown, and a later read settles it", async () => {
    const { server, user } = await shown();
    server.dropOnToolsetWrite = "lost";
    await user.click(toggle("Web Search & Scraping"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hermes didn't confirm the change .*Read back just now, Web Search & Scraping is on/);
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText(/Hermes didn't confirm the change/)).toBeNull());
  });

  it("asks before turning on a toolset that may start an install on the server", async () => {
    const { server, user } = await shown();
    await user.click(toggle("Computer Use"));
    const ask = await screen.findByRole("alertdialog", { name: "Install on the server" });
    expect(ask.textContent).toMatch(/Hermes starts installing cua_driver on the server when it.s turned on/);
    await user.click(within(ask).getByRole("button", { name: "Keep it off" }));
    expect(server.toolsetWrites).toEqual([]);
    await user.click(toggle("Computer Use"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText(/Hermes also started installing cua_driver on the server/)).toBeTruthy();
    expect(toolsetWrites(server)).toEqual(["default:computer_use=true"]);
  });

  it("offers no switches on a server that can't change toolsets", async () => {
    const server = new FakeHermes();
    server.toolsetRoutes = "read-only";
    await shown(server);
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(screen.getByText(/lists toolsets but has no route to change them/)).toBeTruthy();
    expect(screen.getByLabelText("Web Search & Scraping is on")).toBeTruthy();
  });

  it("says what's missing on a server without toolset routes", async () => {
    const server = new FakeHermes();
    server.toolsetRoutes = "none";
    const hermes = await connect(server.openPipe, "default");
    render(<ToolsetSettings api={hermes.toolsets} profile="default" connected />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/has no \/api\/tools\/toolsets route/);
  });

  it("says a running reply keeps its tools", async () => {
    await shown(undefined, { runningReplies: 2 });
    expect(screen.getByText(/A reply is running in 2 chats of this profile. A change here doesn't reach them/)).toBeTruthy();
  });

  it("keeps the last read while disconnected, without changes, and reads again once back", async () => {
    const { server, rerender } = await shown();
    rerender({ connected: false });
    expect(screen.getByText(/Not connected to Hermes. This is what Hermes had at/)).toBeTruthy();
    expect((toggle("Web Search & Scraping") as HTMLButtonElement).disabled).toBe(true);
    server.enabledToolsets("default").delete("web");
    rerender({ connected: true });
    await waitFor(() => expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("false"));
  });

  it("before connecting, says to connect", async () => {
    await shown(undefined, { connected: false });
    expect(screen.getByText("Connect to Hermes to see the profile's toolsets.")).toBeTruthy();
  });

  it("reads changes made elsewhere when the window is focused again, dropping notes they outdate", async () => {
    const { server, user } = await shown();
    await user.click(toggle("Web Search & Scraping"));
    await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/);
    server.enabledToolsets("default").add("image_gen");
    server.enabledToolsets("default").add("web");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("true"));
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Saved:/)).toBeNull();
  });

  it("shows each profile's own toolsets, and drops a result for the profile left", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    server.enabledToolsets("work").delete("file");
    const { user, rerender } = await shown(server);
    expect(toggle("File Operations").getAttribute("aria-checked")).toBe("true");
    let release!: () => void;
    server.toolsetGate = new Promise((r) => (release = r));
    await user.click(toggle("Web Search & Scraping"));
    await screen.findByText(/Saving: turning Web Search & Scraping off/);
    rerender({ profile: "work" });
    await screen.findByText(/Read from Hermes at/);
    expect(screen.getByText("work")).toBeTruthy();
    expect(toggle("File Operations").getAttribute("aria-checked")).toBe("false");
    act(() => release());
    await waitFor(() => expect(server.toolsetWrites).toHaveLength(1));
    expect(toolsetWrites(server)).toEqual(["default:web=false"]);
    // The work profile's list isn't touched by default's result.
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Saved:/)).toBeNull();
  });
});

