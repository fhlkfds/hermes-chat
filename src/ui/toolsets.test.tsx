// @vitest-environment jsdom
// Settings → Toolsets on screen, against the fake dashboard: the list and its scope, saving, refusals, read-back
// mismatches, changes made elsewhere, servers that can't change toolsets, running replies, and profile switching.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect } from "../hermes/transport";
import { PROBE_NAME } from "../hermes/toolsets";
import { ToolsetSettings, type OpenChat } from "./ToolsetSettings";
import { SettingsScreen } from "./Settings";
import { appearanceStore } from "./appearance";

afterEach(cleanup);

async function shown(server = new FakeHermes(), props: { runningReplies?: number; connected?: boolean; profile?: string; chat?: OpenChat } = {}) {
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  const view = (p: typeof props) => (
    <ToolsetSettings key={p.profile ?? "default"} api={hermes.toolsets} profile={p.profile ?? "default"} connected={p.connected ?? true} runningReplies={p.runningReplies} chat={p.chat} />
  );
  const r = render(view(props));
  if (props.connected !== false) await screen.findByText(/Read from Hermes at/);
  return { server, hermes, user, rerender: (p: typeof props) => r.rerender(view(p)) };
}

/** A chat started in the app and stored by Hermes, as the open chat prop shows it. */
async function startedChat(hermes: Awaited<ReturnType<typeof connect>>): Promise<OpenChat> {
  const id = await hermes.newChat();
  await hermes.send(id, "hello");
  return openChat(hermes, id);
}
const openChat = (hermes: Awaited<ReturnType<typeof connect>>, id: string): OpenChat => {
  const c = hermes.getSnapshot().chats.find((x) => x.id === id)!;
  return { id: c.id, title: c.title, runtimeId: c.runtimeId, running: c.running };
};
async function mount(hermes: Awaited<ReturnType<typeof connect>>, chat: OpenChat) {
  const r = render(<ToolsetSettings api={hermes.toolsets} profile="default" connected chat={chat} />);
  await screen.findByText(/Read from Hermes at/);
  return r;
}
const rowOf = (name: string) => toggle(name).closest(".toolset-row") as HTMLElement;

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
    expect(screen.getByText(/Hermes keeps this list on the server, in the profile's settings/)).toBeTruthy();
    expect(screen.getByText(/in chats Hermes starts after the change/)).toBeTruthy();
    expect(screen.getByText(/Toolsets aren't Approvals/)).toBeTruthy();
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("web_search, web_extract")).toBeTruthy();
    // Needs setup on the server; another platform's toolset is apart and says whose it is.
    const imageGen = toggle("Image Generation").closest(".toolset-row") as HTMLElement;
    expect(within(imageGen).getByText("Needs setup")).toBeTruthy();
    expect(within(toggle("Web Search & Scraping").closest(".toolset-row") as HTMLElement).queryByText("Needs setup")).toBeNull();
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
      "Hermes refused the change (Profile is managed by an administrator). It reads Web Search & Scraping back as on.",
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
    // The note stays, now saying what Hermes has, so the owner still sees that the change didn't go through.
    expect(await screen.findByText(/Hermes didn't confirm the last change \(Can't reach the Hermes dashboard: connection reset\). Read back at .*, Web Search & Scraping is on./)).toBeTruthy();
    expect(screen.queryByText(/so it may or may not have it/)).toBeNull();
  });

  it("takes a click while a read started by coming back to the window is still on its way", async () => {
    const { server, user } = await shown();
    let releaseRead!: () => void;
    server.toolsetListGateOnce = new Promise((r) => (releaseRead = r));
    act(() => void window.dispatchEvent(new Event("focus")));
    await screen.findByText("Reading the toolsets from Hermes…");
    expect((toggle("Web Search & Scraping") as HTMLButtonElement).disabled).toBe(false);
    await user.click(toggle("Web Search & Scraping"));
    expect(await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/)).toBeTruthy();
    act(() => releaseRead()); // The older read lands after the change's result and is dropped.
    await waitFor(() => expect(screen.queryByText("Reading the toolsets from Hermes…")).toBeNull());
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("false");
    expect(toolsetWrites(server)).toEqual(["default:web=false"]);
  });

  it("asks before turning on a toolset that may start an install on the server", async () => {
    const { server, user } = await shown();
    await user.click(toggle("Computer Use"));
    const ask = await screen.findByRole("alertdialog", { name: /Turn Computer Use .* on/ });
    expect(ask.textContent).toMatch(/Hermes starts installing cua_driver on the server when Computer Use .* is turned on/);
    await user.click(within(ask).getByRole("button", { name: "Keep it off" }));
    expect(server.toolsetWrites).toEqual([]);
    await user.click(toggle("Computer Use"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText(/Hermes also started installing cua_driver on the server/)).toBeTruthy();
    expect(toolsetWrites(server)).toEqual(["default:computer_use=true"]);
  });

  it("asks before a change when it couldn't check what turning a toolset on does", async () => {
    const server = new FakeHermes();
    const { user } = await shown(server);
    server.toolsetConfigFailure = "The dashboard answered 500: {}";
    await user.click(toggle("Computer Use"));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/couldn't check whether turning Computer Use .* on starts an install on the server/);
    expect(server.toolsetWrites).toEqual([]);
  });

  it("asks before a change that clears no_mcp, and says MCP servers are back once read back", async () => {
    const server = new FakeHermes();
    server.toolsetNoMcp.default = new Set(["cli"]);
    const { user } = await shown(server);
    await user.click(toggle("Terminal & Processes"));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/MCP servers turned off for CLI with no_mcp. Hermes clears no_mcp whenever it saves/);
    expect(server.toolsetWrites).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/Hermes cleared no_mcp, so new chats are offered the profile's MCP servers again/)).toBeTruthy();
  });

  it("shows what agent.disabled_toolsets turns off everywhere, and asks before turning one on", async () => {
    const server = new FakeHermes();
    server.toolsetDisabledEverywhere.default = ["image_gen", "debugging"];
    server.toolsetProviders.image_gen = [{ name: "FAL", status: "ready", is_active: true }];
    const { user } = await shown(server);
    expect(await screen.findByText("Forced off on every platform")).toBeTruthy();
    expect(screen.getByText(/agent.disabled_toolsets also names debugging, which turns off the tools inside it on every platform/)).toBeTruthy();
    await user.click(toggle("Image Generation"));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/agent.disabled_toolsets turns Image Generation off on every platform. Turning it on here removes it from that list/);
    expect(server.toolsetWrites).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText(/Hermes also removed it from agent.disabled_toolsets, so it's back on every platform that lists it/)).toBeTruthy();
    expect(screen.queryByText("Forced off on every platform")).toBeNull();
    expect(toolsetWrites(server)).toEqual(["default:image_gen=true"]);
    expect(server.toolsetDisabledEverywhere.default).toEqual(["debugging"]);
  });

  it("asks under the toolset it's about, with the keyboard on Keep, and hands it back to the switch", async () => {
    const server = new FakeHermes();
    server.toolsetDisabledEverywhere.default = ["image_gen"];
    const { user } = await shown(server);
    await user.click(toggle("Image Generation"));
    const ask = await screen.findByRole("alertdialog", { name: "Turn Image Generation on" });
    // Right after its toolset's row, not above the list.
    const row = toggle("Image Generation").closest(".toolset-row")!;
    expect(row.nextElementSibling).toBe(ask);
    await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Keep it off" })));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(toggle("Image Generation"));
    expect(server.toolsetWrites).toEqual([]);
  });

  it("marks a toolset whose provider isn't ready, though Hermes counts it configured", async () => {
    const server = new FakeHermes();
    server.toolsetProviders.stt = [{ name: "Local Whisper", status: "needs_setup", is_active: true }];
    await shown(server);
    const stt = toggle("Speech-to-Text").closest(".toolset-row") as HTMLElement;
    expect(await within(stt).findByText("Needs setup")).toBeTruthy();
    expect(within(stt).getByText(/Its provider, Local Whisper, isn't installed or set up on the server/)).toBeTruthy();
  });

  it("an older provider check landing after a newer one doesn't replace what it found", async () => {
    const server = new FakeHermes();
    let releaseOld!: () => void;
    server.toolsetConfigGate.stt = new Promise((r) => (releaseOld = r)); // The first check sees stt ready, slowly.
    const { user } = await shown(server);
    server.toolsetProviders.stt = [{ name: "Local Whisper", status: "needs_setup", is_active: true }];
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const stt = () => toggle("Speech-to-Text").closest(".toolset-row") as HTMLElement;
    expect(await within(stt()).findByText("Needs setup")).toBeTruthy();
    act(() => releaseOld());
    await new Promise((r) => setTimeout(r, 20));
    expect(within(stt()).getByText("Needs setup")).toBeTruthy();
  });

  it("doesn't ask about a change once a refresh shows the toolset changed elsewhere", async () => {
    const server = new FakeHermes();
    const { user } = await shown(server);
    let releaseCheck!: () => void;
    server.toolsetConfigGate.computer_use = new Promise((r) => (releaseCheck = r));
    await user.click(toggle("Computer Use"));
    await screen.findByText(/Checking what turning Computer Use .* on does/);
    server.enabledToolsets("default").add("computer_use"); // Turned on in another client meanwhile.
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(toggle("Computer Use").getAttribute("aria-checked")).toBe("true"));
    act(() => releaseCheck());
    expect(await screen.findByText(/Not changed: Computer Use .* was turned on elsewhere while this was being checked/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.toolsetWrites).toEqual([]);
  });

  it("checks against a refresh that lands in the same render as the check", async () => {
    const server = new FakeHermes();
    const { user } = await shown(server);
    let releaseCheck!: () => void;
    server.toolsetConfigGate.computer_use = new Promise((r) => (releaseCheck = r));
    await user.click(toggle("Computer Use"));
    await screen.findByText(/Checking what turning Computer Use .* on does/);
    server.enabledToolsets("default").add("computer_use"); // Turned on in another client meanwhile.
    let releaseRead!: () => void;
    server.toolsetListGateOnce = new Promise((r) => (releaseRead = r));
    act(() => void window.dispatchEvent(new Event("focus")));
    // The refresh's answer, then the check's, with no render between them.
    await act(async () => {
      releaseRead();
      await new Promise((r) => setTimeout(r, 20));
      releaseCheck();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(toggle("Computer Use").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText(/Not changed: Computer Use .* was turned on elsewhere while this was being checked/)).toBeTruthy();
    expect(server.toolsetWrites).toEqual([]);
  });

  it("closes an open confirmation when a refresh shows its toolset changed", async () => {
    const server = new FakeHermes();
    const { user } = await shown(server);
    await user.click(toggle("Computer Use"));
    await screen.findByRole("alertdialog");
    server.enabledToolsets("default").add("computer_use");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText(/Not changed: Computer Use .* was turned on elsewhere/)).toBeTruthy();
    expect(server.toolsetWrites).toEqual([]);
  });

  it("says when coding focus mode or a server pin replaces the list", async () => {
    const server = new FakeHermes();
    server.codingFocus.default = true;
    await shown(server);
    expect(await screen.findByText(/agent.coding_context is focus: in a code workspace, Hermes gives new chats its own coding selection/)).toBeTruthy();
    expect(screen.getByText("HERMES_TUI_TOOLSETS")).toBeTruthy();
  });

  it("leaving and reopening the tab mid-change still shows it saving, blocks other changes, then shows the result", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, "default");
    const user = userEvent.setup();
    const first = render(<ToolsetSettings api={hermes.toolsets} profile="default" connected />);
    await screen.findByText(/Read from Hermes at/);
    let release!: () => void;
    server.toolsetGateBeforeWrite = new Promise((r) => (release = r));
    await user.click(toggle("Web Search & Scraping"));
    await screen.findByText(/Saving: turning Web Search & Scraping off/);
    first.unmount();
    render(<ToolsetSettings api={hermes.toolsets} profile="default" connected />);
    expect(await screen.findByText(/Saving: turning Web Search & Scraping off/)).toBeTruthy();
    expect((toggle("File Operations") as HTMLButtonElement).disabled).toBe(true);
    await user.click(toggle("File Operations"));
    act(() => release());
    await waitFor(() => expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("false"));
    expect(toolsetWrites(server)).toEqual(["default:web=false"]);
  });

  it("a reconnect during a change reads again once the change is done", async () => {
    const { server, user, rerender } = await shown();
    let release!: () => void;
    server.toolsetGateBeforeWrite = new Promise((r) => (release = r));
    await user.click(toggle("Web Search & Scraping"));
    await screen.findByText(/Saving: turning Web Search & Scraping off/);
    rerender({ connected: false });
    server.enabledToolsets("default").add("image_gen"); // Changed in another client while this one was away.
    rerender({ connected: true });
    act(() => release());
    await waitFor(() => expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("true"));
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("false");
  });

  it("asks again, sending nothing, when no_mcp appears between the confirmation and the write", async () => {
    const server = new FakeHermes();
    const { user } = await shown(server);
    await user.click(toggle("Computer Use"));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).not.toMatch(/no_mcp/);
    server.toolsetNoMcp.default = new Set(["cli"]); // Another client turns MCP servers off meanwhile.
    await user.click(within(ask).getByRole("button", { name: "Turn on" }));
    const again = await screen.findByRole("alertdialog");
    expect(again.textContent).toMatch(/Checked again just before sending, this changed since you were asked/);
    expect(again.textContent).toMatch(/turned off for CLI with no_mcp/);
    expect(server.toolsetWrites).toEqual([]);
    expect(server.toolsetNoMcp.default.has("cli")).toBe(true);
    await user.click(within(again).getByRole("button", { name: "Turn on" }));
    await screen.findByText(/Hermes cleared no_mcp/);
    expect(toolsetWrites(server)).toEqual(["default:computer_use=true"]);
  });

  it("a reconnect read waiting behind a read that turns out stale still runs", async () => {
    const { server, user, rerender } = await shown();
    let releaseWrite!: () => void;
    server.toolsetGateBeforeWrite = new Promise((r) => (releaseWrite = r));
    await user.click(toggle("Web Search & Scraping"));
    await screen.findByText(/Saving: turning Web Search & Scraping off/);
    // A focus read starts and hangs; then the connection drops and comes back.
    let releaseRead!: () => void;
    server.toolsetListGateOnce = new Promise((r) => (releaseRead = r));
    act(() => void window.dispatchEvent(new Event("focus")));
    rerender({ connected: false });
    rerender({ connected: true });
    const probes = () => server.restRequests.filter((q) => q.method === "PUT" && q.path.endsWith(PROBE_NAME)).length;
    const probesBefore = probes();
    server.enabledToolsets("default").add("image_gen"); // Changed elsewhere while away.
    act(() => releaseWrite());
    await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/);
    act(() => releaseRead()); // The hung read lands after the change's result: dropped, and the reconnect read runs.
    await waitFor(() => expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(probes()).toBe(probesBefore + 1));
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
    expect(screen.getAllByText("work").length).toBe(2);
    expect(toggle("File Operations").getAttribute("aria-checked")).toBe("false");
    act(() => release());
    await waitFor(() => expect(server.toolsetWrites).toHaveLength(1));
    expect(toolsetWrites(server)).toEqual(["default:web=false"]);
    // The work profile's list isn't touched by default's result.
    expect(toggle("Web Search & Scraping").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Saved:/)).toBeNull();
  });

  describe("scope: this chat, the profile, the whole server", () => {
    it("says what a change reaches, offering a change only for the profile", async () => {
      await shown();
      const scopes = document.querySelector("dl.toolset-scopes") as HTMLElement;
      expect(scopes.getAttribute("aria-label")).toBe("What a change reaches");
      const terms = within(scopes).getAllByRole("term").map((t) => t.textContent);
      expect(terms).toEqual(["This chat Not changeable here", "The default profile Changed here", "The whole server Not changeable here"]);
      expect(scopes.textContent).toMatch(/its only way rebuilds the chat's agent and clears what the chat holds in memory/);
      expect(scopes.textContent).toMatch(/HERMES_TUI_TOOLSETS/);
      // No switch for a chat or for the server: every switch is a toolset of the profile.
      expect(screen.getAllByRole("switch").every((s) => s.closest(".toolset-row"))).toBe(true);
    });

    it("shows the profile's list as inherited until a change saves it, read back from the config", async () => {
      const { server, user } = await shown();
      expect(await screen.findByText(/Inherited: the profile hasn't saved a list of its own/)).toBeTruthy();
      expect(within(rowOf("Web Search & Scraping")).getByText("Inherited")).toBeTruthy();
      await user.click(toggle("Web Search & Scraping"));
      await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/);
      expect(await screen.findByText(/Saved in profile: the profile has its own list/)).toBeTruthy();
      expect(within(rowOf("Web Search & Scraping")).queryByText("Inherited")).toBeNull();
      expect([...server.toolsetSavedLists.default]).toEqual(["cli"]);
    });

    it("says nothing about inheritance when the saved list can't be read for certain", async () => {
      const server = new FakeHermes();
      server.toolsetNoMcpUnclear.default = ["cli"];
      await shown(server);
      expect(await screen.findByText(/can't tell whether the profile has saved its own list/)).toBeTruthy();
      expect(within(rowOf("Web Search & Scraping")).queryByText("Inherited")).toBeNull();
    });

    it("keeps forced-off apart from the profile's own value", async () => {
      const server = new FakeHermes();
      server.toolsetDisabledEverywhere.default = ["terminal"];
      await shown(server);
      const row = rowOf("Terminal & Processes");
      expect(await within(row).findByText("Forced off on every platform")).toBeTruthy();
      expect(within(row).getByText("Inherited")).toBeTruthy();
      expect(toggle("Terminal & Processes").getAttribute("aria-checked")).toBe("false");
    });
  });

  describe("the open chat", () => {
    it("shows what Hermes offers the open chat, and that a profile change doesn't reach it on its next turn", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      const user = userEvent.setup();
      await mount(hermes, chat);
      expect(await within(rowOf("Web Search & Scraping")).findByText(/This chat: has it\./)).toBeTruthy();
      expect(within(rowOf("Image Generation")).getByText(/This chat: doesn't have it\./)).toBeTruthy();
      expect(screen.getByRole("status", { name: "This chat" }).textContent).toMatch(/“hello”: what Hermes offers it, read at/);
      // No chat line for a setting without tools, or another platform's toolset.
      expect(screen.getAllByText(/This chat:/)).toHaveLength(5);

      await user.click(toggle("Web Search & Scraping"));
      await screen.findByText(/Saved: Hermes reads Web Search & Scraping back as off/);
      // Read again after the save: the open chat keeps its tools, and says that isn't the profile's setting.
      await waitFor(() => expect(within(rowOf("Web Search & Scraping")).getByText(/That isn't the profile's setting/)).toBeTruthy());
      expect(within(rowOf("Web Search & Scraping")).getByText(/This chat: has it\./)).toBeTruthy();
      // A chat started now, its first turn included, is built without it.
      const next = await hermes.newChat();
      const fresh = await hermes.toolsets.chatTools(openChat(hermes, next).runtimeId!);
      expect(fresh.kind === "read" && fresh.tools.has("web_search")).toBe(false);
    });

    it("after a reconnect, the reopened chat has the profile's list as Hermes reads it", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      const user = userEvent.setup();
      const view = (c: OpenChat, connected = true) => <ToolsetSettings api={hermes.toolsets} profile="default" connected={connected} chat={c} />;
      const r = render(view(chat));
      await screen.findByText(/Read from Hermes at/);
      await within(rowOf("Web Search & Scraping")).findByText(/This chat: has it\./);
      await user.click(toggle("Web Search & Scraping"));
      await waitFor(() => expect(within(rowOf("Web Search & Scraping")).getByText(/That isn't the profile's setting/)).toBeTruthy());

      server.drop();
      await waitFor(() => expect(hermes.getSnapshot().status).not.toBe("connected"));
      r.rerender(view(openChat(hermes, chat.id), false));
      expect(screen.getByRole("status", { name: "This chat" }).textContent).toMatch(/what it has is read when Hermes is back/);
      expect(screen.queryByText(/This chat:/)).toBeNull();
      await hermes.reconnect();
      await hermes.open(chat.id);
      const reopened = openChat(hermes, chat.id);
      expect(reopened.runtimeId).not.toBe(chat.runtimeId);
      r.rerender(view(reopened));
      await waitFor(() => expect(within(rowOf("Web Search & Scraping")).getByText(/This chat: doesn't have it\./)).toBeTruthy());
      expect(within(rowOf("Web Search & Scraping")).queryByText(/That isn't the profile's setting/)).toBeNull();
    });

    it("shows a forced-on toolset in the chat apart from the profile's off", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      // What the chat's agent carries whatever the config says, such as a client surface's toolset.
      server.agentTools.get(chat.runtimeId!)!.add("image_generate");
      await mount(hermes, chat);
      const row = rowOf("Image Generation");
      expect(await within(row).findByText(/This chat: has it\. That isn't the profile's setting/)).toBeTruthy();
      expect(toggle("Image Generation").getAttribute("aria-checked")).toBe("false");
    });

    it("never takes Hermes's fallback answer for a chat it no longer has as that chat's", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      server.runtime.delete(chat.runtimeId!);
      await mount(hermes, chat);
      expect(await screen.findByText(/Hermes no longer has “.*” open: it gets the profile's list when it's opened again/)).toBeTruthy();
      expect(screen.queryByText(/This chat:/)).toBeNull();
    });

    it("says so on a server that doesn't tell what a chat has", async () => {
      const server = new FakeHermes();
      server.toolsShowMethod = false;
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      await mount(hermes, chat);
      expect(await screen.findByText(/This Hermes server doesn't say which tools an open chat has. Each toolset shows the profile's setting only/)).toBeTruthy();
      expect(screen.queryByText(/This chat:/)).toBeNull();
    });

    it("a chat not open on Hermes yet, no chat, and a running reply each say so", async () => {
      const { rerender } = await shown(undefined, { chat: { id: "c1", title: "Draft" } });
      expect(screen.getByRole("status", { name: "This chat" }).textContent).toMatch(/“Draft” isn't open on Hermes yet/);
      rerender({});
      expect(screen.getByRole("status", { name: "This chat" }).textContent).toMatch(/No chat is open/);
    });

    it("says a reply running in the open chat keeps the tools it's using", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const chat = await startedChat(hermes);
      await mount(hermes, { ...chat, running: true });
      expect(screen.getByRole("status", { name: "This chat" }).textContent).toMatch(/A reply is running in it now; nothing here changes the tools it's using/);
    });

    it("a late answer for the chat left doesn't replace the open chat's", async () => {
      const server = new FakeHermes();
      const hermes = await connect(server.openPipe, "default");
      const first = await startedChat(hermes);
      const second = await startedChat(hermes);
      server.agentTools.get(second.runtimeId!)!.delete("web_search");
      server.agentTools.get(second.runtimeId!)!.delete("web_extract");
      const answer = server.handlers["tools.show"];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      server.handlers["tools.show"] = (q) => {
        if (q.params.session_id === first.runtimeId) void gate.then(() => answer(q));
        else answer(q);
      };
      const view = (c: OpenChat) => <ToolsetSettings api={hermes.toolsets} profile="default" connected chat={c} />;
      const r = render(view(first));
      await screen.findByText(/Read from Hermes at/);
      await screen.findByText(/Reading what/);
      r.rerender(view(second));
      await within(rowOf("Web Search & Scraping")).findByText(/This chat: doesn't have it\./);
      act(() => release());
      await new Promise((res) => setTimeout(res, 20));
      expect(within(rowOf("Web Search & Scraping")).getByText(/This chat: doesn't have it\./)).toBeTruthy();
    });
  });
});
