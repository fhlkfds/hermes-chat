import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { carryOptions, catalogFromServer, effortsFor, fallbackCatalog, guessCapabilities } from "./models";
import { connect } from "./transport";

async function signedIn(server = new FakeHermes()) {
  server.sessions = [row("backup", 1, { pinned: true }), row("nas", 2, { pinned: true })];
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  const chat = (id: string) => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  return { server, hermes, chat };
}

const configSets = (server: FakeHermes) => server.requests.filter((r) => r.method === "config.set").map((r) => r.params);

describe("The model list", () => {
  it("comes from Hermes's model.options, with the profile's own model and effort", async () => {
    const { server, hermes } = await signedIn();
    server.profileModel.default = { model: "gpt-5", provider: "openai", reasoning_effort: "high", fast: false };
    await hermes.loadModels();

    const models = hermes.getSnapshot().models!;
    expect(models).toMatchObject({ profile: "default", source: "server", defaultPick: { provider: "openai", model: "gpt-5" }, defaultEffort: "high" });
    expect(models.providers.map((p) => [p.slug, p.models.map((m) => m.model)])).toEqual([
      ["anthropic", ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]],
      ["openai", ["gpt-5", "gpt-4.1"]],
    ]);
    expect(models.providers[1].models[1]).toMatchObject({ reasoning: false, fast: false });
    expect(server.last("model.options")!.params).toEqual({ profile: "default" });
  });

  it("is read from dashboard REST when the socket has no model.options", async () => {
    const { server, hermes } = await signedIn();
    server.modelOptionsResult = undefined;
    server.restModelOptions = { model: "Hermes-4-405B", provider: "nous", providers: [{ slug: "nous", name: "Nous Portal", models: ["Hermes-4-405B", "Hermes-4-70B"] }] };
    await hermes.loadModels();

    expect(hermes.getSnapshot().models).toMatchObject({ source: "server", defaultPick: { provider: "nous", model: "Hermes-4-405B" } });
    expect(server.restRequests.at(-1)).toMatchObject({ method: "GET", path: "/api/model/options" });
    expect(server.restRequests.at(-1)!.query.get("profile")).toBe("default");
  });

  it("falls back to common models around the profile's own model when Hermes lists none, and says why", async () => {
    const { server, hermes } = await signedIn();
    server.modelOptionsResult = undefined;
    server.restModelOptions = null;
    server.profileModel.default = { model: "anthropic/claude-sonnet-4.5", provider: "openrouter", reasoning_effort: "medium", fast: false };
    await hermes.loadModels();

    const models = hermes.getSnapshot().models!;
    expect(models.source).toBe("fallback");
    expect(models.defaultPick).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    expect(models.providers.map((p) => p.slug)).toEqual(["openrouter", "anthropic"]);
    expect(models.providers[0].models[0].model).toBe("anthropic/claude-sonnet-4.5");
    expect(models.reason).toMatch(/model\.options: Method not found.*GET \/api\/model\/options: The dashboard answered 404/);
  });

  it("tries Hermes again after a fallback, and keeps Hermes's list once it has it", async () => {
    const { server, hermes } = await signedIn();
    server.modelOptionsResult = undefined;
    server.restModelOptions = null;
    await hermes.loadModels();
    expect(hermes.getSnapshot().models!.source).toBe("fallback");

    server.modelOptionsResult = { providers: [{ slug: "openai", name: "OpenAI", models: ["gpt-5"] }] };
    await hermes.loadModels();
    expect(hermes.getSnapshot().models!.source).toBe("server");
    await hermes.loadModels();
    expect(server.requests.filter((r) => r.method === "model.options")).toHaveLength(2);
  });

  it("is read again for another profile", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { work: [] };
    server.profileModel.work = { model: "gpt-5", provider: "openai", reasoning_effort: "low", fast: true };
    await hermes.loadModels();
    await hermes.switchProfile("work");
    expect(hermes.getSnapshot().models).toBeUndefined();
    await hermes.idle();
    await hermes.loadModels();
    expect(hermes.getSnapshot().models).toMatchObject({ profile: "work", defaultPick: { provider: "openai", model: "gpt-5" }, defaultEffort: "low" });
  });
});

describe("A chat's model", () => {
  it("starts a new chat on the pick, as that chat's own setting", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat({ provider: "openai", model: "gpt-5", effort: "high", fast: true });

    expect(server.last("session.create")!.params).toMatchObject({ model: "gpt-5", provider: "openai", reasoning_effort: "high", fast: true });
    expect(chat(id).model).toEqual({ provider: "openai", model: "gpt-5", effort: "high", fast: true });
    expect(server.profileModel).toEqual({});
  });

  it("leaves effort and fast mode to the profile when the pick does", async () => {
    const { server, hermes } = await signedIn();
    await hermes.newChat({ provider: "anthropic", model: "claude-opus-4-5" });
    const params = server.last("session.create")!.params;
    expect(params).toMatchObject({ model: "claude-opus-4-5", provider: "anthropic" });
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("fast");
  });

  it("switches only the chat on screen, never the profile's default", async () => {
    const { server, hermes, chat } = await signedIn();
    const sonnet = { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
    server.sessionModel.set("nas", sonnet);
    await hermes.open("backup");
    await hermes.open("nas");
    await hermes.idle();
    const backup = chat("backup").runtimeId!;

    await hermes.setModel("backup", { provider: "openai", model: "gpt-5", effort: "high", fast: true });

    expect(configSets(server)).toEqual([
      { session_id: backup, profile: "default", key: "model", value: "gpt-5 --provider openai --session" },
      { session_id: backup, profile: "default", key: "reasoning", value: "high", scope: "session" },
      { session_id: backup, profile: "default", key: "fast", value: "fast" },
    ]);
    expect(chat("backup").model).toEqual({ provider: "openai", model: "gpt-5", effort: "high", fast: true });
    expect(server.sessionModel.get("backup")).toMatchObject({ model: "gpt-5", provider: "openai", reasoning_effort: "high", fast: true });
    // The other chat, and the profile, are as they were.
    expect(chat("nas").model).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "medium", fast: false });
    expect(server.sessionModel.get("nas")).toEqual(sonnet);
    expect(server.profileModel).toEqual({});
  });

  it("sends only what changed", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat({ provider: "anthropic", model: "claude-opus-4-5", effort: "medium" });
    await hermes.setModel(id, { ...chat(id).model!, effort: "max" });
    expect(configSets(server)).toEqual([{ session_id: chat(id).runtimeId, profile: "default", key: "reasoning", value: "max", scope: "session" }]);
  });

  it("resumes a chat not open on this connection before switching it", async () => {
    const { server, hermes, chat } = await signedIn();
    await hermes.setModel("nas", { provider: "openai", model: "gpt-5" });
    expect(server.last("session.resume")!.params).toMatchObject({ session_id: "nas" });
    expect(server.last("config.set")!.params).toMatchObject({ session_id: chat("nas").runtimeId, key: "model" });
  });

  it("shows the chat's model as it was when Hermes refuses the switch", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.handlers["config.set"] = (r) => server.fail(r.id, 4002, "model not found: gpt-9");
    await expect(hermes.setModel(id, { provider: "openai", model: "gpt-9" })).rejects.toThrow("model not found: gpt-9");
    expect(chat(id).model).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("asks before an expensive model, and confirms it when picked again", async () => {
    const { server, hermes } = await signedIn();
    const id = await hermes.newChat();
    const set = server.handlers["config.set"];
    server.handlers["config.set"] = (r) =>
      r.params.confirm_expensive_model ? set(r) : server.respond(r.id, { key: "model", confirm_required: true, confirm_message: "claude-opus-4-5 costs $75/Mtok output." });
    const opus = { provider: "anthropic", model: "claude-opus-4-5" };
    await expect(hermes.setModel(id, opus)).rejects.toThrow("claude-opus-4-5 costs $75/Mtok output. Pick it again to use it.");
    await hermes.setModel(id, opus);
    expect(server.last("config.set")!.params).toMatchObject({ key: "model", confirm_expensive_model: true });
  });

  it("follows session.info, as when the model changes in another Hermes client", async () => {
    const { server, hermes, chat } = await signedIn();
    const id = await hermes.newChat();
    server.event(chat(id).runtimeId!, "session.info", { model: "gpt-5", provider: "openai", reasoning_effort: "low", fast: false });
    expect(chat(id).model).toEqual({ provider: "openai", model: "gpt-5", effort: "low", fast: false });
  });

  it("is read back from Hermes after a reconnect", async () => {
    const { server, hermes, chat } = await signedIn();
    await hermes.open("backup");
    await hermes.setModel("backup", { provider: "openai", model: "gpt-5" });
    server.drop();
    expect(chat("backup").runtimeId).toBeUndefined();
    await hermes.reconnect();
    await hermes.open("backup");
    await hermes.idle();
    expect(chat("backup").model).toMatchObject({ provider: "openai", model: "gpt-5" });
  });
});

describe("Model capabilities", () => {
  it("read Hermes's capabilities, and guess from the name when it has none", () => {
    const c = catalogFromServer("default", {
      providers: [{ slug: "x", name: "X", models: ["gpt-4.1", "claude-sonnet-4-5"], capabilities: { "gpt-4.1": { reasoning: true, fast: false } } }],
    })!;
    expect(c.providers[0].models.map((m) => [m.model, m.reasoning])).toEqual([
      ["gpt-4.1", true],
      ["claude-sonnet-4-5", true],
    ]);
    expect(guessCapabilities("gpt-4.1").reasoning).toBe(false);
    expect(guessCapabilities("openai/o3")).toMatchObject({ reasoning: true, canDisableReasoning: false });
  });

  it("offer no efforts for a model without reasoning, and Off only where reasoning can be turned off", () => {
    expect(effortsFor({ reasoning: false, canDisableReasoning: false })).toEqual([]);
    expect(effortsFor({ reasoning: true, canDisableReasoning: false })).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor({ reasoning: true, canDisableReasoning: true })[0]).toBe("none");
  });

  it("carry the owner's options to another model where it takes them", () => {
    const catalog = fallbackCatalog("default", undefined);
    expect(carryOptions({ provider: "openai", model: "gpt-5" }, { provider: "anthropic", model: "claude-opus-4-5", effort: "high", fast: true }, catalog)).toEqual({
      provider: "openai",
      model: "gpt-5",
      effort: "high",
      fast: true,
    });
    expect(carryOptions({ provider: "openai", model: "gpt-4.1" }, { provider: "openai", model: "gpt-5", effort: "high", fast: true }, catalog)).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
  });
});
