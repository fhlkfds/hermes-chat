import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STT_PREFS, LOCAL_MAX_SECONDS, SttFailed, fellBackNote, toSttPrefs, transcribeRouted, type SttPrefs, type SttRunner } from "./sttRoute";
import { DEFAULT_UI_PREFS, readUIPrefs } from "./uiPrefs";

const audio = new Uint8Array([1, 2, 3]);
const said = (text: string, provider?: string): SttRunner => vi.fn(async () => ({ text, provider }));
const fails = (why: string): SttRunner => vi.fn(async () => {
  throw new Error(why);
});
const never: SttRunner = vi.fn(() => new Promise<never>(() => {}));
const prefs = (p: Partial<SttPrefs>): SttPrefs => ({ ...DEFAULT_STT_PREFS, ...p });

describe("where speech-to-text runs", () => {
  it("uses only the primary when there's no backup, however long it takes", async () => {
    const server = said("hello", "local");
    const local = said("not me");
    const got = await transcribeRouted(prefs({ primary: "server" }), { server, local }, audio, "audio/wav");
    expect(got).toEqual({ text: "hello", provider: "local", ran: "server" });
    expect(server).toHaveBeenCalledWith(audio, "audio/wav", LOCAL_MAX_SECONDS);
    expect(local).not.toHaveBeenCalled();
  });

  it("says what failed when the primary fails and there's no backup, and never tries the other side", async () => {
    const local = fails("The base model isn't downloaded yet.");
    const server = said("should not run");
    const err = await transcribeRouted(prefs({ primary: "local" }), { server, local }, audio, "audio/wav").catch((e) => e);
    expect(err).toBeInstanceOf(SttFailed);
    expect(err.message).toBe("This computer couldn't transcribe it: The base model isn't downloaded yet.");
    expect(server).not.toHaveBeenCalled();
  });

  it("falls back to this computer when Hermes can't be reached or its provider fails, and says so", async () => {
    for (const why of ["Not connected to Hermes.", "Hermes couldn't transcribe the recording: GROQ_API_KEY is not set"]) {
      const got = await transcribeRouted(prefs({ primary: "server", backup: true }), { server: fails(why), local: said("hola", "whisper.cpp (base)") }, audio, "audio/wav");
      expect(got.ran).toBe("local");
      expect(got.text).toBe("hola");
      expect(got.fellBack?.from).toBe("server");
      expect(fellBackNote(got)).toMatch(/^Transcribed on this computer\. Hermes couldn't transcribe it: /);
    }
    const got = await transcribeRouted(
      prefs({ primary: "server", backup: true }),
      { server: fails("Hermes couldn't transcribe the recording: GROQ_API_KEY is not set"), local: said("x") },
      audio,
      "audio/wav",
    );
    // The transport's own "couldn't transcribe" prefix isn't said twice.
    expect(fellBackNote(got)).toBe("Transcribed on this computer. Hermes couldn't transcribe it: GROQ_API_KEY is not set.");
  });

  it("falls back to Hermes when this computer has no model", async () => {
    const got = await transcribeRouted(
      prefs({ primary: "local", backup: true }),
      { server: said("hi there", "groq"), local: fails("The small model isn't downloaded yet.") },
      audio,
      "audio/wav",
    );
    expect(got).toEqual({ text: "hi there", provider: "groq", ran: "server", fellBack: { from: "local", why: "The small model isn't downloaded yet." } });
    expect(fellBackNote(got)).toBe("Transcribed on Hermes. This computer couldn't transcribe it: The small model isn't downloaded yet.");
  });

  it("gives the primary the timeout when there's a backup, then runs the backup and drops the late answer", async () => {
    vi.useFakeTimers();
    try {
      const local = said("from here");
      const run = transcribeRouted(prefs({ primary: "server", backup: true, timeoutSeconds: 20 }), { server: never, local }, audio, "audio/wav");
      await vi.advanceTimersByTimeAsync(19_999);
      expect(local).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const got = await run;
      expect(got.ran).toBe("local");
      expect(got.fellBack).toEqual({ from: "server", why: "It took longer than 20 s." });
      // The backup gets as long as it takes; this computer stops itself at the most.
      expect(local).toHaveBeenCalledWith(audio, "audio/wav", LOCAL_MAX_SECONDS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the timeout to this computer as primary, so it stops itself too", async () => {
    const local = said("ok");
    await transcribeRouted(prefs({ primary: "local", backup: true, timeoutSeconds: 10 }), { server: said("no"), local }, audio, "audio/wav");
    expect(local).toHaveBeenCalledWith(audio, "audio/wav", 10);
  });

  it("takes hearing no speech as an answer, not a failure", async () => {
    const server = said("");
    const got = await transcribeRouted(prefs({ primary: "local", backup: true }), { server, local: said("") }, audio, "audio/wav");
    expect(got).toEqual({ text: "", provider: undefined, ran: "local" });
    expect(server).not.toHaveBeenCalled();
    expect(fellBackNote(got)).toBeUndefined();
  });

  it("says what each side said when both fail", async () => {
    const err = await transcribeRouted(
      prefs({ primary: "server", backup: true }),
      { server: fails("Not connected to Hermes."), local: fails("whisper.cpp exited with code 2: error: failed to open model") },
      audio,
      "audio/wav",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SttFailed);
    expect(err.tried.map((t: { side: string }) => t.side)).toEqual(["server", "local"]);
    expect(err.message).toBe(
      "Hermes couldn't transcribe it: Not connected to Hermes. This computer couldn't transcribe it either: whisper.cpp exited with code 2: error: failed to open model.",
    );
  });
});

describe("the speech-to-text choice as kept on this computer", () => {
  it("defaults to Hermes with no backup", () => {
    expect(readUIPrefs({}).speechToText).toEqual({ primary: "server", backup: false, timeoutSeconds: 30 });
  });

  it("reads back what was stored, and takes each bad field from the defaults", () => {
    const stored = { primary: "local", backup: true, timeoutSeconds: 60 };
    expect(readUIPrefs(JSON.parse(JSON.stringify({ speechToText: stored }))).speechToText).toEqual(stored);
    expect(toSttPrefs({ primary: "cloud", backup: "yes", timeoutSeconds: 2 })).toEqual(DEFAULT_STT_PREFS);
    expect(toSttPrefs({ primary: "local", timeoutSeconds: 10.5 })).toEqual({ ...DEFAULT_STT_PREFS, primary: "local" });
    expect(toSttPrefs([])).toBeUndefined();
    expect(readUIPrefs({ speechToText: "local" }).speechToText).toEqual(DEFAULT_UI_PREFS.speechToText);
  });
});
