// A stand-in for speech-to-text on this computer (src-tauri/src/local_stt.rs), for tests. It follows Rust's rules: a
// model size must be one of the five, a language `auto` or a short code, "ready" only with an engine and a downloaded
// (or picked) model, and every change answers the status as read back.
import type { DownloadProgress, LocalSttApi, LocalSttStatus } from "./localStt";
import type { Transcript } from "./pipe";

export const FAKE_MODELS = [
  { name: "tiny", bytes: 77_691_713 },
  { name: "base", bytes: 147_951_465 },
  { name: "small", bytes: 487_601_967 },
  { name: "medium", bytes: 1_533_763_059 },
  { name: "large-v3", bytes: 3_095_033_483 },
];

export class FakeLocalStt implements LocalSttApi {
  engine?: { path: string; picked: boolean; version?: string } = { path: "/usr/bin/whisper-cli", picked: false, version: "1.9.5" };
  model = "base";
  language = "auto";
  downloaded = new Set<string>();
  modelFile?: { path: string; bytes?: number };
  modelsDir = "/home/liam/.local/share/hermes-chat/whisper-models";
  /** What the next transcription hears, or the error it fails with. */
  heard: string | Error = "Check the backup logs";
  /** Holds every transcription until it resolves. */
  gate?: Promise<void>;
  /** Holds a download until it resolves. */
  downloadGate?: Promise<void>;
  /** What the next file pick returns; undefined: the owner cancels. */
  picks: { engine?: string; model?: string } = {};
  recordings: { audio: Uint8Array; timeoutSeconds: number }[] = [];
  sets: { model?: string; language?: string }[] = [];
  private downloading?: DownloadProgress;
  private cancelled = false;

  snapshot(): LocalSttStatus {
    const modelThere = this.modelFile ? this.modelFile.bytes !== undefined : this.downloaded.has(this.model);
    const why = !this.engine
      ? "whisper.cpp isn't installed on this computer (no whisper-cli on PATH)."
      : !modelThere
        ? this.modelFile
          ? `The model file you picked (${this.modelFile.path}) isn't there any more.`
          : `The ${this.model} model isn't downloaded yet.`
        : undefined;
    return {
      model: this.model,
      language: this.language,
      models: FAKE_MODELS.map((m) => ({ ...m, downloaded: this.downloaded.has(m.name) })),
      modelsDir: this.modelsDir,
      ...(this.modelFile && { modelFile: { ...this.modelFile } }),
      ...(this.engine && { engine: { ...this.engine } }),
      ...(this.downloading && { downloading: { ...this.downloading } }),
      ready: !why,
      ...(why && { why }),
    };
  }

  status = async () => this.snapshot();

  set = async (change: { model?: string; language?: string }) => {
    this.sets.push(change);
    if (change.model !== undefined && !FAKE_MODELS.some((m) => m.name === change.model)) throw new Error(`There's no Whisper model called ${change.model}.`);
    if (change.language !== undefined && !/^(auto|[a-z]{2,3})$/.test(change.language)) throw new Error("The language must be auto or a code such as en or es.");
    if (change.model !== undefined) this.model = change.model;
    if (change.language !== undefined) this.language = change.language;
    return this.snapshot();
  };

  pick = async (what: "engine" | "model") => {
    const path = this.picks[what];
    if (path && what === "engine") this.engine = { path, picked: true, version: "1.9.5" };
    if (path && what === "model") this.modelFile = { path, bytes: 1234 };
    return this.snapshot();
  };

  forget = async (what: "engine" | "model") => {
    if (what === "engine") this.engine = { path: "/usr/bin/whisper-cli", picked: false, version: "1.9.5" };
    else this.modelFile = undefined;
    return this.snapshot();
  };

  download = async (name: string, onProgress: (p: DownloadProgress) => void) => {
    const total = FAKE_MODELS.find((m) => m.name === name)!.bytes;
    if (this.downloading) throw new Error(`The ${this.downloading.name} model is downloading already.`);
    this.cancelled = false;
    this.downloading = { name, done: Math.round(total / 2), total };
    onProgress({ ...this.downloading });
    await this.downloadGate;
    this.downloading = undefined;
    if (this.cancelled) throw new Error("Cancelled.");
    this.downloaded.add(name);
    onProgress({ name, done: total, total });
    return this.snapshot();
  };

  cancelDownload = async () => {
    this.cancelled = true;
  };

  remove = async (name: string) => {
    this.downloaded.delete(name);
    return this.snapshot();
  };

  transcribe = async (audio: Uint8Array, timeoutSeconds: number): Promise<Transcript> => {
    this.recordings.push({ audio, timeoutSeconds });
    await this.gate;
    const s = this.snapshot();
    if (!s.ready) throw new Error(s.why);
    if (this.heard instanceof Error) throw this.heard;
    return { text: this.heard, provider: `whisper.cpp (${this.modelFile ? "mine.bin" : this.model})` };
  };
}
