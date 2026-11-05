// Where speech-to-text runs (ADR 0065): on the Hermes server, with the profile's speech provider, or on this computer,
// with whisper.cpp (src-tauri/src/local_stt.rs). The owner picks a Primary, and may make the other one its Backup. If
// the primary fails (Hermes unreachable, a provider error, no model here, or too slow past the
// timeout), the backup runs on the same recording, and the transcript says which one it came from.
//
// Dictation and voice conversations both transcribe through `transcribeRouted`, so they behave the same.

import type { Transcript } from "./pipe";
import { messageOf } from "./voice";

export type SttSide = "server" | "local";
export const STT_SIDES: readonly SttSide[] = ["server", "local"];

/**
 * The owner's choice, kept on this computer (uiPrefs.ts). `backup`: the other side runs when the primary fails.
 * `timeoutSeconds`: how long the primary gets before the backup runs instead; with no backup, it gets as long as it takes.
 */
export type SttPrefs = { primary: SttSide; backup: boolean; timeoutSeconds: number };

export const DEFAULT_STT_PREFS: Readonly<SttPrefs> = Object.freeze({ primary: "server", backup: false, timeoutSeconds: 30 });
/** The timeout choices Settings → Voice offers, in seconds. */
export const STT_TIMEOUTS = [10, 20, 30, 60, 120] as const;
/** The longest a run on this computer may take with no backup waiting: then it is stopped (`MAX_TIMEOUT_SECONDS` in Rust). */
export const LOCAL_MAX_SECONDS = 600;

/** The stored prefs, each field checked; undefined when it isn't a document. */
export function toSttPrefs(v: unknown, d: Readonly<SttPrefs> = DEFAULT_STT_PREFS): SttPrefs | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const doc = v as Record<string, unknown>;
  const t = doc.timeoutSeconds;
  return {
    primary: doc.primary === "server" || doc.primary === "local" ? doc.primary : d.primary,
    backup: typeof doc.backup === "boolean" ? doc.backup : d.backup,
    timeoutSeconds: typeof t === "number" && Number.isInteger(t) && t >= 5 && t <= LOCAL_MAX_SECONDS ? t : d.timeoutSeconds,
  };
}

export const other = (side: SttSide): SttSide => (side === "server" ? "local" : "server");

/** "on Hermes", "on this computer": where a transcript came from, as the chat says it. */
export const sideLabel = (side: SttSide) => (side === "server" ? "Hermes" : "this computer");

/** Transcribes on one side, stopping by itself after `timeoutSeconds` where it can. Its error says why it couldn't. */
export type SttRunner = (audio: Uint8Array, mime: string, timeoutSeconds: number) => Promise<Transcript>;

/**
 * A transcript and where it came from. `fellBack`: the primary didn't give one, and why; the text then came from the
 * backup.
 */
export type RoutedTranscript = Transcript & { ran: SttSide; fellBack?: { from: SttSide; why: string } };

/** A transcript as Dictation and voice conversations get it: where it ran, when the router says. */
export type HeardTranscript = Transcript & Partial<Pick<RoutedTranscript, "ran" | "fellBack">>;

/** The note for `t` if it came from the backup (see `fellBackNote`), else undefined. */
export const fellBackOf = (t: HeardTranscript): string | undefined => (t.ran ? fellBackNote({ ...t, ran: t.ran }) : undefined);

/** The primary failed and so did the backup (or there was none): says what each one said. */
export class SttFailed extends Error {
  constructor(
    readonly tried: { side: SttSide; why: string }[],
  ) {
    super(
      tried.length === 1
        ? couldnt(tried[0].side, tried[0].why)
        : tried.map((t, i) => (i === 0 ? couldnt(t.side, t.why) : couldnt(t.side, t.why, true))).join(" "),
    );
    this.name = "SttFailed";
  }
}

function couldnt(side: SttSide, why: string, either = false): string {
  const who = side === "server" ? "Hermes" : "This computer";
  const reason = why.replace(/^(Hermes|This computer) couldn't transcribe[^:]*:\s*/, "");
  return `${who} couldn't transcribe it${either ? " either" : ""}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`;
}

/** Waits for `p` at most `seconds`; past that, rejects with a timeout that says so. */
export function within<T>(p: Promise<T>, seconds: number, timers: Timers = globalTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = timers.set(() => reject(new SttTimeout(seconds)), seconds * 1000);
    p.then(
      (v) => {
        timers.clear(id);
        resolve(v);
      },
      (e) => {
        timers.clear(id);
        reject(e);
      },
    );
  });
}

export class SttTimeout extends Error {
  constructor(readonly seconds: number) {
    super(`It took longer than ${seconds} s.`);
    this.name = "SttTimeout";
  }
}

/** The recording was dropped (Cancel, the chat closed, the conversation ended or paused) before it was transcribed. */
export class SttCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "SttCancelled";
  }
}

/** `p`, or a rejection with `SttCancelled` as soon as `signal` aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new SttCancelled());
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const globalTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Transcribes `audio` where the owner chose: the primary, then, if it fails, the backup. Hearing no
 * speech isn't a failure: an empty transcript from the primary is the answer. With a backup, the primary gets
 * `timeoutSeconds`, and an answer that comes later is dropped; the backup, and a primary with no backup, get as long
 * as they take (this computer stops itself after `LOCAL_MAX_SECONDS`). Once `signal` aborts, nothing more is tried and
 * whatever is running is no longer waited for: a recording the owner dropped never goes on to the backup.
 */
export async function transcribeRouted(
  prefs: Readonly<SttPrefs>,
  sides: Record<SttSide, SttRunner>,
  audio: Uint8Array,
  mime: string,
  signal?: AbortSignal,
  timers: Timers = globalTimers,
): Promise<RoutedTranscript> {
  const order: SttSide[] = prefs.backup ? [prefs.primary, other(prefs.primary)] : [prefs.primary];
  const tried: { side: SttSide; why: string }[] = [];
  for (const [i, side] of order.entries()) {
    const timed = prefs.backup && i === 0;
    if (signal?.aborted) throw new SttCancelled();
    try {
      const run = sides[side](audio, mime, timed ? prefs.timeoutSeconds : LOCAL_MAX_SECONDS);
      const got = await untilAborted(timed ? within(run, prefs.timeoutSeconds, timers) : run, signal);
      const fellBack = tried.length ? { from: tried[0].side, why: tried[0].why } : undefined;
      return { ...got, ran: side, ...(fellBack && { fellBack }) };
    } catch (e) {
      if (e instanceof SttCancelled || signal?.aborted) throw new SttCancelled();
      tried.push({ side, why: messageOf(e) });
    }
  }
  throw new SttFailed(tried);
}

/** What the chat says under a transcript that came from the backup: which side, and why the primary didn't. */
export function fellBackNote(t: RoutedTranscript): string | undefined {
  if (!t.fellBack) return undefined;
  const why = couldnt(t.fellBack.from, t.fellBack.why);
  return `Transcribed on ${sideLabel(t.ran)}. ${why}`;
}
