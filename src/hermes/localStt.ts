// Speech-to-text on this computer, as the webview sees it (src-tauri/src/local_stt.rs, ADR 0065): whisper.cpp found on
// PATH or picked by the owner, and a Whisper model downloaded into the app's data folder or picked as a file. Rust runs
// it, so the recording never leaves the computer; only the text comes back.

import type { Transcript } from "./pipe";

export type LocalModel = { name: string; bytes: number; downloaded: boolean };
export type DownloadProgress = { name: string; done: number; total: number };

/** What Rust says about speech-to-text here. `ready`: an engine and a model are there; `why`: what's missing if not. */
export type LocalSttStatus = {
  model: string;
  language: string;
  models: LocalModel[];
  modelsDir: string;
  modelFile?: { path: string; bytes?: number };
  engine?: { path: string; picked: boolean; version?: string };
  pickedEngineMissing?: string;
  downloading?: DownloadProgress;
  ready: boolean;
  why?: string;
};

export type LocalSttApi = {
  status: () => Promise<LocalSttStatus>;
  /** Saves the model size and/or language, and answers the status read back after. */
  set: (change: { model?: string; language?: string }) => Promise<LocalSttStatus>;
  /** Opens the native Open dialog for the whisper.cpp program or a model file. Cancelling changes nothing. */
  pick: (what: "engine" | "model") => Promise<LocalSttStatus>;
  /** Forgets the picked program or model file (the file itself stays). */
  forget: (what: "engine" | "model") => Promise<LocalSttStatus>;
  download: (name: string, onProgress: (p: DownloadProgress) => void) => Promise<LocalSttStatus>;
  cancelDownload: () => Promise<void>;
  remove: (name: string) => Promise<LocalSttStatus>;
  /** Transcribes a WAV recording here, stopped after `timeoutSeconds`. */
  transcribe: (audio: Uint8Array, timeoutSeconds: number) => Promise<Transcript>;
};

/** The Whisper sizes, as Settings → Voice describes them. */
export const MODEL_NOTES: Record<string, string> = {
  tiny: "Fastest, least accurate",
  base: "Fast, good for clear speech",
  small: "Slower, more accurate",
  medium: "Slow without a fast CPU",
  "large-v3": "Most accurate, needs a fast computer",
};

/** Languages offered by name; any other Whisper code can be typed. */
export const LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "auto", label: "Detect it" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
];

/** "75 MB", "1.5 GB". */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Why "This computer" can't be used now, or undefined. */
export function localBlocked(status: LocalSttStatus | undefined): string | undefined {
  if (!status) return "Speech-to-text on this computer isn't available.";
  return status.ready ? undefined : status.why ?? "Speech-to-text isn't set up on this computer.";
}
