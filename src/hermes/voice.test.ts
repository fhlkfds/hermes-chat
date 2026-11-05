// The parts of Dictation and Read aloud that aren't UI: the WAV a recording is sent as, how a transcript joins the
// draft, what a microphone failure tells the owner, and how the profile's providers are named.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { clock, dictationBlocked, micProblem, readAloudBlocked, sttProvider, toWav, ttsProvider, withTranscript } from "./voice";

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

describe("a recording as WAV", () => {
  it("is 16 kHz mono 16-bit PCM with a correct header", () => {
    // One second at 48 kHz, in uneven chunks.
    const tone = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin(i / 10) * 0.5);
    const wav = toWav([tone.slice(0, 1000), tone.slice(1000, 30_000), tone.slice(30_000)], 48_000);
    const view = new DataView(wav.buffer);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 16)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + 32_000);
  });

  it("averages the samples each output sample covers, and clips", () => {
    const wav = toWav([Float32Array.from([1, 1, 1, -1, -1, -1, 0.5, 0.5, 0.5, 2, 2, 2])], 48_000);
    const view = new DataView(wav.buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0x7fff, -0x8000, Math.floor(0.5 * 0x7fff), 0x7fff]);
  });

  it("is an empty data chunk for nothing recorded", () => {
    const wav = toWav([], 44_100);
    expect(wav.length).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("a transcript in the composer", () => {
  it("joins what's typed with a space, or stands alone", () => {
    expect(withTranscript("", "Check the logs")).toBe("Check the logs");
    expect(withTranscript("Hi.", "Check the logs")).toBe("Hi. Check the logs");
    expect(withTranscript("Hi.\n", "Check the logs")).toBe("Hi.\nCheck the logs");
  });

  it("shows its length as a clock", () => {
    expect([clock(0), clock(7.9), clock(65), clock(300)]).toEqual(["0:00", "0:07", "1:05", "5:00"]);
  });
});

describe("a microphone that can't be used", () => {
  it.each([
    ["NotAllowedError", /wasn't allowed to use the microphone/],
    ["SecurityError", /wasn't allowed/],
    ["NotFoundError", /No microphone was found/],
    ["OverconstrainedError", /No microphone was found/],
    ["NotReadableError", /Another app may be using it/],
  ])("%s says what to do", (name, said) => {
    expect(micProblem(new DOMException("x", name))).toMatch(said);
  });

  it("passes on anything else", () => {
    expect(micProblem(new Error("boom"))).toBe("The microphone couldn't be started: boom");
  });
});

describe("the profile's voice providers", () => {
  const ready = { transcribe: true, speak: true, sttEnabled: true };

  it("are named, with what each needs on the server", () => {
    expect(sttProvider({ ...ready, sttProvider: "local" })).toMatchObject({ label: "Local Whisper", needs: expect.stringMatching(/faster-whisper/) });
    expect(sttProvider({ ...ready, sttProvider: "groq" }).needs).toMatch(/GROQ_API_KEY/);
    expect(ttsProvider({ ...ready, ttsProvider: "elevenlabs" }).label).toBe("ElevenLabs");
    expect(sttProvider({ ...ready, sttProvider: "my-plugin" })).toMatchObject({ label: "my-plugin" });
  });

  it("fall back to Hermes's own choice when the config names none", () => {
    expect(sttProvider(ready).label).toBe("Picked by Hermes");
    expect(ttsProvider(ready).label).toBe("Microsoft Edge TTS");
  });

  it("block Dictation on a server without transcription or with speech-to-text off, and Read aloud without speech", () => {
    expect(dictationBlocked(undefined)).toBeUndefined();
    expect(dictationBlocked(ready)).toBeUndefined();
    expect(dictationBlocked({ ...ready, transcribe: false })).toMatch(/can't transcribe recordings/);
    expect(dictationBlocked({ ...ready, sttEnabled: false })).toMatch(/stt.enabled is false/);
    expect(readAloudBlocked(ready)).toBeUndefined();
    expect(readAloudBlocked({ ...ready, speak: false })).toMatch(/can't read replies aloud/);
  });
});

describe("speech to text on this computer (ADR 0062)", () => {
  const server = { transcribe: true, speak: true, sttEnabled: true, sttProvider: "groq" };

  it("names the local engine and says the audio stays here", () => {
    expect(sttProvider({ ...server, sttLocal: { label: "whisper.cpp" } })).toEqual({
      label: "whisper.cpp on this computer",
      needs: expect.stringMatching(/never leaves it/),
    });
  });

  it("doesn't depend on the server's transcription, but blocks Dictation while the engine can't run", () => {
    expect(dictationBlocked({ ...server, transcribe: false, sttEnabled: false, sttLocal: { label: "Vosk" } })).toBeUndefined();
    expect(dictationBlocked({ ...server, sttLocal: { problem: "No speech-to-text engine is chosen on this computer." } })).toBe(
      "No speech-to-text engine is chosen on this computer. See Settings → Voice.",
    );
  });
});

describe("Hermes's voice calls", () => {
  it("read the set-up once per connection and profile", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    let reads = 0;
    const open = server.openPipe;
    server.openPipe = async (onEvent, profile) => {
      const pipe = await open(onEvent, profile);
      return { ...pipe, voiceSetup: (p) => (reads++, pipe.voiceSetup(p)) };
    };
    const hermes = await connect(server.openPipe);
    await hermes.idle();
    expect(await hermes.voiceSetup()).toMatchObject(server.voice);
    await hermes.voiceSetup();
    expect(reads).toBe(1);
    await hermes.switchProfile("work");
    await hermes.idle();
    await hermes.voiceSetup();
    expect(reads).toBe(2);
  });

  it("go to the profile shown", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    const hermes = await connect(server.openPipe);
    await hermes.switchProfile("work");
    await hermes.idle();
    expect(await hermes.transcribe(new Uint8Array([1, 2]), "audio/wav")).toEqual({ text: "Check the backup logs", provider: "local" });
    await hermes.speak("Hello");
    expect(server.recordings.map((r) => r.profile)).toEqual(["work"]);
    expect(server.spoken).toEqual([{ profile: "work", text: "Hello" }]);
  });

  it("refuse while not connected", async () => {
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe);
    server.refuse = "Can't reach the Hermes dashboard: connection refused";
    server.drop();
    await expect(hermes.transcribe(new Uint8Array([1]), "audio/wav")).rejects.toThrow("Not connected to Hermes.");
    await expect(hermes.speak("Hi")).rejects.toThrow("Not connected to Hermes.");
    await expect(hermes.voiceSetup()).rejects.toThrow("Not connected to Hermes.");
    expect(server.recordings).toEqual([]);
  });
});
