// Settings → Toolsets: which toolsets Hermes offers the model, for one profile, read from and written to dashboard
// REST on the deployed `bf0203a` (`hermes_cli/web_routers/tools.py`):
//
// - `GET /api/tools/toolsets?profile=` lists the configurable toolsets with `enabled` as Hermes resolves it now
//   (`_get_platform_tools`, after `agent.disabled_toolsets`), and `configured` (its keys or provider are set up).
// - `PUT /api/tools/toolsets/{name}?profile=` with `{enabled}` adds or removes one toolset from the profile's
//   `platform_toolsets.<platform>` in its config.yaml, under the config mutation lock, keeping every other entry
//   (`_save_platform_tools`). The config-only `stt` flips `stt.enabled` instead. Enabling may start a background
//   `hermes tools post-setup` install on the server (`post_setup_started`).
// - `GET /api/tools/toolsets/{name}/config?profile=` lists its providers and their readiness, used here only to warn
//   before an enable that may start such an install. Env vars come as `is_set` flags, never values.
//
// What the setting reaches: `platform` is `cli` for nearly every toolset, and `platform_toolsets.cli` is what Hermes
// builds this app's chats with (`tui_gateway/agent_factory._load_enabled_toolsets`), as well as the CLI, the TUI and
// the official desktop app. A toolset restricted to another platform (Discord's) targets that platform instead. An
// agent's toolsets are fixed when Hermes builds it, so a chat Hermes already has open, and any reply running in it,
// keeps the tools it started with; new chats get the change.
//
// Nothing is taken on trust: every change is checked against a fresh read first (another client may have changed it),
// and reported as saved only once a read afterwards shows it.

/** One toolset as Hermes lists it for a profile. */
export type Toolset = {
  name: string;
  label: string;
  description: string;
  /** The platform whose toolset list the switch writes: `cli` for this app's chats. */
  platform: string;
  platformLabel: string;
  /** On for `platform`, as Hermes resolves it now. */
  enabled: boolean;
  /** Its API keys or provider are set up; when false its tools may not be offered even while on. */
  configured: boolean;
  tools: string[];
  /** A setting with no tools of its own (`stt`): the switch is its config section's `enabled` flag. */
  configOnly: boolean;
};

/** Whether this server takes toolset changes from this app, and if not, why. */
export type WriteSupport = { ok: true } | { ok: false; reason: string };

export type ToolsetList = { profile: string; toolsets: Toolset[]; readAt: number };

/** What a change came to. Every kind but `unknown` carries what Hermes has now, read after the attempt. */
export type ToolsetChange =
  /**
   * Read back as asked. `installing`: Hermes started a background install for it on the server. `warning`: Hermes
   * answered with this error, yet reads it back as asked.
   */
  | { kind: "saved"; list: ToolsetList; installing?: string; warning?: string }
  /** Not sent: Hermes already had it otherwise, or no longer lists it; another client changed it. */
  | { kind: "conflict"; list: ToolsetList; now?: boolean }
  /** Refused, and not read back as asked (`list`, when it could be read again). */
  | { kind: "rejected"; reason: string; list?: ToolsetList }
  /** Sent and accepted, but Hermes reads it back the other way. */
  | { kind: "mismatch"; list: ToolsetList }
  /** The connection failed before Hermes answered, and a read afterwards (if any) doesn't show it: it may yet land. */
  | { kind: "unknown"; reason: string; list?: ToolsetList };

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type Rest = (method: "GET" | "PUT", pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** The toolset name the write-support check sends with an invalid body. Rust relays this name only with that body. */
export const PROBE_NAME = "__hermes_chat_probe__";
/** Names this app sends in a path: Hermes's own keys are all like this. Others are shown but can't be switched here. */
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
export const changeableName = (name: string) => SAFE_NAME.test(name) && name !== "." && name !== ".." && name !== PROBE_NAME;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `_POST_SETUP_INSTALLED` at `bf0203a`: the installs the toggle route starts itself when they aren't done. */
const INSTALL_ON_ENABLE = new Set(["cua_driver"]);

/** `_CONFIG_ONLY_TOOLSETS` at `bf0203a`. */
const CONFIG_ONLY = new Set(["stt"]);

/** A failed dashboard call: the HTTP status and Hermes's reason when it answered, none when it couldn't be reached. */
export type Failure = { status?: number; reason: string; signedOut?: boolean; notRelayed?: boolean };

/** Reads an error the way the Rust relay and FakeHermes word it: `The dashboard answered 404: {"detail":…}`. */
export function failureOf(e: unknown): Failure {
  const message = e instanceof Error ? e.message : String(e);
  if (/sign-in has expired/i.test(message)) return { status: 401, reason: message, signedOut: true };
  if (/^Hermes Chat doesn't relay /.test(message)) return { reason: message, notRelayed: true };
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return { reason: message };
  let reason = m[2].trim();
  try {
    const d = JSON.parse(reason).detail;
    if (typeof d === "string" && d.trim()) reason = d.trim();
    else if (Array.isArray(d)) reason = d.map((x) => str(obj(x).msg)).filter(Boolean).join("; ") || reason;
  } catch {
    // Not JSON, or cut short by the relay: the text as it came.
  }
  return { status: Number(m[1]), reason };
}

/** FastAPI's own "no such route", as opposed to a route refusing, which names its own reason. */
const noRoute = (f: Failure) => f.status === 405 || (f.status === 404 && f.reason === "Not Found");

export class UnsupportedServerError extends Error {}

function rowsFrom(res: unknown): Toolset[] {
  if (!Array.isArray(res)) throw new Error("Hermes answered with something other than a toolset list.");
  return res.flatMap((r): Toolset[] => {
    const row = obj(r);
    const name = str(row.name);
    if (!name || typeof row.enabled !== "boolean") return [];
    const platform = str(row.platform) || "cli";
    return [
      {
        name,
        label: str(row.label) || name,
        description: str(row.description),
        platform,
        platformLabel: str(row.platform_label) || platform,
        enabled: row.enabled,
        // Older servers may not say; then it isn't claimed to need setup.
        configured: row.configured !== false,
        tools: Array.isArray(row.tools) ? row.tools.filter((t): t is string => typeof t === "string") : [],
        configOnly: CONFIG_ONLY.has(name),
      },
    ];
  });
}

/** Settings → Toolsets' reads and writes. Every call names its profile, so a profile switch can't redirect one. */
export class ToolsetsApi {
  constructor(
    private readonly rest: Rest,
    /** Called after a change Hermes may have taken, so cached reads that depend on it are dropped. */
    private readonly changed: (profile: string, name: string) => void = () => {},
  ) {}

  private path(profile: string, name?: string, rest = "") {
    const q = new URLSearchParams({ profile }).toString();
    return `api/tools/toolsets${name === undefined ? "" : `/${encodeURIComponent(name)}`}${rest}?${q}`;
  }

  /** `GET /api/tools/toolsets` for `profile`. A server without the route throws `UnsupportedServerError`. */
  async list(profile: string): Promise<ToolsetList> {
    try {
      return { profile, toolsets: rowsFrom(await this.rest("GET", this.path(profile))), readAt: Date.now() };
    } catch (e) {
      const f = failureOf(e);
      if (noRoute(f))
        throw new UnsupportedServerError(
          "This Hermes server doesn't list toolsets: it has no /api/tools/toolsets route. Updating Hermes adds it.",
        );
      throw new Error(f.reason);
    }
  }

  /**
   * Whether the server has the route that changes a toolset, asked without changing anything: a `PUT` for a name no
   * toolset has, with an `enabled` that isn't true or false. FastAPI refuses the body (422) before the route runs; a
   * server that took the body would still refuse the unknown name (400) before reading the config.
   */
  async writeSupport(profile: string): Promise<WriteSupport> {
    try {
      await this.rest("PUT", this.path(profile, PROBE_NAME), { enabled: "probe" });
      // Nothing should take that body; say so rather than guess.
      return { ok: false, reason: "Hermes answered the write check in a way this app doesn't expect, so it won't change toolsets." };
    } catch (e) {
      const f = failureOf(e);
      if (f.signedOut) throw e;
      if (f.status === 422 || f.status === 400) return { ok: true };
      if (noRoute(f)) return { ok: false, reason: "This Hermes server lists toolsets but has no route to change them. Updating Hermes adds it." };
      if (f.status === 403) return { ok: false, reason: `Hermes doesn't let this sign-in change toolsets: ${f.reason}` };
      if (f.status === undefined && !f.notRelayed) throw new Error(f.reason);
      return { ok: false, reason: `Hermes didn't take the write check: ${f.reason}` };
    }
  }

  /**
   * The software Hermes would start installing on the server when `name` is turned on. The toggle route installs only a
   * `post_setup` with a registered installed-check that fails (`_post_setup_already_installed`, which at `bf0203a` has
   * one: `cua_driver`); other providers that need setup, such as `ddgs` for web, are left to `hermes tools`. Empty when
   * nothing would be installed; undefined when it couldn't be read. A newer server's other installs are still reported
   * afterwards, from `post_setup_started`.
   */
  async pendingInstalls(profile: string, name: string): Promise<string[] | undefined> {
    try {
      const res = obj(await this.rest("GET", this.path(profile, name, "/config")));
      const rows = Array.isArray(res.providers) ? res.providers.map(obj) : [];
      const pending = rows.filter((p) => INSTALL_ON_ENABLE.has(str(p.post_setup)) && p.status === "needs_setup");
      return [...new Set(pending.map((p) => str(p.post_setup)))];
    } catch {
      return undefined;
    }
  }

  /**
   * Turns `name` on or off for `profile`, if Hermes still has it as `expected` (what the owner saw), then reads it back.
   * Sends nothing when it doesn't: another client changed it, and the owner sees that first.
   */
  async set(profile: string, name: string, enabled: boolean, expected: boolean): Promise<ToolsetChange> {
    if (!changeableName(name)) return { kind: "rejected", reason: "This app can't send that toolset's name to Hermes." };
    const before = await this.list(profile);
    const row = before.toolsets.find((t) => t.name === name);
    if (!row) return { kind: "conflict", list: before };
    if (row.enabled !== expected) return { kind: "conflict", list: before, now: row.enabled };
    if (row.enabled === enabled) return { kind: "saved", list: before };

    let answer: Json;
    try {
      answer = obj(await this.rest("PUT", this.path(profile, name), { enabled }));
    } catch (e) {
      const f = failureOf(e);
      // Whatever the error, what Hermes has now is read back before saying what happened: an error answer is no proof
      // that nothing was written, and a lost answer no proof that it was. Only a request the relay refused never left.
      if (f.notRelayed) return { kind: "rejected", reason: f.reason };
      this.changed(profile, name);
      const list = await this.list(profile).catch(() => undefined);
      const now = list?.toolsets.find((t) => t.name === name)?.enabled;
      if (now === enabled) return { kind: "saved", list: list!, warning: f.reason };
      // A 4xx is answered before anything is written (validation, an unknown name, the sign-in); a lost answer, or a
      // server error that couldn't be read back, may have been written.
      if (f.status === undefined || (f.status >= 500 && !list)) return { kind: "unknown", reason: f.reason, list };
      return { kind: "rejected", reason: f.reason, list };
    }
    this.changed(profile, name);
    const after = await this.list(profile).catch((e) => e as Error);
    if (after instanceof Error) return { kind: "unknown", reason: `Hermes took the change, but reading it back failed: ${after.message}` };
    const now = after.toolsets.find((t) => t.name === name);
    if (answer.ok !== true || now?.enabled !== enabled) return { kind: "mismatch", list: after };
    const installing = str(answer.post_setup_started);
    return { kind: "saved", list: after, ...(installing ? { installing } : {}) };
  }
}
