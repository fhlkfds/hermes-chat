// @vitest-environment jsdom
// The labeled Unsettle button on a Settled chat, in the Settled drawer and in the chat's header, against a fake Hermes.
// Each test checks what reached Hermes and what the toast says, not which handler ran.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
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

/** Every `pinned` the app has written, in order. */
const pinnedWrites = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "PATCH" && r.body && "pinned" in r.body).map((r) => r.body!.pinned);
const toast = () => screen.getByRole("status");

/** Signed in with one Active chat and one Settled chat, the Settled drawer open. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("old", 5, { title: "Old notes" })];
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await act(async () => void (await hermes.idle()));
  await user.click(screen.getByRole("button", { name: /Settled/ }));
  return { server, hermes, user };
}

describe("Unsettle", () => {
  it("is labeled in words on a Settled chat in the drawer, and moves it to Active with the usual toast and Undo", async () => {
    const { server, hermes, user } = await signedIn();
    const drawer = document.querySelector<HTMLElement>(".settled-list")!;
    const unsettle = within(drawer).getByRole("button", { name: "Unsettle" });
    expect(unsettle.textContent).toBe("Unsettle");
    // Active chats keep the icon-only Settle button.
    expect(within(screen.getByRole("button", { name: /Nightly backup/ }).parentElement!).queryByRole("button", { name: "Unsettle" })).toBeNull();

    await user.click(unsettle);
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true]);
    expect(server.sessions.find((s) => s.id === "old")!.pinned).toBe(true);
    expect(toast().textContent).toContain("Moved to Active: Old notes");

    await user.click(within(toast()).getByRole("button", { name: "Undo" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true, false]);
    await waitFor(() => expect(within(drawer).getByRole("button", { name: /Old notes/ })).toBeTruthy());
  });

  it("sits beside the Settled badge in the chat's header, next to the icon toggle, and moves the chat to Active", async () => {
    const { server, hermes, user } = await signedIn();
    await user.click(screen.getByRole("button", { name: /Old notes/ }));
    await act(async () => void (await hermes.idle()));
    const title = document.querySelector<HTMLElement>(".chat-title")!;
    expect(within(title).getByText("Settled")).toBeTruthy();
    // The icon toggle stays in the header's actions.
    expect(within(document.querySelector<HTMLElement>(".chat-head-actions")!).getByTitle("Move to Active")).toBeTruthy();

    await user.click(within(title).getByRole("button", { name: "Unsettle" }));
    await act(async () => void (await hermes.idle()));
    expect(pinnedWrites(server)).toEqual([true]);
    expect(toast().textContent).toContain("Moved to Active: Old notes");
    await waitFor(() => expect(within(title).queryByText("Settled")).toBeNull());
    expect(within(title).queryByRole("button", { name: "Unsettle" })).toBeNull();
  });
});
