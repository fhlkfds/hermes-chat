// Settings → Voice's reads and writes against the fake dashboard (fakeVoiceProviders.ts): the providers Hermes lists and
// which are set up, each provider's settings without its keys, and saves that are checked first and read back.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { type VoiceDraft, VoiceUnsupportedError, activeOf, emptyDraft, namedOf, pickedOf } from "./voiceSettings";

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  const fake = server.voiceProviders;
  const hermes = await connect(server.openPipe, "default");
  return { server, fake, hermes, api: hermes.voiceSettings };
}

const draft = (d: Partial<VoiceDraft>): VoiceDraft => ({ ...emptyDraft(), ...d });

describe("Settings → Voice: reading", () => {
  it("lists Hermes's providers for each side, with the one in use and which are set up", async () => {
    const { fake, api } = await setUp();
    fake.env.default = new Set(["GROQ_API_KEY"]);
    const read = await api.read("default");
    const stt = Object.fromEntries(read.sides.stt.providers.map((p) => [p.name, p]));
    expect(Object.keys(stt)).toEqual(["Local Whisper", "Nous Subscription", "OpenAI", "Groq", "ElevenLabs Scribe", "Mistral Voxtral"]);
    expect(stt["Local Whisper"]).toMatchObject({ active: true, status: "ready", section: "local" });
    expect(stt.Groq).toMatchObject({ active: false, status: "ready", section: "groq", keys: [{ env: "GROQ_API_KEY", set: true }] });
    expect(stt.OpenAI).toMatchObject({ status: "needs_keys", keys: [{ env: "VOICE_TOOLS_OPENAI_KEY", set: false }] });
    expect(stt["Nous Subscription"]).toMatchObject({ status: "needs_auth", managed: true, section: undefined });
    const tts = Object.fromEntries(read.sides.tts.providers.map((p) => [p.name, p]));
    expect(activeOf(read, "tts")?.name).toBe("Microsoft Edge TTS");
    expect(tts.Piper).toMatchObject({ status: "needs_setup", section: "piper" });
    expect(tts["OpenAI TTS"].section).toBe("openai");
  });

  it("shows each provider's model, voice and language, and the choices Hermes has for them, never a key", async () => {
    const { fake, api } = await setUp();
    fake.set("default", "tts.openai.api_key", "sk-SECRET");
    fake.set("default", "tts.openai.voice", "nova");
    const read = await api.read("default");
    expect(read.values).toMatchObject({ "tts.openai.voice": "nova", "tts.openai.model": "gpt-4o-mini-tts", "stt.local.model": "base", "stt.language": "en" });
    expect(JSON.stringify(read)).not.toContain("SECRET");
    expect(read.options["stt.local.model"]).toEqual(["base", "tiny", "small", "medium", "large-v3", "turbo"]);
    // Only the speech settings' choices are kept.
    expect(read.options["agent.reasoning_effort"]).toBeUndefined();
  });

  it("says when Hermes can't list its speech providers", async () => {
    const { fake, api } = await setUp();
    fake.routes = "none";
    const e = await api.read("default").catch((x) => x);
    expect(e).toBeInstanceOf(VoiceUnsupportedError);
    expect(e.message).toMatch(/no \/api\/tools\/toolsets\/stt\/config route/);
  });

  it("reads each profile's own", async () => {
    const { fake, api } = await setUp();
    fake.set("work", "tts.provider", "openai");
    expect(activeOf(await api.read("work"), "tts")?.name).toBe("OpenAI TTS");
    expect(activeOf(await api.read("default"), "tts")?.name).toBe("Microsoft Edge TTS");
  });
});

describe("Settings → Voice: saving", () => {
  it("saves a key, a pick and a setting, in that order, and calls it saved once read back", async () => {
    const { fake, api, hermes } = await setUp();
    let told = 0;
    hermes.onVoiceChange(() => told++);
    const base = await api.read("default");
    const r = await api.save(
      "default",
      base,
      draft({ provider: { tts: "OpenAI TTS" }, settings: { "tts.openai.voice": "shimmer" }, keys: { tts: { VOICE_TOOLS_OPENAI_KEY: " sk-new " } } }),
    );
    expect(r.kind).toBe("saved");
    expect(fake.writes.map((w) => w.route)).toEqual(["env", "provider", "config"]);
    expect(fake.writes[1].body).toEqual({ provider: "OpenAI TTS" });
    expect(fake.writes[2].body).toEqual({ tts: { openai: { voice: "shimmer" } } });
    expect(fake.savedKeys).toEqual([{ profile: "default", env: "VOICE_TOOLS_OPENAI_KEY", value: "sk-new" }]);
    if (r.kind !== "saved") return;
    expect(activeOf(r.read, "tts")).toMatchObject({ name: "OpenAI TTS", status: "ready" });
    expect(r.read.values["tts.openai.voice"]).toBe("shimmer");
    // The chat panes' voice set-up is read again, and shows the new provider.
    expect(told).toBeGreaterThan(0);
    expect((await hermes.voiceSetup()).ttsProvider).toBe("openai");
  });

  it("sends a blank key nowhere, and a pick of the provider already in use not at all", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    const r = await api.save("default", base, draft({ provider: { stt: "Local Whisper" }, keys: { stt: { GROQ_API_KEY: "  " } }, settings: { "stt.local.model": "small" } }));
    expect(r.kind).toBe("saved");
    expect(fake.writes.map((w) => w.route)).toEqual(["config"]);
  });

  it("sends nothing when another client changed what is being saved since it was read", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    fake.set("default", "tts.edge.voice", "en-GB-SoniaNeural");
    fake.set("default", "stt.provider", "groq");
    const r = await api.save("default", base, draft({ provider: { stt: "OpenAI" }, settings: { "tts.edge.voice": "en-US-JennyNeural" } }));
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    expect(r.what).toEqual(["the speech-to-text provider (now Groq)", "Microsoft Edge TTS's voice"]);
    expect(r.kinds).toEqual(["stt"]);
    expect(r.paths).toEqual(["tts.edge.voice"]);
    expect(r.read.values["tts.edge.voice"]).toBe("en-GB-SoniaNeural");
    expect(fake.writes).toEqual([]);
  });

  it("doesn't count a change to something else as a conflict", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    fake.set("default", "stt.local.model", "medium");
    expect((await api.save("default", base, draft({ settings: { "tts.edge.voice": "en-US-JennyNeural" } }))).kind).toBe("saved");
  });

  it("reports Hermes's refusal, and that nothing was changed", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    fake.rows.tts = fake.rows.tts.filter((p) => p.name !== "Piper");
    const r = await api.save("default", base, draft({ provider: { tts: "Piper" } }));
    expect(r).toMatchObject({ kind: "failed", refused: true, done: [], reason: "Unknown provider 'Piper' for toolset 'tts'" });
  });

  it("says what Hermes had already taken when a later write is refused", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    fake.failNext = { route: "config", status: 400, detail: "bad value" };
    const r = await api.save("default", base, draft({ provider: { tts: "ElevenLabs" }, settings: { "tts.elevenlabs.voice_id": "x" } }));
    expect(r).toMatchObject({ kind: "failed", refused: true, done: ["the text-to-speech provider"], reason: "bad value" });
    if (r.kind === "failed") expect(activeOf(r.read!, "tts")?.name).toBe("ElevenLabs");
  });

  it("goes by the read when the answer was lost", async () => {
    const { fake, api } = await setUp();
    let base = await api.read("default");
    fake.failNext = { route: "provider", detail: "Can't reach the Hermes dashboard: connection reset", stored: true };
    const saved = await api.save("default", base, draft({ provider: { stt: "Groq" } }));
    expect(saved).toMatchObject({ kind: "saved", warning: "Can't reach the Hermes dashboard: connection reset" });
    base = await api.read("default");
    fake.failNext = { route: "provider", detail: "Can't reach the Hermes dashboard: connection reset" };
    const lost = await api.save("default", base, draft({ provider: { stt: "OpenAI" } }));
    expect(lost).toMatchObject({ kind: "failed", refused: false, done: [] });
  });

  it("doesn't call a replaced key saved when its write didn't answer: the old key reads as set too", async () => {
    const { fake, api } = await setUp();
    fake.env.default = new Set(["GROQ_API_KEY"]);
    const base = await api.read("default");
    fake.failNext = { route: "env", detail: "Can't reach the Hermes dashboard: connection reset", stored: true };
    const r = await api.save("default", base, draft({ keys: { stt: { GROQ_API_KEY: "gsk-new" } } }));
    expect(r).toMatchObject({ kind: "failed", refused: false, done: [] });
    // A pick that went through alongside it doesn't make the key proven either.
    fake.failNext = { route: "env", status: 500, detail: "Internal server error", stored: true };
    const again = await api.save("default", await api.read("default"), draft({ keys: { stt: { GROQ_API_KEY: "gsk-2" } }, settings: { "stt.groq.model": "whisper-large-v3" } }));
    expect(again).toMatchObject({ kind: "failed", refused: false });
  });

  it("refuses, before sending anything, a blank Hermes would use, and a pick that needs a sign-in on the server", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    const blank = await api.save("default", base, draft({ settings: { "tts.edge.voice": " " } }));
    expect(blank).toMatchObject({ kind: "failed", refused: true, done: [] });
    if (blank.kind === "failed") expect(blank.reason).toMatch(/Microsoft Edge TTS's voice can't be blank/);
    const nous = await api.save("default", base, draft({ provider: { tts: "Nous Subscription" } }));
    expect(nous).toMatchObject({ kind: "failed", refused: true, done: [] });
    if (nous.kind === "failed") expect(nous.reason).toMatch(/Nous Subscription needs a sign-in on the Hermes server first/);
    expect(fake.writes).toEqual([]);
    // Where Hermes falls back on a blank (a language, Gemini's voice), it is sent.
    expect((await api.save("default", base, draft({ settings: { "stt.local.language": "", "stt.language": "" } }))).kind).toBe("saved");
  });

  it("names Local Whisper when it is picked while the profile names no speech-to-text provider", async () => {
    const { server, fake, api } = await setUp();
    server.voice = { ...server.voice, sttProvider: undefined };
    const base = await api.read("default");
    expect(activeOf(base, "stt")?.name).toBe("Local Whisper");
    expect(pickedOf(base, "stt")).toBeUndefined();
    const r = await api.save("default", base, draft({ provider: { stt: "Local Whisper" } }));
    expect(r.kind).toBe("saved");
    expect(fake.writes).toEqual([{ profile: "default", route: "provider", body: { provider: "Local Whisper" } }]);
    if (r.kind === "saved") expect(namedOf(r.read, "stt")).toBe("local");
  });

  it("doesn't call Local Whisper picked when the write naming it was lost, though Hermes marks it in use either way", async () => {
    const { server, fake, api } = await setUp();
    server.voice = { ...server.voice, sttProvider: undefined };
    const base = await api.read("default");
    fake.failNext = { route: "provider", detail: "Can't reach the Hermes dashboard: connection reset" };
    const r = await api.save("default", base, draft({ provider: { stt: "Local Whisper" } }));
    expect(r).toMatchObject({ kind: "failed", refused: false, done: [] });
  });

  it("won't read, and so won't save, when Rust couldn't read the profile's config", async () => {
    const { server, api } = await setUp();
    server.voice = { transcribe: true, speak: true };
    await expect(api.read("default")).rejects.toThrow(/couldn't read the profile's config on Hermes/);
  });

  it("sees another client switch between two providers Hermes doesn't list", async () => {
    const { fake, api } = await setUp();
    fake.set("default", "stt.provider", "my-command-a");
    const base = await api.read("default");
    expect(activeOf(base, "stt")).toBeUndefined();
    fake.set("default", "stt.provider", "my-command-b");
    const r = await api.save("default", base, draft({ provider: { stt: "Groq" } }));
    expect(r).toMatchObject({ kind: "conflict", what: ["the speech-to-text provider (now my-command-b)"], kinds: ["stt"] });
    expect(fake.writes).toEqual([]);
  });

  it("says when Hermes took a pick but it doesn't read back", async () => {
    const { fake, api } = await setUp();
    const base = await api.read("default");
    fake.ignoreNextPick = true;
    const r = await api.save("default", base, draft({ provider: { tts: "ElevenLabs" } }));
    expect(r).toMatchObject({ kind: "mismatch", what: ["the text-to-speech provider"] });
  });

  it("writes only the profile it names, one save at a time", async () => {
    const { fake, api } = await setUp();
    const [base, work] = await Promise.all([api.read("default"), api.read("work")]);
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    const first = api.save("work", work, draft({ provider: { tts: "ElevenLabs" } }));
    const second = api.save("default", base, draft({ provider: { tts: "OpenAI TTS" } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.pending()).toBe("work");
    open();
    expect((await first).kind).toBe("saved");
    expect((await second).kind).toBe("saved");
    expect(fake.writes.map((w) => [w.profile, w.body])).toEqual([
      ["work", { provider: "ElevenLabs" }],
      ["default", { provider: "OpenAI TTS" }],
    ]);
    expect(fake.provider("work", "tts")).toBe("elevenlabs");
    expect(fake.provider("default", "tts")).toBe("openai");
  });
});
