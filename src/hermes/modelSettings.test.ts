// Settings → Model's data layer against the fake dashboard: what is read, what an Apply writes, and the guardrails.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import {
  AUX_AUTO,
  AUX_INHERIT,
  auxPinWarning,
  chooseAuxProvider,
  chooseProvider,
  chooseRoute,
  draftFrom,
  mainProblem,
  pinnedElsewhere,
  routeOf,
  subagentPatch,
  subagentProblem,
  subagentRouteValue,
  type Draft,
  type ModelSettings,
} from "./modelSettings";
import { connect } from "./transport";

async function setup() {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe, "default");
  const api = hermes.modelSettings;
  const saved = await api.load();
  server.restRequests.length = 0;
  return { server, hermes, api, saved };
}

/** The writes sent since `setup`, as `METHOD path` and body. */
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);

describe("Reading the model setup", () => {
  it("reads the main model, its defaults, the subagent route, the helper tasks and the catalog for the profile shown", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, "default");
    const s = await hermes.modelSettings.load();
    expect(s.main).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3-flash", effort: "high", fast: false });
    expect(s.subagent).toEqual({ provider: "", model: "", maxIterations: 50, maxConcurrent: 3, timeoutSeconds: 0, effort: "", directEndpoint: false });
    expect(s.auxiliary.map((t) => [t.task, t.label, t.provider, t.model, t.effort])).toEqual([
      ["title_generation", "Chat titles", "openrouter", "deepseek/deepseek-v4-flash", AUX_INHERIT],
      ["compression", "Compression", "openrouter", "deepseek/deepseek-v4-flash", AUX_INHERIT],
      ["vision", "Vision", "openrouter", "google/gemini-3.7-flash", AUX_INHERIT],
      ["approval", "Approval checks", AUX_AUTO, "", "none"],
      ["review", "Review", AUX_AUTO, "", AUX_INHERIT],
    ]);
    expect(s.providers.map((p) => p.slug)).toEqual(["openrouter", "nous", "openai-codex"]);
    expect(s.providers[2].caps["gpt-6.1-sol"]).toEqual({ fast: true, reasoning: true });
    const reads = server.restRequests.map((r) => `${r.method} ${r.path}?${r.query}`);
    expect(reads).toEqual(
      expect.arrayContaining([
        "GET /api/model/options?profile=default",
        "GET /api/model/auxiliary?profile=default",
        "GET /api/config?profile=default",
        "GET /api/delegation/routing?profile=default",
      ]),
    );
  });

  it("shows a hand-written `reasoning_effort: false` as Off, and the fast tier as Fast", async () => {
    const server = new FakeHermes();
    server.modelConfig.agent = { reasoning_effort: "false", service_tier: "fast" };
    server.modelConfig.delegation.reasoning_effort = "disabled";
    const s = await (await connect(server.openPipe, "default")).modelSettings.load();
    expect(s.main).toMatchObject({ effort: "none", fast: true });
    expect(s.subagent.effort).toBe("none");
  });

  it("notes a direct subagent endpoint and the plugin's named routes, which this screen leaves alone", async () => {
    const server = new FakeHermes();
    server.modelConfig.delegation.base_url = "http://10.0.0.5:8080/v1";
    server.modelConfig.modelMap = [{ name: "cheap", description: "Small jobs", provider: "openrouter", model: "deepseek/deepseek-v4-flash" }];
    const s = await (await connect(server.openPipe, "default")).modelSettings.load();
    expect(s.subagent.directEndpoint).toBe(true);
    expect(s.namedRoutes).toBe(1);
  });
});

describe("The draft", () => {
  it("is written only on Apply, and then only the parts that changed", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.main = { ...chooseProvider(d.main, "openai-codex"), model: "gpt-6.1-sol", fast: true };
    expect(writes(server)).toEqual([]);

    expect(await api.applyMain(saved, d)).toEqual({ applied: true });
    expect(writes(server)).toEqual([
      ["POST /api/model/set", { scope: "main", provider: "openai-codex", model: "gpt-6.1-sol" }],
      ["PUT /api/config", { config: { agent: { service_tier: "fast" } } }],
    ]);
    expect(server.modelConfig.model).toEqual({ provider: "openai-codex", default: "gpt-6.1-sol" });
    expect(await api.load()).toMatchObject({ main: { provider: "openai-codex", model: "gpt-6.1-sol", effort: "high", fast: true } });
  });

  it("writes only the defaults when only the defaults changed", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.main.effort = "none";
    await api.applyMain(saved, d);
    expect(writes(server)).toEqual([["PUT /api/config", { config: { agent: { reasoning_effort: "none" } } }]]);
  });

  it("discarded, is what Hermes has again, and nothing was written", async () => {
    const { server, saved } = await setup();
    const d: Draft = draftFrom(saved);
    d.main = { ...chooseProvider(d.main, "nous"), model: "hermes-5-70b", effort: "low" };
    d.subagent = chooseRoute(d.subagent, "custom-model");
    d.auxiliary.compression = chooseAuxProvider(d.auxiliary.compression, AUX_AUTO);
    expect(draftFrom(saved)).not.toEqual(d);
    // Discarding is building the draft from what Hermes has, as reopening Settings does.
    expect(draftFrom(saved)).toEqual(draftFrom(await (await setup()).api.load()));
    expect(writes(server)).toEqual([]);
    expect(server.modelConfig.model).toEqual({ provider: "openrouter", default: "z-ai/glm-5.3-flash" });
  });
});

describe("Switching provider", () => {
  it("drops the old provider's model, and the main model can't be applied until one is picked", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.main = chooseProvider(d.main, "nous");
    expect(d.main).toMatchObject({ provider: "nous", model: "" });
    expect(mainProblem(d)).toBe("Choose a model for nous.");
    await expect(api.applyMain(saved, d)).rejects.toThrow("Choose a model for nous.");
    expect(writes(server)).toEqual([]);
    d.main.model = "hermes-5-70b";
    expect(mainProblem(d)).toBeUndefined();
  });

  it("keeps the model when the same provider is picked again", () => {
    expect(chooseProvider({ provider: "nous", model: "hermes-5-70b" }, "nous")).toEqual({ provider: "nous", model: "hermes-5-70b" });
  });

  it("for a subagent, needs a model too", async () => {
    const { server, api, saved } = await setup();
    let sub = chooseRoute(draftFrom(saved).subagent, "provider");
    sub = chooseProvider(sub, "nous");
    expect(subagentProblem(sub)).toBe("Choose a model for nous: switching provider needs one.");
    await expect(api.applySubagent(saved, sub)).rejects.toThrow("switching provider needs one");
    expect(writes(server)).toEqual([]);
  });

  it("for a helper task, needs a model unless it goes back to the main model", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.auxiliary.compression = chooseAuxProvider(d.auxiliary.compression, "nous");
    await expect(api.applyAuxiliary(saved, d)).rejects.toThrow("Compression: choose a model for nous.");
    expect(writes(server)).toEqual([]);
    d.auxiliary.compression = chooseAuxProvider(d.auxiliary.compression, AUX_AUTO);
    await api.applyAuxiliary(saved, d);
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "auxiliary", task: "compression", provider: "auto", model: "", reasoning_effort: null }]]);
  });
});

describe("Subagent routes", () => {
  it("are read from which of provider and model are set", () => {
    expect(routeOf("", "")).toBe("inherit");
    expect(routeOf("nous", "")).toBe("parent-model");
    expect(routeOf("", "hermes-5-70b")).toBe("custom-model");
    expect(routeOf("nous", "hermes-5-70b")).toBe("provider");
  });

  it("Use parent model writes a provider only, which isn't Inherit", async () => {
    const { server, api, saved } = await setup();
    let sub = chooseRoute(draftFrom(saved).subagent, "parent-model");
    expect(subagentProblem(sub)).toBe("Choose the subagent provider.");
    sub = { ...sub, provider: "nous" };
    expect(subagentRouteValue(sub)).toEqual({ provider: "nous", model: "" });
    await api.applySubagent(saved, sub);
    expect(writes(server)).toEqual([["PUT /api/config", { config: { delegation: { provider: "nous" } } }]]);
    expect((await api.load()).subagent).toMatchObject({ provider: "nous", model: "" });
    expect(routeOf("nous", "")).not.toBe(routeOf("", ""));
  });

  it("Custom model keeps the parent's provider and credentials: it writes a model only", async () => {
    const server = new FakeHermes();
    server.modelConfig.delegation.provider = "nous";
    const saved: ModelSettings = await (await connect(server.openPipe, "default")).modelSettings.load();
    expect(draftFrom(saved).subagent.route).toBe("parent-model");
    const sub = { ...chooseRoute(draftFrom(saved).subagent, "custom-model"), model: "deepseek/deepseek-v4-flash" };
    expect(subagentPatch(saved, sub)).toEqual({ provider: "", model: "deepseek/deepseek-v4-flash" });
  });

  it("Inherit clears both", () => {
    const sub = chooseRoute({ route: "provider", provider: "nous", model: "hermes-5-70b", maxIterations: "50", maxConcurrent: "3", timeoutSeconds: "0", effort: "" }, "inherit");
    expect(subagentRouteValue(sub)).toEqual({ provider: "", model: "" });
  });

  it("writes the turn limit, concurrency, timeout and effort that changed", async () => {
    const { server, api, saved } = await setup();
    const sub = { ...draftFrom(saved).subagent, maxIterations: "80", timeoutSeconds: "300", effort: "none" };
    await api.applySubagent(saved, sub);
    expect(writes(server)).toEqual([["PUT /api/config", { config: { delegation: { max_iterations: 80, child_timeout_seconds: 300, reasoning_effort: "none" } } }]]);
    expect((await api.load()).subagent).toMatchObject({ maxIterations: 80, timeoutSeconds: 300, effort: "none" });
  });

  it("refuses numbers Hermes wouldn't take", () => {
    const sub = { route: "inherit" as const, provider: "", model: "", maxIterations: "50", maxConcurrent: "3", timeoutSeconds: "0", effort: "" };
    expect(subagentProblem({ ...sub, maxIterations: "0" })).toMatch(/turn limit/);
    expect(subagentProblem({ ...sub, maxConcurrent: "2.5" })).toMatch(/Concurrency/);
    expect(subagentProblem({ ...sub, timeoutSeconds: "10" })).toMatch(/timeout/);
    expect(subagentProblem({ ...sub, timeoutSeconds: "30" })).toBeUndefined();
  });
});

describe("Helper task effort", () => {
  it("inherit follows the main model's effort, Off turns reasoning off, and a level sets it", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.auxiliary.compression.effort = "none";
    d.auxiliary.approval.effort = AUX_INHERIT;
    d.auxiliary.vision.effort = "low";
    await api.applyAuxiliary(saved, d);
    expect(writes(server).map(([, body]) => body)).toEqual([
      { scope: "auxiliary", task: "compression", provider: "openrouter", model: "deepseek/deepseek-v4-flash", reasoning_effort: "none" },
      { scope: "auxiliary", task: "vision", provider: "openrouter", model: "google/gemini-3.7-flash", reasoning_effort: "low" },
      { scope: "auxiliary", task: "approval", provider: "auto", model: "", reasoning_effort: null },
    ]);
    const after = Object.fromEntries((await api.load()).auxiliary.map((t) => [t.task, t.effort]));
    expect(after).toMatchObject({ compression: "none", vision: "low", approval: AUX_INHERIT, title_generation: AUX_INHERIT });
  });

  it("is inherit for a new draft of a task with no effort of its own", async () => {
    const { saved } = await setup();
    expect(draftFrom(saved).auxiliary.title_generation.effort).toBe(AUX_INHERIT);
  });
});

describe("Guardrail: helper tasks pinned to another provider", () => {
  it("asks before the main model moves to another provider while helper tasks are pinned to the old one", async () => {
    const { saved } = await setup();
    const d = draftFrom(saved);
    d.main = { ...chooseProvider(d.main, "nous"), model: "hermes-5-70b" };
    const w = auxPinWarning(saved, d);
    expect(w?.providers).toEqual(["openrouter"]);
    expect(w?.tasks.map((t) => t.task)).toEqual(["title_generation", "compression", "vision"]);
  });

  it("doesn't ask when the main model stays on the pinned provider, or only its defaults change", async () => {
    const { saved } = await setup();
    const d = draftFrom(saved);
    d.main.model = "deepseek/deepseek-v4-pro";
    expect(auxPinWarning(saved, d)).toBeUndefined();
    const defaults = draftFrom(saved);
    defaults.main.effort = "low";
    expect(auxPinWarning(saved, defaults)).toBeUndefined();
  });

  it("leaves out tasks on the main model and pins to a local endpoint, as Hermes's own check does", () => {
    const task = { label: "", hint: "", model: "m", effort: AUX_INHERIT, localEndpoint: false };
    const tasks = [
      { ...task, task: "a", provider: "auto" },
      { ...task, task: "b", provider: "main" },
      { ...task, task: "c", provider: "custom", localEndpoint: true },
      { ...task, task: "d", provider: "OpenRouter" },
      { ...task, task: "e", provider: "nous" },
    ];
    expect(pinnedElsewhere(tasks, "nous").map((t) => t.task)).toEqual(["d"]);
  });
});

describe("Guardrail: a model Hermes flags as expensive", () => {
  it("isn't switched to, nor are the defaults written, until the owner confirms", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.main = { ...d.main, model: "anthropic/claude-fable-5.1", effort: "low" };
    const first = await api.applyMain(saved, d);
    expect(first).toEqual({ applied: false, expensive: expect.stringContaining("anthropic/claude-fable-5.1 has known pricing above Hermes' safety threshold.") });
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1" }]]);
    expect(server.modelConfig.model.default).toBe("z-ai/glm-5.3-flash");
    expect(server.modelConfig.agent.reasoning_effort).toBe("high");

    expect(await api.applyMain(saved, d, true)).toEqual({ applied: true });
    expect(writes(server).slice(1)).toEqual([
      ["POST /api/model/set", { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1", confirm_expensive_model: true }],
      ["PUT /api/config", { config: { agent: { reasoning_effort: "low" } } }],
    ]);
    expect(server.modelConfig.model.default).toBe("anthropic/claude-fable-5.1");
  });

  it("guards a helper task's model too: tasks before it are written, it and those after wait for its confirm", async () => {
    const { server, api, saved } = await setup();
    const d = draftFrom(saved);
    d.auxiliary.title_generation.effort = "low";
    d.auxiliary.compression.model = "anthropic/claude-fable-5.1";
    d.auxiliary.vision.effort = "none";
    const first = await api.applyAuxiliary(saved, d);
    expect(first).toEqual({ applied: false, task: "compression", expensive: expect.stringContaining("safety threshold") });
    expect(server.modelConfig.auxiliary).toMatchObject({
      title_generation: { reasoning_effort: "low" },
      compression: { model: "deepseek/deepseek-v4-flash" },
      vision: { model: "google/gemini-3.7-flash" },
    });
    expect(server.modelConfig.auxiliary.vision.reasoning_effort).toBeUndefined();

    const fresh = await api.load();
    expect(await api.applyAuxiliary(fresh, d, ["compression"])).toEqual({ applied: true });
    expect(writes(server).slice(2).map(([, body]) => body)).toEqual([
      { scope: "auxiliary", task: "compression", provider: "openrouter", model: "anthropic/claude-fable-5.1", reasoning_effort: null, confirm_expensive_model: true },
      { scope: "auxiliary", task: "vision", provider: "openrouter", model: "google/gemini-3.7-flash", reasoning_effort: "none" },
    ]);
    expect(server.modelConfig.auxiliary.compression.model).toBe("anthropic/claude-fable-5.1");
  });

  it("fails rather than asks again when Hermes still refuses a confirmed switch", async () => {
    const { server, api, saved } = await setup();
    server.rest["POST /api/model/set"] = () => ({ ok: false, confirm_required: true, confirm_message: "Still too expensive." });
    const d = draftFrom(saved);
    d.main.model = "anthropic/claude-fable-5.1";
    await expect(api.applyMain(saved, d, true)).rejects.toThrow("Still too expensive.");
  });
});
