// @vitest-environment jsdom
// Settings → Gateways on screen (GatewaySettings.tsx, ADR 0069), against the fake dashboard's messaging routes
// (fakeGateways.ts): the sub-nav of platforms, the state, token rows that keep, replace or remove, the switch, Save with
// its read back, a change on the server meanwhile, Check status, the three problems in their own words, and answers for
// another profile dropped. Every token here is synthetic.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { GatewaySettings } from "./GatewaySettings";
import { SettingsScreen } from "./Settings";

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

const TOKEN = "123456789:AAAAdummydummydummydummydummydummy00";
const NEW_TOKEN = "987654321:BBBBnewnewnewnewnewnewnewnewnewnew11";

function server() {
  const s = new FakeHermes();
  s.otherProfiles = { bot: [] };
  s.gateways.env.default = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: "111" };
  s.gateways.enabled.default = { telegram: true };
  return s;
}

async function shown({ s = server(), profile = "default" } = {}) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <GatewaySettings api={hermes.gateways} profile={profile} connected openUrl={vi.fn()} />
    </StrictMode>,
  );
  await screen.findByRole("navigation", { name: "Gateways" });
  return { s, hermes, user, view };
}

const rowOf = (name: string) => screen.getByText(name, { selector: ".set-name, .set-name *" }).closest(".set-row") as HTMLElement;
const save = () => screen.getByRole("button", { name: "Save" });

describe("Settings → Gateways", () => {
  it("shows Telegram and Discord in a sub-nav, each with its state and the token's preview, never the token", async () => {
    const { user, view } = await shown();
    const nav = screen.getByRole("navigation", { name: "Gateways" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Telegram", "Discord"]);
    expect(screen.getByRole("heading", { name: "Telegram" })).toBeTruthy();
    expect(within(rowOf("Status")).getByText("Gateway stopped")).toBeTruthy();
    expect(screen.getByText("hermes -p default gateway start")).toBeTruthy();
    expect(within(rowOf("Telegram bot token")).getByText("«redacted:1234...my00»")).toBeTruthy();
    expect((screen.getByLabelText("Allowed Telegram user IDs (comma-separated)") as HTMLInputElement).value).toBe("111");
    expect(view.container.innerHTML).not.toContain(TOKEN);
    await user.click(within(nav).getByRole("button", { name: "Discord" }));
    expect(screen.getByRole("heading", { name: "Discord" })).toBeTruthy();
    expect(within(rowOf("Status")).getByText("Off")).toBeTruthy();
    expect(within(rowOf("Discord bot token")).getByText("Not set.")).toBeTruthy();
  });

  it("saves the switch alone without touching the token, and says Hermes reads it back", async () => {
    const { s, user } = await shown();
    expect(save()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("switch", { name: "Turned on" }));
    await user.click(save());
    await screen.findByText("Saved, and Hermes reads it back that way.");
    expect(s.gateways.writes.at(-1)?.body).toEqual({ enabled: false });
    expect(s.gateways.env.default.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    expect(within(rowOf("Status")).getByText("Off")).toBeTruthy();
  });

  it("replaces a token from a masked field, clears what was typed, and leaves an emptied field as a keep", async () => {
    const { s, user, view } = await shown();
    await user.click(screen.getByRole("button", { name: "Replace Telegram bot token" }));
    const field = screen.getByLabelText("Telegram bot token") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
    // Nothing typed is no change.
    expect(save()).toHaveProperty("disabled", true);
    await user.click(field);
    await user.paste(NEW_TOKEN);
    await user.click(save());
    await screen.findByText("Saved, and Hermes reads it back that way.");
    expect(s.gateways.env.default.TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    expect(screen.queryByLabelText("Telegram bot token")).toBeNull();
    expect(within(rowOf("Telegram bot token")).getByText("«redacted:9876...ew11»")).toBeTruthy();
    expect(view.container.innerHTML).not.toContain(NEW_TOKEN);
  });

  it("removes a token only on Save, and Keep current undoes it", async () => {
    const { s, user } = await shown();
    await user.click(screen.getByRole("button", { name: "Remove Telegram bot token" }));
    expect(within(rowOf("Telegram bot token")).getByText(/Removed on Save. Without it, Telegram can't connect./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep Telegram bot token as it is" }));
    expect(save()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Remove Telegram bot token" }));
    await user.click(save());
    await screen.findByText("Saved, and Hermes reads it back that way.");
    expect(s.gateways.env.default.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(within(rowOf("Telegram bot token")).getByText("Not set.")).toBeTruthy();
  });

  it("sends nothing when the platform changed on the server, and shows what Hermes has now", async () => {
    const { s, user } = await shown();
    s.gateways.env.default.TELEGRAM_BOT_TOKEN = NEW_TOKEN;
    await user.click(screen.getByRole("switch", { name: "Turned on" }));
    await user.click(save());
    await screen.findByText(/Not saved: Telegram changed on the server since this screen read it/);
    expect(s.gateways.writes).toEqual([]);
    expect(within(rowOf("Telegram bot token")).getByText("«redacted:9876...ew11»")).toBeTruthy();
    // The switch the owner flipped is kept, to save again.
    expect(screen.getByRole("switch", { name: "Turned on" }).getAttribute("aria-checked")).toBe("false");
  });

  it("tells a refused permission, a turned-down token and a missing library apart", async () => {
    const s = server();
    s.gateways.gateway.default = { running: true, platforms: { telegram: { state: "fatal", error_code: "missing_dependency", error_message: "python-telegram-bot not installed" } } };
    const { user } = await shown({ s });
    const status = rowOf("Status");
    expect(within(status).getByText("Missing on the server:")).toBeTruthy();
    expect(within(status).getByText(/install Hermes's "telegram" extra there/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Replace Telegram bot token" }));
    await user.click(screen.getByLabelText("Telegram bot token"));
    await user.paste("not-a-token");
    await user.click(save());
    const alert = await within(rowOf("Save")).findByRole("alert");
    expect(alert.textContent).toContain("Token turned down:");
    expect(alert.textContent).toContain("Paste a new token from Telegram's @BotFather.");
    // A refusal keeps what was typed, to fix and send again.
    expect((screen.getByLabelText("Telegram bot token") as HTMLInputElement).value).toBe("not-a-token");

    await user.click(screen.getByRole("button", { name: "Keep Telegram bot token as it is" }));
    s.gateways.refuse = { status: 403, detail: "platforms.telegram.enabled is locked by the managed level" };
    await user.click(screen.getByRole("switch", { name: "Turned on" }));
    await user.click(save());
    await waitFor(() => expect(within(rowOf("Save")).getByRole("alert").textContent).toContain("Permission refused: platforms.telegram.enabled is locked by the managed level"));
    expect(s.gateways.enabled.default.telegram).toBe(true);
  });

  it("checks the status without sending anything, and shows Hermes's answer redacted", async () => {
    const s = server();
    s.gateways.gateway.default = { running: true, platforms: { telegram: { state: "fatal", error_code: "telegram_auth_error", error_message: `Telegram bot token rejected: Unauthorized (https://api.telegram.org/bot${TOKEN}/getMe)` } } };
    const { user, view } = await shown({ s });
    await user.click(screen.getByRole("button", { name: "Check status" }));
    const line = await within(rowOf("Check status")).findByRole("status");
    expect(line.textContent).toContain("Token turned down: Telegram bot token rejected: Unauthorized (https://api.telegram.org/bot[redacted token]/getMe)");
    expect(s.gateways.writes).toEqual([{ profile: "default", what: "test telegram" }]);
    expect(view.container.innerHTML).not.toContain(TOKEN);
  });

  it("says when this Hermes has no messaging routes", async () => {
    const s = server();
    s.gateways.routes = "none";
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    render(<GatewaySettings api={hermes.gateways} profile="default" connected openUrl={vi.fn()} />);
    await screen.findByText(/no messaging gateway routes/);
  });

  it("drops an answer for a profile no longer shown", async () => {
    const s = server();
    let open!: () => void;
    s.gateways.gate = new Promise((r) => (open = r));
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    const view = render(<GatewaySettings key="default" api={hermes.gateways} profile="default" connected openUrl={vi.fn()} />);
    await screen.findByRole("navigation", { name: "Gateways" });
    await user.click(screen.getByRole("switch", { name: "Turned on" }));
    await user.click(save());
    view.rerender(<GatewaySettings key="bot" api={hermes.gateways} profile="bot" connected openUrl={vi.fn()} />);
    open();
    await waitFor(() => expect(s.gateways.enabled.default.telegram).toBe(false));
    await screen.findAllByText("Not set.");
    expect(screen.queryByText(/Saved, and Hermes reads it back/)).toBeNull();
  });

  it("is a Settings tab with a profile picker starting on the profile in use", async () => {
    const s = server();
    s.gateways.env.bot = { DISCORD_BOT_TOKEN: "bot-profile-discord-token" };
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    function Shell() {
      const [appearance] = useState(() => appearanceStore({ getItem: () => null, setItem: () => {} }, document.createElement("html")));
      return (
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
          gateways={hermes.gateways}
          listProfiles={async () => ["default", "bot"]}
          onClearCache={() => {}}
          onPullOlder={async () => []}
          onSignOut={async () => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Shell />);
    await user.click(screen.getByRole("tab", { name: "Gateways" }));
    await screen.findByRole("heading", { name: "Telegram" });
    const pick = screen.getByRole("combobox", { name: "Profile whose gateways are shown" }) as HTMLSelectElement;
    expect(pick.value).toBe("default");
    await waitFor(() => expect(pick.disabled).toBe(false));
    await user.selectOptions(pick, "bot");
    await user.click(await screen.findByRole("button", { name: "Discord" }));
    await screen.findByText("«redacted:bot-...oken»");
  });
});
