// The record of recent connection attempts (#270, ADR 0033). Each time the app opens a connection, at launch or to
// reconnect, it keeps one line: every route tried, by kind and id (never its address), the steps each reached and how
// long each took, and how it ended, with the error after `redact()` and with every address taken out. Rust keeps the
// newest 50 in `connection-attempts.jsonl` in the app's data folder (src-tauri/src/connection_attempts.rs), and checks
// each line again before writing it. Nothing is uploaded; Logs shows the lines, and the support bundle can include them.
//
// A line is written whole each time its attempt moves on, so an attempt the app was closed during is on disk at the
// step it was on, and the next launch says so.

import { clean, type Entry, type Level, type Snapshot, note } from "./logs";
import { KIND_LABEL, type RouteDetails, type RouteKind, routesOf } from "./routes";
import type { SignInDetails } from "./tauriPipe";

/** The steps of opening a connection, in order (src-tauri/src/connect_steps.rs `Step`; a test holds the two together). */
export const STEPS = ["keyring", "resolve", "tunnel", "status", "sign-in", "ticket", "websocket", "ready"] as const;
export type Step = (typeof STEPS)[number];

export type RouteTry = { id: string; kind: RouteKind; steps: { step: Step; ms?: number }[]; error?: string };
export type Outcome = "unfinished" | "connected" | "failed" | "stopped";
/** One line of the file. `run`: the launch of the app that made it. `ms`: how long it took, once it ended. */
export type Attempt = { v: 1; id: string; run: string; at: number; ms?: number; outcome: Outcome; routes: RouteTry[]; error?: string };

/** Where attempts are kept: Rust's file in the app (tauriPipe.ts `tauriAttemptStore`), memory in tests. */
export type AttemptStore = {
  read(): Promise<{ attempts: Attempt[]; unreadable: number }>;
  /** Replaces the line with this id, or adds it, and keeps the newest 50. Rejects a line that isn't clean. */
  put(a: Attempt): Promise<void>;
};

/** The most attempts kept (connection_attempts.rs `CAP`). */
export const KEEP = 50;
/** The longest error text kept, in characters (connection_attempts.rs `TEXT_MAX`). */
export const TEXT_MAX = 300;
/** What an error text becomes when it still looks like it holds an address after scrubbing. */
export const WITHHELD = "[withheld: the message may have named an address]";
const STOPPED = "Connecting was stopped.";

/** One attempt as routes.ts and transport.ts fill it in. Every call after it ended does nothing. */
export interface AttemptTrace {
  /** A route is tried next. Only its id and kind are kept. */
  route(r: Pick<RouteDetails, "id" | "kind">): RouteTrace;
  /** The pipe is open; waiting for `gateway.ready` is the last step of the route that opened it. */
  ready(): void;
  connected(): void;
  /** It ended without a connection. With no error, the routes' own errors say why. */
  failed(error?: unknown): void;
}
export interface RouteTrace {
  /** Rust started this step (`hermes_connect`'s `onStep`). */
  step(s: Step): void;
  failed(error: unknown): void;
}

/** What routes.ts needs: one trace per opening of a connection. */
export type AttemptRecorder = { begin(d: SignInDetails): AttemptTrace };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- taking addresses out ----------

/** `gateway.ready` and its like: dotted words a message can hold that are not host names. */
const NOT_HOSTS = new Set(["gateway.ready"]);

/** A URL, whole: it goes before the connection's own addresses, so none of it is left beside them. */
const URL_SHAPE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>(){}]+/gi;
// Each replaces what it finds with `[address]` or `[host]`, after the connection's own addresses are out.
const SHAPES: [RegExp, (m: string, ...g: string[]) => string][] = [
  [/[^\s@"'<>(){}[\]]*@[^\s@"'<>(){}[\]:,;]*/g, () => "[address]"],
  // IPv6, with brackets, a zone or a port: hex and colons with `::` or three colons. A time like 10:00:00 has two.
  [/\[?(?=[0-9a-f]*:[0-9a-f]*:)(?=[0-9a-f:]*(?:::|:[0-9a-f]*:[0-9a-f]*:))[0-9a-f:.]+(?:%[\w.-]+)?\]?(?::\d{1,5})?/gi, () => "[address]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, () => "[address]"],
  // ssh's own words for the host it tried: "resolve hostname X:", "connect to host X port 22", "by X port 22".
  [/\b(hostname|host|by|from|to)\s+(?!\[)([^\s:,;]+)(?=:|\s+port\s+\d)/gi, (_, w: string) => `${w} [host]`],
  [/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*\b(?::\d{1,5})?/gi, (m) => (NOT_HOSTS.has(m.toLowerCase()) ? m : "[host]")],
];

/**
 * Whether `text` holds none of the shapes Rust refuses (connection_attempts.rs `address_free`): `://`, `@`, four
 * dot-joined numbers, or hex and colons with `::` or three colons.
 */
export function addressFree(text: string): boolean {
  if (text.includes("://") || text.includes("@")) return false;
  const ipv4 = text.split(/[^\d.]/).some((t) => {
    const p = t.replace(/^\.+|\.+$/g, "").split(".");
    for (let i = 0; i + 4 <= p.length; i++) if (p.slice(i, i + 4).every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return true;
    return false;
  });
  if (ipv4) return false;
  return !text.split(/[^0-9a-fA-F:]/).some((t) => /[0-9a-f]/i.test(t) && (t.includes("::") || (t.match(/:/g)?.length ?? 0) >= 3));
}

/**
 * How error texts are cleaned for the file, for one sign-in: terminal codes out, `redact()`'s secret shapes, line breaks
 * to spaces, then this
 * URLs, then this connection's own addresses, username, password, token and header values, then any other address's shape, then
 * control characters written out, then cut to `TEXT_MAX`. A text that still looks like it holds an address is withheld.
 */
export function scrubberFor(d: SignInDetails): (text: string) => string {
  const addresses = new Set<string>();
  const secrets = new Set<string>();
  const add = (set: Set<string>, v: string | null | undefined) => v?.trim() && set.add(v.trim());
  // Host names reach messages lowercased (URLs, DNS); matching the case keeps "Hermes" when the host is `hermes`.
  const addAddress = (v: string | null | undefined) => {
    add(addresses, v);
    add(addresses, v?.toLowerCase());
  };
  for (const r of routesOf(d)) {
    addAddress(r.target);
    if (r.kind === "ssh") {
      const at = r.target.trim().lastIndexOf("@");
      addAddress(r.target.trim().slice(at + 1));
      if (at > 0) addAddress(r.target.trim().slice(0, at));
    } else {
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(r.target.trim()) ? r.target.trim() : `http://${r.target.trim()}`);
        addAddress(u.host);
        addAddress(u.hostname.replace(/^\[(.*)\]$/, "$1"));
      } catch {
        // Not a URL: its text as typed is enough.
      }
    }
    for (const h of r.headers ?? []) add(secrets, h.value);
  }
  addAddress(d.sshTarget);
  addAddress(d.url);
  addAddress(d.username);
  add(secrets, d.password);
  add(secrets, d.token);
  for (const h of d.headers ?? []) add(secrets, h.value);
  // Longest first, so a URL goes before the host inside it. A short one only as a whole word, so `ab` doesn't eat words.
  const literal = (set: Set<string>, to: string): [RegExp, string][] =>
    [...set]
      .sort((a, b) => b.length - a.length)
      .map((v) => [new RegExp(v.length < 4 ? `(?<![\\w.-])${escape(v)}(?![\\w-])` : escape(v), "g"), to]);
  const literals = [...literal(secrets, "[redacted]"), ...literal(addresses, "[address]")];
  return (raw) => {
    // One line: ssh's and reqwest's messages can run over several, and the file keeps no control characters.
    let text = clean(raw.replace(/\r\n?/g, "\n")).text.replace(/\s*[\n\t]+\s*/g, " ").replace(URL_SHAPE, "[address]");
    for (const [re, to] of literals) text = text.replace(re, to);
    for (const [re, to] of SHAPES) text = text.replace(re, to as (m: string, ...g: string[]) => string);
    const chars = Array.from(text);
    if (chars.length > TEXT_MAX) text = `${chars.slice(0, TEXT_MAX - 1).join("")}…`;
    return addressFree(text) ? text : WITHHELD;
  };
}

// ---------- the log ----------

/** This launch of the app. */
const RUN = globalThis.crypto.randomUUID();

const withheld = (a: Attempt): Attempt => ({
  ...a,
  ...(a.error && { error: WITHHELD }),
  routes: a.routes.map((r) => ({ ...r, ...(r.error && { error: WITHHELD }) })),
});

/**
 * The record of recent connection attempts: this launch's as they happen, and earlier ones from the file once `load`
 * reads it. Logs reads it like a `LogBuffer` (`getSnapshot`, `subscribe`), one line per attempt, oldest first.
 */
export class AttemptLog implements AttemptRecorder {
  readonly capacity = KEEP;
  private attempts: Attempt[] = [];
  /** A stable `seq` per attempt, so a line that changes stays one row. */
  private seqs = new Map<string, number>();
  private seq = 0;
  private problems: string[] = [];
  private snap?: Snapshot;
  private listeners = new Set<() => void>();
  /** The latest state of each attempt not yet written, and the writes, one at a time, in order. */
  private pending = new Map<string, Attempt>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private store: AttemptStore,
    private opts: { run?: string; now?: () => number; tick?: () => number } = {},
  ) {}

  private get run() {
    return this.opts.run ?? RUN;
  }
  private now = () => (this.opts.now ?? Date.now)();
  private tick = () => (this.opts.tick ?? (() => performance.now()))();

  /** Reads the file again (Logs does each time it opens), keeping this launch's newer state of any attempt in it. */
  async load(): Promise<void> {
    try {
      const { attempts, unreadable } = await this.store.read();
      const mine = new Map(this.attempts.filter((a) => a.run === this.run).map((a) => [a.id, a]));
      const merged = new Map(attempts.map((a) => [a.id, a]));
      for (const [id, a] of mine) merged.set(id, a);
      this.attempts = [...merged.values()];
      this.problems = unreadable ? [`${unreadable} line${unreadable === 1 ? "" : "s"} of the file couldn't be read, and will be dropped at the next write.`] : [];
    } catch (e) {
      this.problems = [`Couldn't read the record of connection attempts: ${messageOf(e)}`];
    }
    this.changed();
  }

  begin(d: SignInDetails): AttemptTrace {
    const scrub = scrubberFor(d);
    const started = this.tick();
    const a: Attempt = { v: 1, id: globalThis.crypto.randomUUID(), run: this.run, at: this.now(), outcome: "unfinished", routes: [] };
    let stepAt = started;
    let ended = false;
    const keep = () => this.keep(a);
    /** Closes the running step of the last route, if it has one without a time. */
    const closeStep = () => {
      const last = a.routes.at(-1)?.steps.at(-1);
      if (last && last.ms === undefined) last.ms = Math.max(0, Math.round(this.tick() - stepAt));
    };
    const end = (outcome: Outcome, error?: string) => {
      if (ended) return;
      ended = true;
      closeStep();
      a.outcome = outcome;
      a.ms = Math.max(0, Math.round(this.tick() - started));
      const last = a.routes.at(-1)?.error;
      if (error && error !== last) a.error = error;
      keep();
    };
    const startStep = (r: RouteTry, s: Step) => {
      if (ended || a.routes.at(-1) !== r) return;
      // Rust says when a step starts; each step is reported once, in order.
      if (r.steps.some((x) => STEPS.indexOf(x.step) >= STEPS.indexOf(s))) return;
      closeStep();
      stepAt = this.tick();
      r.steps.push({ step: s });
      keep();
    };
    keep();
    return {
      route: (route) => {
        const r: RouteTry = { id: route.id, kind: route.kind, steps: [] };
        let done = false;
        if (!ended) {
          closeStep();
          a.routes.push(r);
          keep();
        }
        return {
          step: (s) => !done && startStep(r, s),
          failed: (e) => {
            if (done || ended || a.routes.at(-1) !== r) return;
            done = true;
            closeStep();
            r.error = scrub(messageOf(e));
            keep();
          },
        };
      },
      ready: () => {
        const r = a.routes.at(-1);
        if (r) startStep(r, "ready");
      },
      connected: () => end("connected"),
      failed: (e) => {
        const message = e === undefined ? undefined : messageOf(e);
        end(message === STOPPED ? "stopped" : "failed", message === undefined || message === STOPPED ? undefined : scrub(message));
      },
    };
  }

  /** Shows `a` as it is now and writes it, after any write before it. */
  private keep(a: Attempt) {
    const copy: Attempt = structuredClone(a);
    const at = this.attempts.findIndex((x) => x.id === a.id);
    if (at >= 0) this.attempts[at] = copy;
    else this.attempts.push(copy);
    this.changed();
    this.pending.set(a.id, copy);
    this.writing = this.writing.then(async () => {
      const next = this.pending.get(a.id);
      if (!next) return;
      this.pending.delete(a.id);
      await this.store.put(next).catch(async (e: unknown) => {
        // Rust found something in a text that looks like an address: keep the attempt without its texts.
        await this.store.put(withheld(next)).catch(() => note("WARNING", `A connection attempt couldn't be kept on disk: ${messageOf(e)}`));
      });
    });
  }

  /** Resolves once every change so far is written (tests, and before reading the file back). */
  settled(): Promise<void> {
    return this.writing;
  }

  private changed() {
    this.attempts.sort((x, y) => x.at - y.at);
    this.attempts.splice(0, Math.max(0, this.attempts.length - KEEP));
    this.snap = undefined;
    for (const fn of this.listeners) fn();
  }

  readonly getSnapshot = (): Snapshot => {
    if (this.snap) return this.snap;
    const entries: Entry[] = this.problems.map((text, i) => ({ seq: -1 - i, kind: "mark", text, at: this.now() }));
    for (const a of this.attempts) {
      let seq = this.seqs.get(a.id);
      if (seq === undefined) this.seqs.set(a.id, (seq = ++this.seq));
      entries.push({ seq, kind: "line", at: a.at, ...attemptText(a, this.run) });
    }
    return (this.snap = { entries, dropped: 0, lines: this.attempts.length });
  };

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}

// ---------- as Logs shows it ----------

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/**
 * One attempt in the owner's words: how it ended, then each route tried, its steps and times, and where and why it
 * stopped. `run`: this launch, so an unfinished attempt of another launch reads as one the app was closed during.
 */
export function attemptText(a: Attempt, run: string): { text: string; level: Level } {
  const routes = a.routes.map((r) => {
    const steps = r.steps.map((s) => (s.ms === undefined ? s.step : `${s.step} ${duration(s.ms)}`)).join(", ");
    const last = r.steps.at(-1)?.step;
    const why = r.error ? `; stopped${last ? ` at ${last}` : ""}: ${r.error}` : "";
    return `${KIND_LABEL[r.kind]} route ${r.id}: ${steps || "no step started"}${why}`;
  });
  const reached = a.routes.at(-1)?.steps.at(-1)?.step;
  const [head, level]: [string, Level] =
    a.outcome === "connected"
      ? [`Connected in ${duration(a.ms ?? 0)}`, "INFO"]
      : a.outcome === "stopped"
        ? [`Stopped after ${duration(a.ms ?? 0)}`, "INFO"]
        : a.outcome === "failed"
          ? [`Failed after ${duration(a.ms ?? 0)}${reached && !a.routes.at(-1)?.error ? `, at ${reached}` : ""}${a.error ? `: ${a.error}` : ""}`, "ERROR"]
          : a.run === run
            ? ["Connecting", "INFO"]
            : [`Didn't finish: Hermes Chat was closed while it was connecting${reached ? `, at ${reached}` : ""}`, "WARNING"];
  const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  return { text: [head, ...routes].map(sentence).join(" "), level };
}
