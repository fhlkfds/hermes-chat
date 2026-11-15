// @vitest-environment jsdom
// Set a goal and the goal bar on screen (issue #603, ADR 0178): the check is shown exactly, with what it can do, before
// anything is saved; the bar follows the goal to done or to a pause and says why; /goal opens the dialog; and none of
// it shows where a quick command takes /goal.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

async function launch(more?: (s: FakeHermes) => void) {
  const s = new FakeHermes();
  s.sessions = [row("c1", 0.1, { pinned: true, title: "Release 2.4" })];
  s.storeMessage("c1", { role: "user", text: "Get 2.4 out" });
  s.storeMessage("c1", { role: "assistant", text: "Starting on it." });
  more?.(s);
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(() => hermes.capabilities.refresh());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Release 2.4/ }));
  await screen.findByText("Starting on it.");
  await act(async () => void (await hermes.idle()));
  const runtime = () => s.runtimeIdOf("c1")!;
  /** Ends a turn as Hermes does, judged once it's complete. */
  const turn = async () => {
    await act(async () => {
      s.event(runtime(), "message.start");
      s.event(runtime(), "message.complete", { text: "A step.", status: "complete" });
      await new Promise((r) => setTimeout(r, 5));
      await hermes.idle();
    });
  };
  return { s, hermes, user, turn };
}

const bar = () => screen.getByRole("region", { name: "Goal" });

describe("Set a goal", () => {
  it("shows the exact check and what it may do before saving, then the bar follows the goal to done", async () => {
    const { s, user, turn } = await launch();
    await user.click(await screen.findByRole("button", { name: "Set a goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Set a goal" });
    await within(dialog).findByText("20 turns");
    await user.type(within(dialog).getByRole("textbox", { name: /Outcome/ }), "Release 2.4 is on the stable channel");
    await user.type(within(dialog).getByRole("textbox", { name: /What must not change/ }), "The public API");
    await user.type(within(dialog).getByRole("textbox", { name: /Check that proves it done/ }), "npm test");
    expect(dialog.textContent).toContain("A goal moves only while its chat is live on the server.");
    expect(s.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Review" }));

    const review = screen.getByRole("dialog", { name: "Check before saving" });
    expect(within(review).getByText("$ npm test")).toBeTruthy();
    expect(review.querySelector("pre")?.textContent).toBe("Release 2.4 is on the stable channel\nmust not: The public API");
    expect(review.textContent).toContain("runs on the server as the user Hermes runs as, with no approval");
    expect(review.textContent).toContain("for up to 300 seconds each time");
    expect(review.textContent).toContain("at most 3 times; the next failure pauses the goal");
    expect(review.textContent).toContain("after a server restart, until you open the chat");
    expect(s.requests.some((r) => r.method === "command.dispatch")).toBe(false);
    await user.click(within(review).getByRole("button", { name: "Set goal and run this check" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bar().textContent).toContain("Release 2.4 is on the stable channel");
    expect(bar().textContent).toContain("Running");
    expect(bar().textContent).toContain("Turn 0 of 20");
    expect(bar().textContent).toContain("Checks not run yet");

    await turn();
    await waitFor(() => expect(bar().textContent).toContain("Done"));
    await user.click(within(bar()).getByRole("button", { name: /Release 2.4 is on the stable channel/ }));
    expect(bar().textContent).toContain("Must not changeThe public API");
    expect(bar().textContent).toContain("$ npm test Passed");
    expect(bar().textContent).toContain("The stand-in judge saw the outcome.");
  });

  it("keeps running on a failing check until the fourth failure pauses it, and says why", async () => {
    const { s, hermes, user, turn } = await launch();
    await act(() => hermes.setGoal("c1", { outcome: "Green CI", mustNot: "", check: "npm test || false" }, ""));
    for (const n of [1, 2, 3]) {
      await turn();
      await waitFor(() => expect(bar().textContent).toContain(`Turn ${n} of 20`));
      expect(bar().textContent).toContain("Running");
    }
    await turn();
    await waitFor(() => expect(bar().textContent).toContain("Paused"));
    expect(bar().textContent).toContain("Hermes paused it: quality gate exhausted 3 retries: $ npm test || false");
    await user.click(within(bar()).getByRole("button", { name: /Green CI/ }));
    expect(bar().textContent).toContain("Failed with exit code 1 · 4 in a row, pauses at 4");

    // Resume sends the turn Hermes asks for, which starts it again.
    await user.click(within(bar()).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(bar().textContent).toContain("Running"));
    expect(s.last("session.control")?.params).toMatchObject({ action: "goal.resume" });
    expect(s.last("prompt.submit")?.params.text).toBe("[Continuing toward your standing goal] Green CI");

    await user.click(within(bar()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal" })).toBeNull());
  });

  it("can't be saved once a reply starts, and says why", async () => {
    const { s, user } = await launch();
    await user.click(await screen.findByRole("button", { name: "Set a goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Set a goal" });
    await within(dialog).findByText("20 turns");
    await user.type(within(dialog).getByRole("textbox", { name: /Outcome/ }), "Green CI");
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    act(() => s.event(s.runtimeIdOf("c1")!, "message.start"));
    const review = screen.getByRole("dialog", { name: "Check before saving" });
    await waitFor(() => expect((within(review).getByRole("button", { name: "Set goal" }) as HTMLButtonElement).disabled).toBe(true));
    expect(review.textContent).toContain("A reply is running. Set the goal once it ends.");
    expect(s.requests.some((r) => r.method === "command.dispatch")).toBe(false);
  });

  it("opens from /goal with the outcome typed, and sends nothing until saved", async () => {
    const { s, user } = await launch();
    const composer = screen.getByPlaceholderText("Message Hermes");
    await user.type(composer, "/goal Ship it");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Set a goal" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: /Outcome/ }) as HTMLInputElement).value).toBe("Ship it"));
    expect(s.requests.some((r) => r.method === "command.dispatch")).toBe(false);
  });

  it("doesn't show where a quick command takes /goal", async () => {
    await launch((s) => (s.quickCommands = { goal: "exec: ./ship.sh" }));
    expect(screen.queryByRole("button", { name: "Set a goal" })).toBeNull();
  });
});
