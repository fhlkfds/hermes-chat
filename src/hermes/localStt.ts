// Speech to text on this computer (#220, ADR 0062). Rust finds the engines, keeps the choice in the app's config folder,
// and runs the engine inside `hermes_transcribe` when "This computer" is chosen (src-tauri/src/local_stt.rs), so a
// recording can't reach Hermes then. The webview only picks among what Rust found, or has Rust open a file dialog.
import { invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";

export type LocalSttKind = "whisper-cpp" | "faster-whisper" | "openai-whisper" | "vosk";
export type LocalEngine = { kind: LocalSttKind; binary: string; model?: string | null };

/** The choice: `onThisComputer` false means Hermes transcribes. `problem`: why the engine can't run now. */
export type LocalSttState = { onThisComputer: boolean; engine?: LocalEngine | null; label?: string | null; problem?: string | null };

/** An engine found on PATH, its `--version` line if it gave one, and the models found in its usual folders. */
export type FoundEngine = { kind: LocalSttKind; label: string; binary: string; version?: string | null; models: string[] };

export type LocalSttApi = {
  state: () => Promise<LocalSttState>;
  detect: () => Promise<FoundEngine[]>;
  /** `engine`: one found by `detect` (or the one already chosen), or absent to keep the current one. */
  set: (onThisComputer: boolean, engine?: LocalEngine) => Promise<LocalSttState>;
  /** The native Open dialog for an engine's program, or its model. Undefined: cancelled. */
  pickProgram: () => Promise<LocalSttState | undefined>;
  pickModel: () => Promise<LocalSttState | undefined>;
  /** Calls `fn` after every change made here; returns its unsubscribe. */
  onChange: (fn: () => void) => () => void;
};

const listeners = new Set<() => void>();
const changed = <T>(v: T) => {
  for (const fn of listeners) fn();
  return v;
};

export const tauriLocalStt: LocalSttApi = {
  state: () => invoke<LocalSttState>("local_stt_state").catch(asError),
  detect: () => invoke<FoundEngine[]>("local_stt_detect").catch(asError),
  set: (onThisComputer, engine) => invoke<LocalSttState>("local_stt_set", { onThisComputer, engine }).then(changed, asError),
  pickProgram: () => invoke<LocalSttState | null>("local_stt_pick_program").then((s) => changed(s ?? undefined), asError),
  pickModel: () => invoke<LocalSttState | null>("local_stt_pick_model").then((s) => changed(s ?? undefined), asError),
  onChange: (fn) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** The last part of a path: a model's file or folder name. */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
