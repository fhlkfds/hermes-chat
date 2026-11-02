// Dictation's microphone capture. The microphone is opened only when the owner starts a recording, and closed as
// soon as they stop or cancel it, or the window that started it goes away. Samples stay in memory; nothing is
// written to disk. A stopped recording becomes 16 kHz mono WAV, which every Hermes transcriber takes (a plain Web
// Audio capture, since WebKitGTK's MediaRecorder depends on which GStreamer encoders are installed).
import { messageOf, micProblem, toWav } from "../hermes/voice";

export type Recording = { audio: Uint8Array; mime: "audio/wav"; seconds: number };

/** A recording under way. */
export interface Capture {
  /** Seconds recorded so far. */
  seconds(): number;
  /** How loud the last moment was, 0 to 1, so the owner can see the microphone hears them. */
  level(): number;
  /** Closes the microphone and gives the recording. */
  stop(): Recording;
  /** Closes the microphone and drops what was recorded. */
  cancel(): void;
}

/** What the capture needs from the browser, so tests can stand in for it. */
export type AudioEnv = {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  makeContext: () => AudioContext;
};

const browserEnv = (): AudioEnv => ({
  mediaDevices: typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
  makeContext: () => new AudioContext(),
});

/** Why the microphone can't be used: shown to the owner as is. */
export class MicError extends Error {}

/**
 * Opens the microphone and starts recording. Rejects with a `MicError` saying why when there's no microphone, it's
 * refused or busy, or this window can't capture audio. `onLost` is called if the microphone goes away mid-recording,
 * after the capture has already closed it.
 */
export async function startCapture(onLost: (why: string) => void, env: AudioEnv = browserEnv()): Promise<Capture> {
  if (!env.mediaDevices?.getUserMedia) throw new MicError("This window can't use a microphone: the system webview has audio capture turned off.");
  let stream: MediaStream;
  try {
    stream = await env.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    throw new MicError(micProblem(e));
  }
  const tracks = stream.getAudioTracks();
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  if (!tracks.length) {
    stopTracks();
    throw new MicError(micProblem(new DOMException("no audio track", "NotFoundError")));
  }

  let ctx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: ScriptProcessorNode | undefined;
  let chunks: Float32Array[] = [];
  let samples = 0;
  let loudness = 0;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    if (node) node.onaudioprocess = null;
    node?.disconnect();
    source?.disconnect();
    for (const t of tracks) t.onended = null;
    stopTracks();
    void ctx?.close().catch(() => {});
  };

  try {
    ctx = env.makeContext();
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but runs everywhere, WebKitGTK included, with no worklet module to load.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      samples += data.length;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      loudness = Math.min(1, Math.sqrt(sum / (data.length || 1)) * 4);
    };
    source.connect(node);
    // The processor only runs while connected to the output; it writes nothing to its output, so nothing is heard.
    node.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
  } catch (e) {
    close();
    throw new MicError(`The microphone couldn't be recorded from: ${messageOf(e)}`);
  }
  for (const t of tracks)
    t.onended = () => {
      if (!open) return;
      close();
      chunks = [];
      onLost("The microphone was disconnected, so the recording was dropped.");
    };

  const rate = ctx.sampleRate;
  return {
    seconds: () => samples / rate,
    level: () => (open ? loudness : 0),
    stop: () => {
      close();
      const recording: Recording = { audio: toWav(chunks, rate), mime: "audio/wav", seconds: samples / rate };
      chunks = [];
      return recording;
    },
    cancel: () => {
      close();
      chunks = [];
    },
  };
}
