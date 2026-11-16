// @vitest-environment jsdom
// Search's Everywhere scope in the whole App (issue #608), over the Rust stand-in the live-connections test uses
// (liveRust.ts). Three servers are live: Alpha, the composer target, with three profiles, one of them holding as many
// matching chats as Hermes gives; Bravo in the background; and Charlie, a Hermes with no chat search. The tests read
// what the owner sees (rows, notes, the chat that opens and where find-in-chat lands) and count the dashboard
// requests the app has in flight at once.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { RestError, type PipeEvent } from "../hermes/pipe";
import { liveRust } from "./liveRust";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const ALPHA = "https://alpha.example.com";
const BRAVO = "https://bravo.example.com";
const CHARLIE = "https://charlie.example.com";
const servers: Record<string, FakeHermes> = { [ALPHA]: new FakeHermes(), [BRAVO]: new FakeHermes(), [CHARLIE]: new FakeHermes() };
const passwords: Record<string, string> = { [ALPHA]: "alpha-pass", [BRAVO]: "bravo-pass", [CHARLIE]: "charlie-pass" };
const rust = liveRust(servers, passwords);

/**
 * The dashboard requests in flight through Rust's relay, and the most at once. While `slow`, each takes a moment to
 * answer, as over a network, so requests sent side by side are in flight together.
 */
const flight = { now: 0, most: 0, slow: false };

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: PipeEvent) => void;
  },
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== "hermes_request") return rust.invoke(cmd, args);
    flight.most = Math.max(flight.most, ++flight.now);
    try {
      if (flight.slow) await new Promise((r) => setTimeout(r, 25));
      return await rust.invoke(cmd, args);
    } finally {
      flight.now--;
    }
  },
}));

const WORDS = "backup failed";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  localStorage.setItem("hermes-chat.sign-in", JSON.stringify({ mode: "url", sshTarget: "", url: CHARLIE, username: "owner" }));
  rust.keyring.set("password:legacy", "charlie-pass");

  // In each chat the first message holds one of the words and a later one holds both: the search matches the later one.
  const alpha = servers[ALPHA];
  alpha.sessions = [row("a-night", 1, { pinned: true, title: "Nightly backup", model: "claude-opus-5-5" })];
  alpha.transcripts["a-night"] = [
    { role: "assistant", text: "The backup ran fine on Monday." },
    { role: "user", text: "Why has the backup failed tonight?" },
  ];
  alpha.otherProfiles.work = [row("w-deploy", 2, { pinned: true, title: "Deploy backup", model: "gpt-6.1" })];
  alpha.transcripts["w-deploy"] = [
    { role: "user", text: "Is the backup script ready?" },
    { role: "assistant", text: "The deploy of the backup failed twice." },
  ];
  // As many chats as Hermes's search gives for one profile.
  alpha.otherProfiles.ops = Array.from({ length: 100 }, (_, i) => row(`o-${i}`, 3, { title: `Backup failed, run ${i}` }));

  const bravo = servers[BRAVO];
  bravo.sessions = [row("b-nas", 1, { pinned: true, title: "NAS backup", model: "claude-sonnet-5-5" })];
  bravo.transcripts["b-nas"] = [
    { role: "user", text: "Start the backup now." },
    { role: "user", text: "The NAS backup failed again." },
  ];

  const charlie = servers[CHARLIE];
  charlie.sessions = [row("c-old", 1, { pinned: true, title: "Charlie backup" })];
  charlie.transcripts["c-old"] = [{ role: "user", text: "The backup failed here too." }];
  charlie.rest["GET /api/sessions/search"] = () => {
    throw new RestError(404, '{"detail":"Not Found"}');
  };
});
afterAll(cleanup);

const openRail = async () => userEvent.click(await screen.findByRole("button", { name: /Switch connection/ }));

async function addServer(name: string, url: string) {
  await openRail();
  await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
  await userEvent.type(screen.getByLabelText("Name"), name);
  await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
  await userEvent.type(screen.getByLabelText(/^Dashboard URL/), url);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
  await userEvent.type(screen.getByLabelText(/^Dashboard password/), passwords[url]);
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
  await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
}

const palette = () => screen.getByRole("dialog", { name: "Search chats" });
const words = () => within(palette()).getByLabelText<HTMLInputElement>("Words to search for");
/** Each row as the owner reads it: the chat, then its server and bot. */
const rows = () => [...palette().querySelectorAll(".hit-row")].map((r) => [r.querySelector(".hit-name")?.textContent, r.querySelector(".hit-where")?.textContent?.replace(/^On /, "")]);
const notes = () => within(palette()).queryAllByRole("note").map((n) => n.textContent ?? "");
const searched = () => waitFor(() => expect(palette().querySelector(".spinner")).toBeNull(), { timeout: 10_000 });
const quiet = () => waitFor(() => expect(flight.now).toBe(0));

/** Opens the palette on Everywhere with the words typed, and waits for every server's answer. */
async function searchEverywhere() {
  await userEvent.keyboard("{Control>}k{/Control}");
  await userEvent.click(within(palette()).getByRole("button", { name: "Everywhere" }));
  await userEvent.type(words(), WORDS);
  await waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 10_000 });
  await searched();
}

/** Where the chat on screen is, the words find-in-chat holds, and the message its current match is in. */
const landed = async (badge: string, message: string) => {
  expect(await screen.findByText(badge, {}, { timeout: 10_000 })).toBeTruthy();
  await waitFor(() => expect(screen.getByPlaceholderText<HTMLInputElement>("Find in chat").value).toBe("backup"), { timeout: 10_000 });
  await waitFor(() => expect(document.querySelector("mark.current")?.closest("[data-item]")?.textContent).toContain(message));
};

describe("Search's Everywhere scope", () => {
  it("lists chats from every bot on both servers, never with more than four requests in flight, and says what it left out", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    expect(await screen.findByText("Charlie backup", {}, { timeout: 15_000 })).toBeTruthy();
    await addServer("Bravo", BRAVO);
    expect(await screen.findByText("NAS backup")).toBeTruthy();
    await addServer("Alpha", ALPHA);
    expect(await screen.findByText("Nightly backup")).toBeTruthy();
    expect(rust.connects.map((c) => c.url)).toEqual([CHARLIE, BRAVO, ALPHA]);
    // Each connection checks what its Hermes can do a moment after it opens, outside any search.
    await act(async () => new Promise((r) => setTimeout(r, 2_600)));
    await quiet();

    flight.most = 0;
    flight.slow = true;
    await searchEverywhere();
    flight.slow = false;

    expect(flight.most).toBe(4);
    const found = rows();
    expect(found.slice(0, 2)).toEqual([
      ["Nightly backup", "Alpha · default"],
      ["Deploy backup", "Alpha · work"],
    ]);
    expect(found.filter(([, where]) => where === "Alpha · ops")).toHaveLength(100);
    expect(found.at(-1)).toEqual(["NAS backup", "Bravo · default"]);
    expect(found).toHaveLength(103);
    expect(found.some(([title]) => title === "Charlie backup")).toBe(false);

    expect(notes().some((n) => /at most 100 chats per bot\. ops on Alpha hit that, so more chats may match there/.test(n))).toBe(true);
    expect(notes().some((n) => /^charlie\.example\.com wasn't searched, so none of its bots is here\. Hermes has no such route/.test(n))).toBe(true);
    // Charlie was asked once at most before the app knew, and its other requests were never sent.
    expect(servers[CHARLIE].restRequests.filter((r) => r.path === "/api/sessions/search" && r.query.get("q")).length).toBeLessThanOrEqual(1);
  }, 120_000);

  it("offers the filters that mean something across bots, and says the model and dates are checked after Hermes's 100", async () => {
    await userEvent.click(within(palette()).getByRole("button", { name: /^Filters/ }));
    const bar = () => within(within(palette()).getByRole("group", { name: "Filters" }));
    for (const label of ["Bot", "Model", "Active from", "Until"]) expect(bar().getByLabelText(label)).toBeTruthy();
    for (const label of ["Tag", "Source", "State"]) expect(bar().queryByLabelText(label)).toBeNull();
    expect(within(palette()).queryByRole("button", { name: /Save filter/ })).toBeNull();
    expect(within(palette()).queryByRole("button", { name: /^Tag \d+ results?/ })).toBeNull();
    expect(within(palette()).queryByRole("button", { name: /Manage tags/ })).toBeNull();

    const before = servers[ALPHA].restRequests.length;
    await userEvent.type(bar().getByLabelText("Bot"), "wor");
    await waitFor(() => expect(rows()).toEqual([["Deploy backup", "Alpha · work"]]), { timeout: 10_000 });
    await searched();
    expect(new Set(servers[ALPHA].restRequests.slice(before).filter((r) => r.path === "/api/sessions/search" && r.query.get("q") === WORDS).map((r) => r.query.get("profile")))).toEqual(new Set(["work"]));
    await userEvent.click(within(palette()).getByRole("button", { name: "Remove filter Bot: wor" }));

    await userEvent.type(bar().getByLabelText("Model"), "opus");
    await waitFor(() => expect(rows()).toEqual([["Nightly backup", "Alpha · default"]]), { timeout: 10_000 });
    expect(notes().some((n) => /The model and the dates are checked here, after Hermes has picked its best 100 chats for each bot/.test(n))).toBe(true);
    // The 100 chats in ops have no model recorded.
    expect(notes().some((n) => /didn't record a model for 100 chats/.test(n))).toBe(true);

    await userEvent.click(within(palette()).getByRole("button", { name: "This profile" }));
    expect(words().value).toBe(WORDS);
    for (const label of ["Tag", "Source", "State", "Model"]) expect(bar().getByLabelText(label)).toBeTruthy();
    expect(bar().queryByLabelText("Bot")).toBeNull();
    expect(await within(palette()).findByRole("button", { name: /Save filter/ })).toBeTruthy();
    await waitFor(() => expect(rows()).toEqual([["Nightly backup", undefined]]));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  }, 60_000);

  it("opens a hit at the words it matched: in the profile on screen, in another profile, and on a background connection", async () => {
    const row$ = (title: string) => [...palette().querySelectorAll<HTMLElement>(".hit-row")].find((r) => r.querySelector(".hit-name")?.textContent === title)!;

    await searchEverywhere();
    await userEvent.click(row$("Nightly backup"));
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
    await landed("Alpha · default", "Why has the backup failed tonight?");

    await searchEverywhere();
    await userEvent.click(row$("Deploy backup"));
    await landed("Alpha · work", "The deploy of the backup failed twice.");

    // Bravo becomes the composer target with the connection it already has: nothing signs in again.
    await searchEverywhere();
    const signIns = rust.connects.map((c) => c.url);
    await userEvent.click(row$("NAS backup"));
    await landed("Bravo · default", "The NAS backup failed again.");
    expect(rust.connects.map((c) => c.url)).toEqual(signIns);
    expect([...rust.held.values()].map((h) => h.url).sort()).toEqual([ALPHA, BRAVO, CHARLIE]);
  }, 120_000);
});
