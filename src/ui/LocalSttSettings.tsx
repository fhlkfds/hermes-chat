// Settings → Voice → Speech to text: where Dictation and voice conversations turn speech into text, on the Hermes
// server or with an engine already installed on this computer (ADR 0062), and a Test that records a few seconds.
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Mic } from "lucide-react";
import type { Transcript } from "../hermes/pipe";
import { baseName, type FoundEngine, type LocalSttApi, type LocalSttState } from "../hermes/localStt";
import { messageOf } from "../hermes/voice";
import { arrowSelect, Spinner } from "./bits";
import { startCapture, type AudioEnv, type Capture } from "./recorder";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

/** How long the Test records. */
export const TEST_SECONDS = 5;

type Test =
  | { phase: "recording"; capture: Capture }
  | { phase: "transcribing" }
  | { phase: "done"; text: string; ms: number; by: string }
  | { phase: "failed"; why: string };

export function LocalSttSettings({
  api,
  transcribe,
  connected,
  env,
}: {
  api: LocalSttApi;
  /** The app's own path for a recording, the one Dictation takes: Rust sends it to Hermes or runs the local engine. */
  transcribe?: (audio: Uint8Array, mime: string) => Promise<Transcript>;
  connected: boolean;
  env?: AudioEnv;
}) {
  const [state, setState] = useState<LocalSttState>();
  const [found, setFound] = useState<FoundEngine[]>();
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<Test>();
  const live = useRef({ run: 0, capture: undefined as Capture | undefined });

  useEffect(() => {
    api.state().then(setState, (e) => setError(messageOf(e)));
    const now = live.current;
    return () => {
      now.run++;
      now.capture?.cancel();
    };
  }, [api]);
  const local = !!state?.onThisComputer;
  useEffect(() => {
    if (local && !found) api.detect().then(setFound, (e) => setError(messageOf(e)));
  }, [local, found, api]);

  /** Drops any Test under way, closing its microphone, so a newer one or a change can't leave it open. */
  const stopTest = () => {
    live.current.run++;
    live.current.capture?.cancel();
    live.current.capture = undefined;
    setTest(undefined);
  };

  const act = (p: Promise<LocalSttState | undefined>) => {
    setError(undefined);
    stopTest();
    p.then((s) => s && setState(s), (e) => setError(messageOf(e)));
  };

  const runTest = async () => {
    if (!transcribe) return;
    stopTest();
    const run = live.current.run;
    const fail = (why: string) => run === live.current.run && setTest({ phase: "failed", why });
    try {
      const capture = await startCapture(fail, undefined, env);
      if (run !== live.current.run) return capture.cancel();
      live.current.capture = capture;
      setTest({ phase: "recording", capture });
      await new Promise((r) => setTimeout(r, TEST_SECONDS * 1000));
      if (run !== live.current.run) return capture.cancel();
      live.current.capture = undefined;
      const recording = capture.stop();
      setTest({ phase: "transcribing" });
      const started = performance.now();
      const got = await transcribe(recording.audio, recording.mime);
      if (run !== live.current.run) return;
      setTest({ phase: "done", text: got.text, ms: performance.now() - started, by: got.provider ?? (local ? "this computer" : "Hermes") });
    } catch (e) {
      fail(messageOf(e));
    }
  };

  const engine = state?.engine ?? undefined;
  // The chosen program may have been picked in a dialog rather than found on PATH; it is offered too.
  const programs = [...(found ?? [])];
  if (engine && !programs.some((f) => f.binary === engine.binary)) programs.push({ kind: engine.kind, label: state?.label ?? engine.kind, binary: engine.binary, models: [] });
  const current = programs.find((f) => f.binary === engine?.binary);
  const models = [...(current?.models ?? [])];
  if (engine?.model && !models.includes(engine.model)) models.push(engine.model);
  const choose = (binary: string, model?: string) => {
    const f = programs.find((p) => p.binary === binary);
    if (f) act(api.set(true, { kind: f.kind, binary, model: model ?? (binary === engine?.binary ? engine.model : f.models[0]) ?? null }));
  };
  const where = (on: boolean) => on !== local && act(api.set(on));

  return (
    <SettingsSection
      title="Speech to text"
      intro="Where Dictation and voice conversations turn what you say into text."
      more={
        <>
          <p>
            On the Hermes server, each recording goes to Hermes, which transcribes it with the profile's speech-to-text provider under Speech providers,
            below.
          </p>
          <p>
            On this computer, Hermes Chat runs a speech-to-text engine that's already installed here: whisper.cpp (whisper-cli), faster-whisper
            (whisper-ctranslate2), OpenAI Whisper or Vosk, with a model you already have. Nothing is downloaded. The recording is written to a private
            temporary folder, transcribed, and deleted; it never leaves this computer, and only the text goes to Hermes, when you send it. The engine is
            stopped if it takes much longer than the recording. This choice is kept on this computer, for every connection and profile.
          </p>
        </>
      }
    >
      {error && (
        <SettingNote tone="bad" role="alert">
          {error}
        </SettingNote>
      )}
      {!state ? (
        !error && (
          <SettingNote>
            <Spinner /> Reading the speech-to-text setting…
          </SettingNote>
        )
      ) : (
        <>
          <SettingRow
            name="Where it runs"
            hint={local ? "The recording never leaves this computer. Only the text goes to Hermes." : "Recordings go to Hermes, which transcribes them."}
            control={
              <div className="out-scopes" role="radiogroup" aria-label="Where speech to text runs" onKeyDown={(e) => arrowSelect(e, [false, true], local, where)}>
                {(
                  [
                    [false, "Hermes server"],
                    [true, "This computer"],
                  ] as const
                ).map(([on, label]) => (
                  <button key={label} role="radio" aria-checked={local === on} tabIndex={local === on ? 0 : -1} className={`out-scope ${local === on ? "on" : ""}`} onClick={() => where(on)}>
                    {label}
                  </button>
                ))}
              </div>
            }
          />
          {local &&
            (!found ? (
              <SettingNote>
                <Spinner /> Looking for speech-to-text engines on this computer…
              </SettingNote>
            ) : (
              <>
                <SettingRow
                  name="Engine"
                  hint={
                    current ? (
                      <>
                        <span className="mono">{current.binary}</span>
                        {current.version ? ` · ${current.version}` : ""}
                      </>
                    ) : programs.length ? (
                      "Pick one of the engines found."
                    ) : (
                      "None installed."
                    )
                  }
                  control={
                    <>
                      {programs.length > 0 && (
                        <select aria-label="Engine" value={engine?.binary ?? ""} onChange={(e) => choose(e.target.value)}>
                          {!engine && <option value="">Choose…</option>}
                          {programs.map((p) => (
                            <option key={p.binary} value={p.binary}>
                              {p.label} ({baseName(p.binary)})
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="btn" onClick={() => act(api.pickProgram())} title="Point at an engine's program, such as whisper-cli">
                        <FolderOpen size={13} aria-hidden /> Choose a program…
                      </button>
                    </>
                  }
                />
                {engine && (
                  <SettingRow
                    name="Model"
                    hint={engine.model ? <span className="mono">{engine.model}</span> : models.length ? "Pick a model." : "No model was found in the usual folders."}
                    control={
                      <>
                        {models.length > 0 && (
                          <select aria-label="Model" value={engine.model ?? ""} onChange={(e) => choose(engine.binary, e.target.value)}>
                            {!engine.model && <option value="">Choose…</option>}
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {baseName(m)}
                              </option>
                            ))}
                          </select>
                        )}
                        <button className="btn" onClick={() => act(api.pickModel())}>
                          <FolderOpen size={13} aria-hidden /> Choose a model…
                        </button>
                      </>
                    }
                  />
                )}
                {!programs.length && (
                  <SettingNote>
                    None installed. Install one, then open this tab again: for example whisper.cpp (<span className="mono">whisper-cli</span>) with a
                    model such as <span className="mono">ggml-base.en.bin</span> in <span className="mono">~/.local/share/whisper.cpp</span>. Or point at
                    a program and model you already have with Choose a program.
                  </SettingNote>
                )}
                {state.problem && programs.length > 0 && (
                  <SettingNote tone="warn" role="status">
                    {state.problem} Until then, Dictation and voice conversations can't transcribe; nothing is sent to Hermes instead.
                  </SettingNote>
                )}
              </>
            ))}
          <SettingRow
            name="Test"
            hint={`Records ${TEST_SECONDS} seconds, then shows the text and how long it took.`}
            control={
              <button
                className="btn"
                disabled={!transcribe || !connected || test?.phase === "recording" || test?.phase === "transcribing"}
                title={!connected ? "Connect to Hermes first" : undefined}
                onClick={() => void runTest()}
              >
                <Mic size={13} aria-hidden /> Test
              </button>
            }
          >
            {test?.phase === "recording" && (
              <SettingNote role="status">
                <span className="rec-dot" aria-hidden /> Recording… say something.
              </SettingNote>
            )}
            {test?.phase === "transcribing" && (
              <SettingNote role="status">
                <Spinner /> Transcribing…
              </SettingNote>
            )}
            {test?.phase === "done" && (
              <SettingNote role="status">
                {test.text ? <>“{test.text}”</> : "No speech was heard."} {(test.ms / 1000).toFixed(1)} s, by {test.by}.
              </SettingNote>
            )}
            {test?.phase === "failed" && (
              <SettingNote tone="bad" role="alert">
                {test.why}
              </SettingNote>
            )}
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}
