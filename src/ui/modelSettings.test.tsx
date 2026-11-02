// @vitest-environment jsdom
// Settings → Model on screen, against the fake dashboard: the draft, Apply, the guardrails, and leaving Settings.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

afterEach(cleanup);

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

/** The app around Settings: Back to chat closes it, and it can be opened again. */
function Shell({ hermes }: { hermes: Hermes }) {
  const [open, setOpen] = useState(true);
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  if (!open) return <button onClick={() => setOpen(true)}>Open Settings</button>;
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
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => setOpen(false)}
    />
  );
}

async function shown() {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  render(<Shell hermes={hermes} />);
  await user.click(screen.getByRole("tab", { name: /Model/ }));
  await screen.findByRole("combobox", { name: "Main provider" });
  return { server, user };
}

const select = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);

describe("Settings → Model", () => {
  it("shows the main model, subagents, auxiliary models and guardrails as Hermes has them", async () => {
    await shown();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining(["Main model", "Subagents", "Auxiliary models", "Guardrails"]),
    );
    expect(select("Main provider").value).toBe("openrouter");
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(select("Main reasoning effort").value).toBe("high");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Fast mode" }).checked).toBe(false);
    expect(select("Subagent route").value).toBe("inherit");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Subagent turn limit" }).value).toBe("50");
    expect(select("Compression provider").value).toBe("openrouter");
    expect(select("Compression effort").value).toBe("inherit");
    expect(select("Approval checks provider").value).toBe("auto");
    expect(select("Approval checks effort").value).toBe("none");
    expect(screen.getByText(/Chat titles, Compression and Vision are pinned to OpenRouter/)).toBeTruthy();
  });

  it("can't apply a provider switch until a model is picked for the new provider", async () => {
    const { user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    expect(select("Main model").value).toBe("");
    expect(screen.getByText("Choose a model for nous.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(true);
    await user.selectOptions(select("Main model"), "hermes-5-70b");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(false);
  });
});

describe("Leaving Settings", () => {
  it("drops the draft silently: nothing is written, and reopening shows what Hermes has", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    await user.selectOptions(select("Main model"), "hermes-5-70b");
    await user.selectOptions(select("Subagent route"), "custom-model");
    await user.clear(screen.getByRole("spinbutton", { name: "Subagent turn limit" }));
    await user.type(screen.getByRole("spinbutton", { name: "Subagent turn limit" }), "99");
    await user.selectOptions(select("Compression effort"), "none");

    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(server)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    await user.click(screen.getByRole("tab", { name: /Model/ }));
    await screen.findByRole("combobox", { name: "Main provider" });
    expect(select("Main provider").value).toBe("openrouter");
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(select("Subagent route").value).toBe("inherit");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Subagent turn limit" }).value).toBe("50");
    expect(select("Compression effort").value).toBe("inherit");
    expect(writes(server)).toEqual([]);
  });
});

describe("Guardrail: helper tasks pinned to another provider", () => {
  it("asks before the main model moves off their provider; Cancel writes nothing, Apply anyway applies", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    await user.selectOptions(select("Main model"), "hermes-5-70b");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));

    const ask = screen.getByRole("alertdialog", { name: "Auxiliary models still pinned" });
    expect(ask.textContent).toContain("Auxiliary models still pinned to OpenRouter — apply anyway?");
    expect(ask.textContent).toContain("Chat titles, Compression and Vision will keep running there");
    expect(writes(server)).toEqual([]);

    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(server)).toEqual([]);
    expect(select("Main provider").value).toBe("nous");

    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply anyway" }));
    await screen.findByText("Applied. New chats use it.");
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "nous", model: "hermes-5-70b" }]]);
    expect(server.modelConfig.model).toEqual({ provider: "nous", default: "hermes-5-70b" });
  });

  it("doesn't ask when the main model stays on the provider they're pinned to", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main model"), "deepseek/deepseek-v4-pro");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await screen.findByText("Applied. New chats use it.");
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "deepseek/deepseek-v4-pro" }]]);
  });
});

describe("Guardrail: a model Hermes flags as expensive", () => {
  it("Keep current writes nothing and puts the current model back", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main model"), "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));

    const ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    expect(ask.textContent).toContain("Switch the main model to anthropic/claude-fable-5.1?");
    expect(ask.textContent).toContain("has known pricing above Hermes' safety threshold.");
    expect(ask.textContent).toContain("Output tokens: $150.00/M");
    expect(server.modelConfig.model.default).toBe("z-ai/glm-5.3-flash");

    await user.click(within(ask).getByRole("button", { name: "Keep current" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(server.modelConfig.model.default).toBe("z-ai/glm-5.3-flash");
    // Only the refused request went out; Hermes wrote nothing for it.
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1" }]]);
  });

  it("Switch anyway applies it", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main model"), "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch anyway" }));
    await screen.findByText("Applied. New chats use it.");
    expect(server.modelConfig.model.default).toBe("anthropic/claude-fable-5.1");
    expect(writes(server).at(-1)).toEqual([
      "POST /api/model/set",
      { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1", confirm_expensive_model: true },
    ]);
  });
});

describe("Guardrail: an expensive helper model", () => {
  it("asks too; Keep current puts the task's model back, Switch anyway sets it", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Compression model"), "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    let ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    expect(ask.textContent).toContain("Use anthropic/claude-fable-5.1 for Compression?");
    await user.click(within(ask).getByRole("button", { name: "Keep current" }));
    expect(select("Compression model").value).toBe("deepseek/deepseek-v4-flash");
    expect(server.modelConfig.auxiliary.compression.model).toBe("deepseek/deepseek-v4-flash");

    await user.selectOptions(select("Compression model"), "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    await user.click(within(ask).getByRole("button", { name: "Switch anyway" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.compression.model).toBe("anthropic/claude-fable-5.1"));
  });
});

describe("Subagents and auxiliary models", () => {
  it("Use parent model asks for a provider and writes that alone", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Subagent route"), "parent-model");
    expect(screen.getByText("Choose the subagent provider.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Subagent model" })).toBeNull();
    await user.selectOptions(select("Subagent provider"), "nous");
    await user.click(screen.getByRole("button", { name: "Apply subagent" }));
    await waitFor(() => expect(server.modelConfig.delegation).toMatchObject({ provider: "nous", model: "" }));
    expect(writes(server)).toEqual([["PUT /api/config", { config: { delegation: { provider: "nous" } } }]]);
  });

  it("applies a helper task's own model and Off effort, leaving the main model's draft alone", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main reasoning effort"), "low");
    await user.selectOptions(select("Compression provider"), "openai-codex");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply auxiliary models" }).disabled).toBe(true);
    await user.selectOptions(select("Compression model"), "gpt-6.1-mini");
    await user.selectOptions(select("Compression effort"), "none");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.compression).toEqual({ provider: "openai-codex", model: "gpt-6.1-mini", reasoning_effort: "none" }));
    expect(select("Main reasoning effort").value).toBe("low");
    expect(server.modelConfig.agent.reasoning_effort).toBe("high");
  });
});
