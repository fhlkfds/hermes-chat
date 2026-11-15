// @vitest-environment jsdom
// A Returned result (ADR 0175): the work a chat handed off, shown as a card on Hermes's side of the transcript, open
// from the start, rather than as the notice Hermes stored in a bubble that looks like the owner's.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

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

it("shows returned work as an open card on Hermes's side, closed and opened again by its header", async () => {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.transcripts = {
    backup: [
      { role: "user", text: "Audit the backups in the background" },
      {
        role: "user",
        text: "[ASYNC DELEGATION COMPLETE — deleg_1]\nGoal: audit backups\n--- RESULT ---\nBackups fail because the share is **read-only**.",
        display_kind: "async_delegation_complete",
        display_metadata: { display_text: "Subagent Task Completed: audit backups" },
      },
      { role: "user", text: "[IMPORTANT: Background process proc_1 completed.\nOutput:\nhello-from-proc]", display_kind: "process_complete" },
      { role: "assistant", text: "The share went read-only." },
    ],
  };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /^Nightly backup/ }));
  await act(async () => void (await hermes.idle()));

  const [work, proc] = Array.from(document.querySelectorAll<HTMLElement>(".msg.returned"));
  expect(work.matches(".msg.user")).toBe(false);
  expect(Array.from(document.querySelectorAll(".msg.user")).map((m) => m.textContent)).toEqual([expect.stringContaining("Audit the backups")]);
  expect(document.body.textContent).not.toContain("ASYNC DELEGATION");

  const head = screen.getByRole("button", { name: "Subagent Task Completed: audit backups" });
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(work.querySelector(".returned-body strong")?.textContent).toBe("read-only");
  expect(work.textContent).toContain("Backups fail because the share is read-only.");

  expect(proc.querySelector(".returned-title")?.textContent).toBe("Background process finished");
  expect(proc.querySelector("pre.returned-log")?.textContent).toContain("hello-from-proc");

  await user.click(head);
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(work.querySelector(".returned-body")).toBeNull();
  await user.click(head);
  expect(work.textContent).toContain("Backups fail because the share is read-only.");
});
