// @vitest-environment jsdom
// Setup's providers step on its own: answers that arrive for a connection or profile the step no longer shows are
// dropped, so a late list or save result never lands on the wrong server.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes, fakeEnv } from "../hermes/fakeHermes";
import type { Probe } from "../hermes/setup";
import { connect } from "../hermes/transport";
import { Onboarding, withoutKey } from "./Onboarding";

afterEach(cleanup);

const probe: Probe = { run: () => new Promise(() => {}), cancel: () => {} };
const initial = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam", password: "", headers: [] };

/** A server whose `GET /api/env` answers only when let through, with only `providers`' keys. */
function heldServer(providers: string[]) {
  const server = new FakeHermes();
  const env = Object.fromEntries(Object.entries(fakeEnv()).filter(([, row]) => providers.includes(String(row.provider))));
  let letThrough: (() => void) | undefined;
  server.rest["GET /api/env"] = () => new Promise((resolve) => (letThrough = () => resolve(env)));
  return { server, release: () => letThrough?.() };
}

function setup(hermes: Parameters<typeof Onboarding>[0]["hermes"]) {
  return (
    <Onboarding mode="reconfigure" initial={initial} probe={probe} hermes={hermes} onConnect={async () => ({})} onCancel={() => {}} onDone={() => {}} />
  );
}

describe("The providers step", () => {
  it("drops a provider list that arrives for the connection it showed before", async () => {
    const a = heldServer(["deepseek"]);
    const b = heldServer(["anthropic"]);
    const ha = await connect(a.server.openPipe);
    const hb = await connect(b.server.openPipe);
    const user = userEvent.setup();
    const { rerender } = render(setup(ha));
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByText("Asking Hermes…");
    const asked = (f: FakeHermes) => waitFor(() => expect(f.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    await asked(a.server);

    // The connection changes under the step (put back after a failed switch, say), then the old answer comes.
    rerender(setup(hb));
    await asked(b.server);
    await act(async () => b.release());
    expect(await screen.findByRole("option", { name: "Anthropic" })).toBeTruthy();
    await act(async () => a.release());
    expect(screen.queryByRole("option", { name: "DeepSeek" })).toBeNull();
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeTruthy();
    await ha.close();
    await hb.close();
  });

  it("reads again for the profile shown, dropping the answer for the one before", async () => {
    const { server, release } = heldServer(["deepseek"]);
    server.otherProfiles.work = [];
    const hermes = await connect(server.openPipe);
    const user = userEvent.setup();
    render(setup(hermes));
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByText("Asking Hermes…");
    await waitFor(() => expect(server.restRequests.some((r) => r.path === "/api/env")).toBe(true));
    const firstRelease = release;
    // A new list for "work" is asked for, and answers.
    const env = Object.fromEntries(Object.entries(fakeEnv()).filter(([, row]) => row.provider === "anthropic"));
    server.rest["GET /api/env"] = () => env;
    await act(async () => hermes.switchProfile("work"));
    expect(await screen.findByRole("option", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByText(/work/, { selector: ".mono" })).toBeTruthy();
    // The default profile's late answer changes nothing.
    await act(async () => firstRelease());
    expect(screen.queryByRole("option", { name: "DeepSeek" })).toBeNull();
    await hermes.close();
  });
});

describe("Error text after a key", () => {
  it("is shown only when it repeats no 8 characters of the key", () => {
    const key = "sk-or-v1-0123456789abcdef";
    expect(withoutKey("The provider turned the key down.", key)).toBe("The provider turned the key down.");
    expect(withoutKey(`bad key ${key}`, key)).toMatch(/isn't shown/);
    expect(withoutKey("bad key …456789ab…", key)).toMatch(/isn't shown/);
    expect(withoutKey("bad key …456789a…", key)).toBe("bad key …456789a…");
    // A key shorter than 8 characters counts in full.
    expect(withoutKey("rejected: abc12", "abc12")).toMatch(/isn't shown/);
    expect(withoutKey("rejected", "  ")).toBe("rejected");
  });
});
