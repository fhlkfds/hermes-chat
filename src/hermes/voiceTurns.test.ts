import { describe, expect, it } from "vitest";
import { MAX_RECORDING_SECONDS } from "./voice";
import { HERMES_MAX_RECORDING_SECONDS, TurnDetector, conversationBlocked, isEcho, rms16, turnSettings } from "./voiceTurns";
import type { VoiceSetup } from "./pipe";

const setup = (over: Partial<VoiceSetup> = {}): VoiceSetup => ({ transcribe: true, speak: true, sttEnabled: true, ...over });

/** Feeds `seconds` of blocks at `rms` from `t`, 0.1 s each, and returns the first ending and when it came. */
function feed(d: TurnDetector, from: number, seconds: number, rms: number) {
  let t = from;
  for (let i = 0; i < Math.round(seconds * 10); i++) {
    t = Math.round((t + 0.1) * 10) / 10;
    const end = d.push(rms, t);
    if (end) return { end, at: t, t };
  }
  return { end: undefined, at: undefined, t };
}

describe("turn settings", () => {
  it("are Hermes's defaults when the profile sets none", () => {
    expect(turnSettings(undefined)).toEqual({
      threshold: 200,
      silenceSeconds: 3,
      maxSeconds: HERMES_MAX_RECORDING_SECONDS,
      fromProfile: { threshold: false, silence: false, max: false },
    });
  });

  it("take the profile's numbers, as Hermes's voice mode does", () => {
    const t = turnSettings(setup({ silenceThreshold: 350, silenceDuration: 1.5, maxRecordingSeconds: 60 }));
    expect(t).toMatchObject({ threshold: 350, silenceSeconds: 1.5, maxSeconds: 60, fromProfile: { threshold: true, silence: true, max: true } });
  });

  it("fall back for numbers Hermes wouldn't use, and keep a turn within what Hermes can transcribe", () => {
    const t = turnSettings(setup({ silenceThreshold: -5, silenceDuration: 0, maxRecordingSeconds: 0 }));
    expect(t.threshold).toBe(200);
    expect(t.silenceSeconds).toBe(3);
    // 0 is "no limit" to Hermes; this app still stops at its own Dictation limit.
    expect(t.maxSeconds).toBe(MAX_RECORDING_SECONDS);
    expect(turnSettings(setup({ maxRecordingSeconds: 9_000 })).maxSeconds).toBe(MAX_RECORDING_SECONDS);
    expect(turnSettings(setup({ silenceDuration: 0.01 })).silenceSeconds).toBe(0.5);
    expect(turnSettings(setup({ silenceDuration: 600 })).silenceSeconds).toBe(30);
    expect(turnSettings(setup({ silenceThreshold: Number.NaN })).threshold).toBe(200);
  });
});

describe("rms16", () => {
  it("measures loudness on the 16-bit scale Hermes's threshold uses", () => {
    expect(rms16(new Float32Array(100))).toBe(0);
    expect(rms16(new Float32Array(100).fill(0.5))).toBeCloseTo(16_384);
    expect(rms16(new Float32Array(0))).toBe(0);
  });
});

describe("TurnDetector", () => {
  const settings = turnSettings(setup({ silenceDuration: 1, maxRecordingSeconds: 10 }));

  it("ends a turn after the quiet that follows confirmed speech", () => {
    const d = new TurnDetector(settings);
    expect(feed(d, 0, 2, 50).end).toBeUndefined();
    expect(d.attempting).toBe(false);
    const spoke = feed(d, 2, 1.5, 3000);
    expect(spoke.end).toBeUndefined();
    expect(d.hasSpoken).toBe(true);
    expect(d.startedAt).toBeCloseTo(2.1);
    const quiet = feed(d, spoke.t, 3, 50);
    expect(quiet.end).toBe("silence");
    // The first quiet block, 0.1 s after the last loud one, starts the quiet; a second later the turn ends.
    expect(quiet.at! - spoke.t).toBeCloseTo(1.1, 5);
  });

  it("doesn't take a click shorter than 0.3 s as speech", () => {
    const d = new TurnDetector(settings);
    feed(d, 0, 0.2, 3000);
    expect(d.attempting).toBe(true);
    const after = feed(d, 0.2, 3, 50);
    expect(after.end).toBeUndefined();
    expect(d.hasSpoken).toBe(false);
    expect(d.attempting).toBe(false);
  });

  it("rides out a short pause mid-sentence", () => {
    const d = new TurnDetector(settings);
    let r = feed(d, 0, 1, 3000);
    r = feed(d, r.t, 0.5, 50);
    expect(r.end).toBeUndefined();
    r = feed(d, r.t, 1, 3000);
    r = feed(d, r.t, 0.8, 50);
    expect(r.end).toBeUndefined();
    expect(feed(d, r.t, 1, 50).end).toBe("silence");
  });

  it("stops a turn at its length limit even while the owner keeps talking", () => {
    const d = new TurnDetector(settings);
    const r = feed(d, 0, 20, 3000);
    expect(r.end).toBe("limit");
    expect(r.at).toBeCloseTo(10.1, 1);
  });

  it("starts afresh after reset", () => {
    const d = new TurnDetector(settings);
    feed(d, 0, 1, 3000);
    d.reset();
    expect(d.hasSpoken).toBe(false);
    expect(d.startedAt).toBeUndefined();
    expect(feed(d, 1, 3, 50).end).toBeUndefined();
  });
});

describe("isEcho", () => {
  const reply = "The restic repo was locked. I removed the stale lock, and the backup ran again.";

  it("catches the reply coming back through the microphone", () => {
    expect(isEcho("I removed the stale lock and the backup", reply)).toBe(true);
    expect(isEcho("the restic repo was LOCKED!", reply)).toBe(true);
  });

  it("never drops a short answer or the owner's own words", () => {
    expect(isEcho("yes, go ahead", reply)).toBe(false);
    expect(isEcho("the backup ran", reply)).toBe(false);
    expect(isEcho("check the restic repo was locked", reply)).toBe(false);
    expect(isEcho("unlock the repo and run the backup again", reply)).toBe(false);
    expect(isEcho("I removed the stale lock", undefined)).toBe(false);
  });
});

describe("conversationBlocked", () => {
  it("says why a conversation can't start, for every unsupported case", () => {
    expect(conversationBlocked("reconnecting", setup(), true)).toMatch(/Connect to Hermes/);
    expect(conversationBlocked("connected", undefined, true)).toMatch(/Checking/);
    expect(conversationBlocked("connected", setup({ transcribe: false }), true)).toMatch(/can't transcribe/);
    expect(conversationBlocked("connected", setup({ sttEnabled: false }), true)).toMatch(/stt.enabled is false/);
    expect(conversationBlocked("connected", setup({ speak: false }), true)).toMatch(/can't speak its replies/);
    expect(conversationBlocked("connected", setup(), false)).toMatch(/first message/);
    expect(conversationBlocked("connected", setup(), true)).toBeUndefined();
  });
});
