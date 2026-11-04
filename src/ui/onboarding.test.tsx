// @vitest-environment jsdom
// Setup, through the whole app: the Rust side is replaced by FakeHermes servers, a fake connection test and an
// in-memory keyring, so these tests see what the owner sees and what is saved on this computer.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import type { OpenPipe } from "../hermes/pipe";
import type { Probed, ProbeFailure } from "../hermes/setup";
import type { SignInDetails } from "../hermes/tauriPipe";

/** The Rust side: the servers this computer can reach, the keyring, and the connection tests run. */
const backend = vi.hoisted(() => ({
  servers: new Map<string, { server: unknown; password: string }>(),
  keyring: undefined as string | undefined,
  /** While set, a test waits until it is cancelled, like one stuck on a slow SSH host. */
  holdProbe: false,
  /** While set, the keyring can't save, as with no Secret Service running. */
  keyringBroken: false,
  probes: 0,
  cancelled: 0,
  release: undefined as (() => void) | undefined,
  /** While set, a stopped test answers only when the test releases it, as when Rust's abort lands late. */
  lateCancel: false,
}));

const where = (d: SignInDetails) => (d.mode === "ssh" ? `ssh:${d.sshTarget.trim()}` : `url:${d.url.trim()}`);

/** What Rust would answer for `d`, the way `hermes_connect` and `hermes_probe` fail. */
function reach(d: SignInDetails): { server: FakeHermes } | ProbeFailure {
  const found = backend.servers.get(where(d));
  if (!found) return { stage: "address", message: `SSH failed: ssh: Could not resolve hostname ${d.sshTarget}: Name or service not known` };
  if (d.username !== "liam" || d.password !== found.password)
    return { stage: "sign-in", message: "Wrong username or password.", status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}' };
  return { server: found.server as FakeHermes };
}

vi.mock("../hermes/tauriPipe", () => ({
  asError: (e: unknown) => Promise.reject(new Error(String(e))),
  tauriPipe:
    (d: SignInDetails): OpenPipe =>
    async (onEvent, profile) => {
      const r = reach(d);
      if ("stage" in r) throw new Error(r.message);
      return r.server.openPipe(onEvent, profile);
    },
  tauriProbe: {
    run: async (d: SignInDetails): Promise<Probed> => {
      backend.probes++;
      if (backend.holdProbe) {
        await new Promise<void>((resolve) => (backend.release = resolve));
        throw { stage: "cancelled", message: "The test was stopped." } satisfies ProbeFailure;
      }
      const r = reach(d);
      if ("stage" in r) throw r;
      return {
        route: r.server.route,
        status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
        ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: r.server.readyPayload } }),
      };
    },
    cancel: () => {
      backend.cancelled++;
      if (!backend.lateCancel) backend.release?.();
    },
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args?: { password?: string }) => {
    if (cmd === "password_load") return backend.keyring ?? null;
    if (cmd === "password_save") {
      if (backend.keyringBroken) throw "The system keyring failed: no Secret Service on the bus";
      backend.keyring = args?.password;
    }
    if (cmd === "password_delete") backend.keyring = undefined;
    if (cmd === "system_fonts") return { all: [], mono: [] };
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

// Each test types a whole setup through; with the full suite running in parallel that can pass the 5 s default.
vi.setConfig({ testTimeout: 20_000 });

const SAVED = "hermes-chat.sign-in";
let home: FakeHermes;

beforeEach(() => {
  // App keeps launch in a module variable: each test is a fresh start of the app.
  vi.resetModules();
  home = new FakeHermes();
  backend.servers.clear();
  backend.servers.set("ssh:liam@hermes", { server: home, password: "hunter2" });
  Object.assign(backend, { keyring: undefined, holdProbe: false, keyringBroken: false, probes: 0, cancelled: 0, release: undefined, lateCancel: false });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function start() {
  const { default: App } = await import("../App");
  render(<App />);
  return userEvent.setup();
}

const dialog = () => screen.queryByRole("dialog");
const savedSignIn = () => JSON.parse(localStorage.getItem(SAVED) ?? "null");
/** This computer already set up and signed in, as before setup existed. */
function alreadySetUp({ signedOut = false } = {}) {
  localStorage.setItem(SAVED, JSON.stringify({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }));
  backend.keyring = signedOut ? undefined : "hunter2";
}

async function toSignInStep(user: ReturnType<typeof userEvent.setup>, target = "liam@hermes") {
  await user.click(screen.getByRole("button", { name: "Get started" }));
  await user.type(screen.getByLabelText("SSH target"), target);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Sign in to the dashboard" });
}

describe("First run", () => {
  it("tests the connection, explains a failure, connects once it passes, and takes a provider key", async () => {
    const user = await start();
    expect(await screen.findByRole("heading", { name: "Welcome to Hermes Chat" })).toBeTruthy();
    // There is nothing to cancel to yet.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();

    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain("The dashboard turned down the username or password.");
    expect(failed.textContent).toContain("dashboard.basic_auth");
    expect(within(failed).getByText("Sign in to the dashboard").closest("li")?.className).toBe("bad");
    expect(within(failed).getByText("Reach the Hermes dashboard").closest("li")?.className).toBe("ok");
    // A failed test keeps nothing.
    expect([backend.keyring, savedSignIn()]).toEqual([undefined, null]);

    // Changing a detail clears the result; Try again tests the new one.
    await user.clear(screen.getByLabelText("Dashboard password"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toContain("Connected to Hermes 0.22.5 at ssh://liam@hermes.");
    expect(home.opened).toBe(0);
    expect(backend.keyring).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByRole("heading", { name: "Model providers" })).toBeTruthy();
    expect(backend.keyring).toBe("hunter2");
    expect(savedSignIn()).toEqual({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
    expect(home.opened).toBe(1);
    // Saved, so there is nothing left to cancel.
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();

    expect(await screen.findByText(/Hermes can already use Anthropic, OpenAI/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
    await user.type(screen.getByLabelText("API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not saved: The provider turned the key down. Check that you copied all of it, and that it's for this provider.");
    expect(home.savedKeys).toEqual([]);

    await user.clear(screen.getByLabelText("API key"));
    await user.type(screen.getByLabelText("API key"), "sk-ant-good");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect((await screen.findByText("Saved. Anthropic accepted the key.")).getAttribute("role")).toBe("status");
    expect(home.savedKeys).toEqual([{ profile: "default", envVar: "ANTHROPIC_API_KEY", key: "sk-ant-good" }]);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    // The key never touches this computer's storage.
    expect(JSON.stringify(localStorage)).not.toContain("sk-ant-good");

    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
  });

  it("starts over on Cancel, forgetting the password typed", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Cancel and start over" }));
    expect(await screen.findByRole("heading", { name: "Welcome to Hermes Chat" })).toBeTruthy();

    await toSignInStep(user);
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).value).toBe("");
    expect(backend.keyring).toBeUndefined();
  });

  it("explains an SSH host that can't be found", async () => {
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user, "liam@hermse");
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain('This computer couldn\'t find the host "hermse".');
    expect(failed.textContent).toContain("~/.ssh/config");
    expect(within(failed).getByText("Open an SSH tunnel to the server").closest("li")?.className).toBe("bad");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says in setup when the keyring couldn't keep the password", async () => {
    backend.keyringBroken = true;
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect(screen.getByText(/You'll type the password again at the next launch/).textContent?.trim()).toBe(
      "Connected. Couldn't save the password in the system keyring: The system keyring failed: no Secret Service on the bus. You'll type the password again at the next launch.",
    );
    expect(backend.keyring).toBeUndefined();
  });

  it("stops a test that's taking long", async () => {
    backend.holdProbe = true;
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Testing the connection…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);

    // The details can't change under a test.
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole("button", { name: "Stop test" }));
    expect(backend.cancelled).toBe(1);
    expect((screen.getByLabelText("Dashboard password") as HTMLInputElement).readOnly).toBe(false);
    await act(async () => {});
    expect(screen.queryByText("Testing the connection…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the next test's result when a stopped test answers late", async () => {
    Object.assign(backend, { holdProbe: true, lateCancel: true });
    const user = await start();
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Testing the connection…");
    await user.click(screen.getByRole("button", { name: "Stop test" }));
    const stopped = backend.release!;

    backend.holdProbe = false;
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("status")).textContent).toContain("Connected to Hermes");
    await act(async () => stopped());
    expect(screen.getByRole("status").textContent).toContain("Connected to Hermes");
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeTruthy();
  });
});

describe("An install set up before", () => {
  it("signs in with the saved password and never shows setup", async () => {
    alreadySetUp();
    await start();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(backend.probes).toBe(0);
  });

  it("signed out, gets the sign-in screen, which can open setup and cancel back", async () => {
    alreadySetUp({ signedOut: true });
    const user = await start();
    expect(await screen.findByRole("heading", { name: "Connect to Hermes" })).toBeTruthy();
    expect(dialog()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Set up a different server…" }));
    expect(await screen.findByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Connect to Hermes" })).toBeTruthy();
    expect(dialog()).toBeNull();
  });
});

describe("Setup from Settings", () => {
  async function openSetup() {
    alreadySetUp();
    const user = await start();
    await screen.findByText("New chat", { selector: ".chat-title span" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    expect(await screen.findByRole("heading", { name: "Set up Hermes Chat" })).toBeTruthy();
    return user;
  }

  it("leaves the connection as it was on Cancel, or on Escape", async () => {
    const user = await openSetup();
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(true);
    // The app's shortcuts wait while setup covers it.
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByPlaceholderText("Search all chats, including Settled")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // Focus goes back to the button that opened setup.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run setup again" }));
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();
    expect([home.opened, home.closed, backend.keyring]).toEqual([1, false, "hunter2"]);
  });

  it("tests a new server while the old connection carries on, then switches to it", async () => {
    const studio = new FakeHermes();
    studio.route = { kind: "url", url: "http://studio.example.com:9119", addresses: ["203.0.113.9"] };
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await openSetup();

    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Dashboard username") as HTMLInputElement).value).toBe("liam");
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const passed = await screen.findByRole("status");
    expect(passed.textContent).toContain("Connected to Hermes 0.22.5 at http://studio.example.com:9119.");
    expect(passed.textContent).toContain("Unsecure");
    // The test didn't touch the connection in use.
    expect([home.closed, studio.opened, backend.keyring]).toEqual([false, 0, "hunter2"]);

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("heading", { name: "Model providers" });
    expect([home.closed, studio.opened, backend.keyring]).toEqual([true, 1, "pa55"]);
    expect(savedSignIn()).toEqual({ mode: "url", sshTarget: "liam@hermes", url: "http://studio.example.com:9119", username: "liam" });

    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(dialog()).toBeNull();
    expect(await screen.findByText("New chat", { selector: ".chat-title span" })).toBeTruthy();
  });

  it("puts the old connection back if the new one fails after its test", async () => {
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await openSetup();
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("status");

    studio.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The test passed, but connecting failed: Can't reach the Hermes dashboard: connection reset",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(home.opened).toBe(2));
    expect([backend.keyring, savedSignIn().mode]).toEqual(["hunter2", "ssh"]);
    // Back under setup, the chats wait: none is opened, or read, while setup covers them.
    await waitFor(() => expect(document.querySelector(".panes")).toBeTruthy());
    expect(document.querySelector(".panes")?.hasAttribute("inert")).toBe(true);

    // Cancel goes back to the old server, connected again.
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(dialog()).toBeNull();
    expect(home.closed).toBe(false);
    expect(document.querySelector(".panes")?.hasAttribute("inert")).toBe(false);
  });

  it("puts the old connection back even when the keyring couldn't keep its password", async () => {
    backend.keyringBroken = true;
    const studio = new FakeHermes();
    backend.servers.set("url:http://studio.example.com:9119", { server: studio, password: "pa55" });
    const user = await start();
    // First run: connected, but the password is only in memory.
    await screen.findByRole("heading", { name: "Welcome to Hermes Chat" });
    await toSignInStep(user);
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(await screen.findByRole("button", { name: "Finish" }));
    expect(backend.keyring).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Run setup again" }));
    await user.click(await screen.findByRole("button", { name: "Change connection" }));
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText("Dashboard URL"), "http://studio.example.com:9119");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "pa55");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected to Hermes/);
    studio.refuse = "Can't reach the Hermes dashboard: connection reset";
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText(/The test passed, but connecting failed/);
    await waitFor(() => expect(home.opened).toBe(2));

    await user.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(home.closed).toBe(false);
    expect(screen.queryByRole("heading", { name: "Connect to Hermes" })).toBeNull();
  });

  it("adds a provider key without touching the connection", async () => {
    const user = await openSetup();
    await user.click(screen.getByRole("button", { name: "Add a provider key" }));
    await screen.findByRole("heading", { name: "Model providers" });
    await user.selectOptions(await screen.findByLabelText("Provider"), "deepseek");
    await user.type(screen.getByLabelText("API key"), "sk-offline");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    expect(
      (await screen.findByText("Saved, but Hermes couldn't check the key with DeepSeek. If it's wrong, DeepSeek will turn down Hermes's first request.")).getAttribute("role"),
    ).toBe("status");
    expect(home.savedKeys).toEqual([{ profile: "default", envVar: "DEEPSEEK_API_KEY", key: "sk-offline" }]);
    // Done never waits on Hermes: here it stops answering after the save.
    home.rest["GET /api/env"] = () => new Promise(() => {});
    await user.type(screen.getByLabelText("API key"), "sk-good-2");
    await user.click(screen.getByRole("button", { name: "Check and save key" }));
    await screen.findByText(/Saved\. DeepSeek accepted the key\./);
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(dialog()).toBeNull();
    expect([home.opened, home.closed]).toEqual([1, false]);
  });
});
