// Settings → Voice → Speech to text (ADR 0065): where Dictation and voice conversations transcribe, Hermes or this
// computer, and whether the other is the backup; the model on each side; and a Test that records a few seconds and
// runs it through each. Where it runs is kept in the display preferences (uiPrefs.ts); this computer's engine, model
// and language are kept by Rust (src-tauri/src/local_stt.rs) and shown as it reads them back.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, FolderOpen, Mic, Trash2, X } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import type { Transcript, VoiceSetup } from "../hermes/pipe";
import { LANGUAGES, MODEL_NOTES, localBlocked, size, type DownloadProgress, type LocalSttApi, type LocalSttStatus } from "../hermes/localStt";
import { STT_TIMEOUTS, other, type SttPrefs, type SttSide } from "../hermes/sttRoute";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { messageOf, sttProvider } from "../hermes/voice";
import { type AudioEnv, CaptureAborted, type Capture, startCapture } from "./recorder";
import { Spinner } from "./bits";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

const SIDE_LABEL: Record<SttSide, string> = { server: "Hermes server", local: "This computer" };
/** How long Test records. */
export const TEST_SECONDS = 4;

type TestResult = { side: SttSide; ms?: number; text?: string; provider?: string; error?: string; running?: boolean };
type TestState = { phase: "idle" } | { phase: "recording"; capture: Capture; left: number } | { phase: "running" | "done"; results: TestResult[]; note?: string };

export function SpeechToTextSettings({
  local,
  server,
  status,
  setup,
  changes = 0,
  env,
}: {
  local: LocalSttApi;
  /** Hermes's transcribing, without the backup, for Test. */
  server?: (audio: Uint8Array, mime: string) => Promise<Transcript>;
  status: ConnectionStatus;
  /** The profile's voice set-up, to name its speech-to-text provider. */
  setup?: () => Promise<VoiceSetup>;
  changes?: number;
  env?: AudioEnv;
}) {
  const prefs = useSyncExternalStore(subscribe, getUIPrefs).speechToText;
  const [unsaved, setUnsaved] = useState(false);
  const change = (patch: Partial<SttPrefs>) => setUnsaved(!setUIPrefs({ speechToText: { ...prefs, ...patch } }));

  const [here, setHere] = useState<{ status?: LocalSttStatus; error?: string }>({});
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [progress, setProgress] = useState<DownloadProgress>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    local.status().then(
      (s) => mounted.current && setHere({ status: s }),
      (e) => mounted.current && setHere({ error: messageOf(e) }),
    );
    return () => {
      mounted.current = false;
    };
  }, [local]);

  /** Runs a change to this computer's settings; what Rust reads back afterwards is shown. */
  const act = async (label: string, run: () => Promise<LocalSttStatus>) => {
    setBusy(label);
    setProblem(undefined);
    try {
      const s = await run();
      if (mounted.current) setHere({ status: s });
    } catch (e) {
      if (mounted.current) setProblem(messageOf(e));
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const download = (name: string) => {
    setProgress({ name, done: 0, total: here.status?.models.find((m) => m.name === name)?.bytes ?? 0 });
    void act(`download:${name}`, () => local.download(name, (p) => mounted.current && setProgress(p))).finally(() => mounted.current && setProgress(undefined));
  };

  const [serverSetup, setServerSetup] = useState<VoiceSetup>();
  const connected = status === "connected";
  useEffect(() => {
    if (!setup || !connected) return;
    let live = true;
    setup().then(
      (s) => live && setServerSetup(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [setup, connected, changes]);

  const s = here.status;
  const localWhy = here.error ? `Couldn't read this computer's set-up: ${here.error}` : localBlocked(s);
  // "This computer" can't be made the primary until it can run; once it is, it stays picked, and the screen says if it breaks.
  const canPickLocal = !!s?.ready;
  const backupLabel = SIDE_LABEL[other(prefs.primary)];
  const primaryBroken = prefs.primary === "local" && s && !s.ready;

  const segmented = (label: string, choices: { key: string; label: string; on: boolean; why?: string; pick: () => void }[]) => (
    <div className="segmented" role="group" aria-label={label}>
      {choices.map((c) => (
        <button key={c.key} type="button" aria-pressed={c.on} aria-disabled={!!c.why && !c.on} title={c.why} onClick={() => !(c.why && !c.on) && c.pick()}>
          {c.label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <SettingsSection
        title="Speech to text"
        intro="Where Dictation and voice conversations turn what you say into text."
        more={
          <>
            <p>
              <b>Hermes server</b> sends the recording to Hermes, which transcribes it with the profile's speech-to-text provider (under Speech
              providers, below) and deletes its copy once it has the text. A cloud provider gets the recording too.
            </p>
            <p>
              <b>This computer</b> transcribes it here with whisper.cpp and a Whisper model on this computer. The recording never leaves this
              computer: only the text goes to Hermes, as a typed message would. It works without a connection to Hermes, for Dictation.
            </p>
            <p>
              With a <b>backup</b>, the other one transcribes the same recording if the first can't: Hermes isn't reachable, its provider fails,
              there's no model here, or it takes longer than the time you set. The chat then says which one did it and why. A backup on Hermes
              means the recording can leave this computer when this computer fails.
            </p>
          </>
        }
      >
        <SettingRow
          name="Primary"
          nameId="stt-primary"
          hint={
            prefs.primary === "local"
              ? "Transcribed here. The recording never leaves this computer."
              : "Transcribed by Hermes with the profile's speech-to-text provider."
          }
          control={segmented("Primary speech-to-text", [
            { key: "server", label: SIDE_LABEL.server, on: prefs.primary === "server", pick: () => change({ primary: "server" }) },
            {
              key: "local",
              label: SIDE_LABEL.local,
              on: prefs.primary === "local",
              why: canPickLocal ? undefined : `Set up whisper.cpp and a model below first. ${localWhy ?? ""}`.trim(),
              pick: () => change({ primary: "local" }),
            },
          ])}
        >
          {primaryBroken && (
            <SettingNote tone="warn" role="status">
              This computer can't transcribe now: {s?.why}
              {prefs.backup ? " Hermes, the backup, is used until it can." : " Dictation will fail until it can, or until you pick Hermes."}
            </SettingNote>
          )}
        </SettingRow>
        <SettingRow
          name="Backup"
          nameId="stt-backup"
          hint={
            prefs.backup
              ? prefs.primary === "local"
                ? "If this computer can't, the recording goes to Hermes instead."
                : "If Hermes can't, this computer transcribes it instead."
              : "If the primary can't transcribe, Dictation says why and keeps the recording to try again."
          }
          control={segmented("Backup speech-to-text", [
            { key: "none", label: "None", on: !prefs.backup, pick: () => change({ backup: false }) },
            { key: "other", label: backupLabel, on: prefs.backup, pick: () => change({ backup: true }) },
          ])}
        />
        {prefs.backup && (
          <SettingRow
            name="Switch to the backup after"
            nameId="stt-timeout"
            hint={`If ${prefs.primary === "local" ? "this computer" : "Hermes"} hasn't answered by then, the backup transcribes the recording and a late answer is dropped.`}
            control={
              <select className="select" aria-labelledby="stt-timeout" value={prefs.timeoutSeconds} onChange={(e) => change({ timeoutSeconds: Number(e.target.value) })}>
                {(STT_TIMEOUTS as readonly number[]).includes(prefs.timeoutSeconds) ? null : <option value={prefs.timeoutSeconds}>{prefs.timeoutSeconds} s</option>}
                {STT_TIMEOUTS.map((t) => (
                  <option key={t} value={t}>
                    {t} seconds
                  </option>
                ))}
              </select>
            }
          />
        )}
        <SettingRow
          name="On Hermes"
          hint={
            !connected
              ? "Connect to Hermes to see the profile's provider."
              : serverSetup
                ? `${sttProvider(serverSetup).needs} Pick the provider and its model under Speech providers, below.`
                : "Reading the profile's provider…"
          }
          control={serverSetup && connected ? <span className="badge">{sttProvider(serverSetup).label}</span> : undefined}
        />
        <TestRow local={local} server={server} connected={connected} localReady={!!s?.ready} env={env} />
        {unsaved && (
          <SettingNote tone="bad" role="alert">
            Couldn't save this on this computer; it applies only until Hermes Chat closes.
          </SettingNote>
        )}
      </SettingsSection>

      <SettingsSection
        title="Speech to text on this computer"
        intro="whisper.cpp and a Whisper model, run here. Nothing is sent anywhere."
        more={
          <p>
            Hermes Chat runs whisper.cpp's <span className="mono">whisper-cli</span>: the one you pick, or else the first on your PATH. On Arch, install
            the <span className="mono">whisper.cpp</span> package (or build it from github.com/ggml-org/whisper.cpp). Models download from whisper.cpp's own
            repository and are checked against their published checksum before they're used. The recording is written to a private temp file for
            whisper.cpp to read and deleted as soon as it's done.
          </p>
        }
      >
        {here.error ? (
          <SettingNote tone="bad" role="alert">
            Couldn't read this computer's set-up: {here.error}
          </SettingNote>
        ) : !s ? (
          <SettingNote>
            <Spinner /> Looking for whisper.cpp…
          </SettingNote>
        ) : (
          <>
            <SettingRow
              name="whisper.cpp"
              hint={
                s.engine ? (
                  <>
                    <span className="mono">{s.engine.path}</span>
                    {s.engine.version ? ` · version ${s.engine.version}` : ""}
                    {s.engine.picked ? " · picked by you" : " · found on PATH"}
                  </>
                ) : s.pickedEngineMissing ? (
                  <>
                    The program you picked can't be run any more: <span className="mono">{s.pickedEngineMissing}</span>
                  </>
                ) : (
                  "Not installed: no whisper-cli on PATH. Install whisper.cpp, or pick its whisper-cli program."
                )
              }
              control={
                <div className="stt-actions">
                  <button className="btn" disabled={!!busy} onClick={() => void act("pick-engine", () => local.pick("engine"))}>
                    <FolderOpen size={13} /> Pick program…
                  </button>
                  {(s.engine?.picked || s.pickedEngineMissing) && (
                    <button className="btn" disabled={!!busy} onClick={() => void act("forget-engine", () => local.forget("engine"))}>
                      Use PATH
                    </button>
                  )}
                </div>
              }
            />
            {s.models.map((m) => {
              const inUse = !s.modelFile && s.model === m.name;
              const downloading = s.downloading?.name === m.name || busy === `download:${m.name}`;
              const p = progress?.name === m.name ? progress : s.downloading?.name === m.name ? s.downloading : undefined;
              return (
                <SettingRow
                  key={m.name}
                  className="stt-model"
                  name={
                    <>
                      Model <span className="mono">{m.name}</span>
                      {inUse && <span className="badge">In use</span>}
                    </>
                  }
                  about={`the ${m.name} model`}
                  hint={`${size(m.bytes)} · ${MODEL_NOTES[m.name] ?? ""} · ${m.downloaded ? "Downloaded" : "Not downloaded"}`}
                  control={
                    <div className="stt-actions">
                      {!inUse && (
                        <button className="btn" disabled={!!busy} onClick={() => void act(`use:${m.name}`, () => local.set({ model: m.name }))} aria-label={`Use the ${m.name} model`}>
                          Use
                        </button>
                      )}
                      {downloading ? (
                        <button className="btn" onClick={() => void local.cancelDownload()} aria-label={`Cancel the ${m.name} download`}>
                          <X size={13} /> Cancel
                        </button>
                      ) : m.downloaded ? (
                        <button className="btn" disabled={!!busy} onClick={() => void act(`delete:${m.name}`, () => local.remove(m.name))} aria-label={`Delete the ${m.name} model`}>
                          <Trash2 size={13} /> Delete
                        </button>
                      ) : (
                        <button className="btn" disabled={!!busy} onClick={() => download(m.name)} aria-label={`Download the ${m.name} model`}>
                          <Download size={13} /> Download
                        </button>
                      )}
                    </div>
                  }
                >
                  {downloading && p && (
                    <div className="stt-progress" role="progressbar" aria-label={`Downloading the ${m.name} model`} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
                      <span style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} />
                      <small>
                        {size(p.done)} of {size(p.total)}
                      </small>
                    </div>
                  )}
                </SettingRow>
              );
            })}
            <SettingRow
              name="Your own model file"
              hint={
                s.modelFile ? (
                  <>
                    <span className="mono">{s.modelFile.path}</span>
                    {s.modelFile.bytes === undefined ? " · not there any more" : ` · ${size(s.modelFile.bytes)} · used instead of the sizes above`}
                  </>
                ) : (
                  "A Whisper model in ggml format (.bin) you already have, used instead of a downloaded one."
                )
              }
              control={
                <div className="stt-actions">
                  <button className="btn" disabled={!!busy} onClick={() => void act("pick-model", () => local.pick("model"))}>
                    <FolderOpen size={13} /> Pick file…
                  </button>
                  {s.modelFile && (
                    <button className="btn" disabled={!!busy} onClick={() => void act("forget-model", () => local.forget("model"))}>
                      Stop using it
                    </button>
                  )}
                </div>
              }
            />
            <SettingRow
              name="Language"
              nameId="stt-language"
              hint="What you'll speak. Detect it works for any language, a little slower."
              control={
                <select className="select" aria-labelledby="stt-language" value={s.language} disabled={!!busy} onChange={(e) => void act("language", () => local.set({ language: e.target.value }))}>
                  {LANGUAGES.some((l) => l.code === s.language) ? null : <option value={s.language}>{s.language}</option>}
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              }
            />
            <SettingRow name="Stored in" hint={<span className="mono">{s.modelsDir}</span>} />
            <SettingNote tone={s.ready ? "muted" : "warn"} role="status">
              {s.ready ? "Ready: this computer can transcribe." : `Not ready: ${s.why}`}
            </SettingNote>
          </>
        )}
        {problem && (
          <SettingNote tone="bad" role="alert">
            {problem}
          </SettingNote>
        )}
      </SettingsSection>
    </>
  );
}

/** Test: records a few seconds, then has each side that can transcribe it, one after the other, timing each. */
function TestRow({
  local,
  server,
  connected,
  localReady,
  env,
}: {
  local: LocalSttApi;
  server?: (audio: Uint8Array, mime: string) => Promise<Transcript>;
  connected: boolean;
  localReady: boolean;
  env?: AudioEnv;
}) {
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const live = useRef<{ capture?: Capture; abort?: AbortController; turn: number }>({ turn: 0 });
  useEffect(() => {
    const now = live.current;
    return () => {
      now.turn++;
      now.abort?.abort();
      now.capture?.cancel();
    };
  }, []);

  const run = async () => {
    const turn = ++live.current.turn;
    const abort = new AbortController();
    live.current.abort = abort;
    let capture: Capture;
    try {
      capture = await startCapture(
        (why) => turn === live.current.turn && setTest({ phase: "done", results: [], note: why }),
        abort.signal,
        env,
      );
    } catch (e) {
      if (turn === live.current.turn && !(e instanceof CaptureAborted)) setTest({ phase: "done", results: [], note: messageOf(e) });
      return;
    }
    if (turn !== live.current.turn) return capture.cancel();
    live.current.capture = capture;
    setTest({ phase: "recording", capture, left: TEST_SECONDS });
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        if (turn !== live.current.turn) {
          clearInterval(id);
          return resolve();
        }
        const left = Math.max(0, TEST_SECONDS - capture.seconds());
        setTest({ phase: "recording", capture, left });
        if (left <= 0) {
          clearInterval(id);
          resolve();
        }
      }, 200);
    });
    if (turn !== live.current.turn) return;
    live.current.capture = undefined;
    const recording = capture.stop();
    const sides: { side: SttSide; go?: () => Promise<Transcript>; why?: string }[] = [
      { side: "server", go: server && connected ? () => server(recording.audio, recording.mime) : undefined, why: "Not connected to Hermes." },
      { side: "local", go: localReady ? () => local.transcribe(recording.audio, 120) : undefined, why: "whisper.cpp or a model isn't set up here." },
    ];
    const results: TestResult[] = sides.map((s) => (s.go ? { side: s.side, running: true } : { side: s.side, error: s.why }));
    setTest({ phase: "running", results: [...results] });
    for (const [i, s] of sides.entries()) {
      if (!s.go) continue;
      const started = performance.now();
      try {
        const got = await s.go();
        results[i] = { side: s.side, ms: performance.now() - started, text: got.text, provider: got.provider };
      } catch (e) {
        results[i] = { side: s.side, ms: performance.now() - started, error: messageOf(e) };
      }
      if (turn !== live.current.turn) return;
      setTest({ phase: i === sides.length - 1 ? "done" : "running", results: [...results] });
    }
    setTest({ phase: "done", results: [...results] });
  };

  const cancel = () => {
    live.current.turn++;
    live.current.abort?.abort();
    live.current.capture?.cancel();
    live.current.capture = undefined;
    setTest({ phase: "idle" });
  };

  return (
    <SettingRow
      name="Test"
      hint={`Records ${TEST_SECONDS} seconds, then transcribes it on Hermes and on this computer, and shows what each heard and how long it took.`}
      control={
        test.phase === "recording" || test.phase === "running" ? (
          <button className="btn" onClick={cancel}>
            <X size={13} /> Cancel
          </button>
        ) : (
          <button className="btn" onClick={() => void run()}>
            <Mic size={13} /> Test
          </button>
        )
      }
    >
      {test.phase === "recording" && (
        <SettingNote role="status">
          <span className="rec-dot" aria-hidden /> Recording: say something. {Math.ceil(test.left)} s left…
        </SettingNote>
      )}
      {(test.phase === "running" || test.phase === "done") && (
        <div className="stt-test" role="status">
          {test.note && <p className="set-note bad">{test.note}</p>}
          {test.results.map((r) => (
            <div key={r.side} className="stt-test-row">
              <b>{SIDE_LABEL[r.side]}</b>
              {r.running ? (
                <span>
                  <Spinner /> Transcribing…
                </span>
              ) : r.error ? (
                <span className="bad">{r.error}</span>
              ) : (
                <span>{r.text ? `“${r.text}”` : "Heard no speech."}</span>
              )}
              {r.ms !== undefined && (
                <span className="muted">
                  {(r.ms / 1000).toFixed(1)} s{r.provider ? ` · ${r.provider}` : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingRow>
  );
}
