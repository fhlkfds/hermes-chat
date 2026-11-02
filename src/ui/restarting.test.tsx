// @vitest-environment jsdom
// Restarting into an update: the drafts were saved when it began, so the window takes no more typing until it goes.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { Updater, UpdateState } from "../hermes/updates";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

let hermes: Hermes | undefined;
afterEach(async () => {
  cleanup();
  await hermes?.close();
  localStorage.clear();
});

it("makes the window inert, and says so, while it restarts", async () => {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { title: "Nightly backup" })];
  hermes = await connect(s.openPipe);
  let state: UpdateState = { state: "restart", from: "r1.ef433a2-1", to: "r2.4444444-1" };
  const listeners = new Set<() => void>();
  const updates: Updater = {
    getSnapshot: () => state,
    subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    check: async () => {},
    install: async () => {},
    restart: async () => {},
  };
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} updates={updates} />);
  await waitFor(() => expect(hermes!.hasListed()).toBe(true));
  const app = document.querySelector(".app")!;
  expect(app.hasAttribute("inert")).toBe(false);
  expect(screen.getByTitle(/an update is ready/)).toBeTruthy();

  act(() => {
    state = { state: "restarting", from: "r1.ef433a2-1", to: "r2.4444444-1" };
    listeners.forEach((fn) => fn());
  });
  expect(app.hasAttribute("inert")).toBe(true);
  const overlay = screen.getByRole("status");
  expect(overlay.textContent).toBe("Restarting into r2.4444444-1…");
  expect(app.contains(overlay)).toBe(false);
});
