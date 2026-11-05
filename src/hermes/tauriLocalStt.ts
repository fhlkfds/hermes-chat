// The Tauri side of speech-to-text on this computer (src-tauri/src/local_stt.rs).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadProgress, LocalSttApi, LocalSttStatus } from "./localStt";
import type { Transcript } from "./pipe";
import { asError } from "./tauriPipe";

export const tauriLocalStt: LocalSttApi = {
  status: () => invoke<LocalSttStatus>("local_stt_status").catch(asError),
  set: (change) => invoke<LocalSttStatus>("local_stt_set", { model: change.model ?? null, language: change.language ?? null }).catch(asError),
  pick: (what) => invoke<LocalSttStatus>("local_stt_pick", { what }).catch(asError),
  forget: (what) => invoke<LocalSttStatus>("local_stt_forget", { what }).catch(asError),
  download: (name, onProgress) => {
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<LocalSttStatus>("local_stt_download", { name, onProgress: channel }).catch(asError);
  },
  cancelDownload: () => invoke<void>("local_stt_cancel_download").catch(asError),
  remove: (name) => invoke<LocalSttStatus>("local_stt_delete", { name }).catch(asError),
  // The recording goes as the raw body, as it does to Hermes (tauriPipe.ts).
  transcribe: (audio, timeoutSeconds) =>
    invoke<Transcript>("local_stt_transcribe", audio, { headers: { "x-timeout": String(Math.round(timeoutSeconds)) } }).catch(asError),
};
