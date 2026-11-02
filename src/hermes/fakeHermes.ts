// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import type { LocalFile, OpenPipe, PipeEvent, Route } from "./pipe";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };
/** The client's answer to a server→client request (`tui_gateway/server_requests.py`). */
type Response = { jsonrpc: "2.0"; id: string; result?: Record<string, unknown>; error?: { code: number; message: string } };
/** A server→client request still waiting for its answer. `stored`: its session, which outlives the connection. */
type OpenRequest = { sid: string; stored: string; method: string; params: Record<string, unknown> };
type Handler = (req: Request) => void;
export type RestRequest = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type RestHandler = (req: RestRequest) => unknown;

/** A `sessions` row as dashboard REST `GET /api/sessions` returns it (research doc §5). */
export type SessionRow = {
  id: string;
  source: string;
  title: string | null;
  preview: string;
  started_at: number;
  last_active: number | null;
  message_count: number;
  pinned: boolean;
  archived: boolean;
  /** The read watermark: unread when activity postdates it. `null` = never tracked = read; 0 = marked unread. */
  last_read_at: number | null;
  /** Bumped by every session edit; an edit must name the current one. Missing means 0. */
  runtime_revision?: number;
};

/**
 * One history row as legacy `session.resume` returns it (`tui_gateway/session_history.py` `_history_to_messages`
 * at the deployed `bf0203a`). Tool rows carry name, args and an 80-char `context`; only edit tools keep `content`.
 */
export type TranscriptMessage = {
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
  context?: string;
  args?: Record<string, unknown>;
  timestamp?: number;
  display_kind?: string;
  reasoning?: string;
  row_id?: number;
};

/** A file on the owner's disk: its bytes as a string, a size alone for a file too big to make, or a folder. */
export type FakeFile = string | { size: number } | { dir: true };

/** A session's model as `SessionLiveInfo` carries it (`session.info`, and `info` on create and resume). */
export type ModelInfo = { model: string; provider: string; reasoning_effort: string; fast: boolean };

/**
 * A `model.options` result (`ModelOptionsResult`, `tui_gateway/contracts/config_free_tier_control.py` at upstream
 * `c419cf7`): two signed-in providers. `gpt-4.1` has no reasoning control, and only Opus and GPT-5 take fast mode.
 */
export function modelOptions(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    providers: [
      {
        slug: "anthropic",
        name: "Anthropic",
        models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
        authenticated: true,
        is_current: true,
        capabilities: {
          "claude-opus-4-5": { fast: true, reasoning: true, can_disable_reasoning: true },
          "claude-sonnet-4-5": { fast: false, reasoning: true, can_disable_reasoning: true },
          "claude-haiku-4-5": { fast: false, reasoning: true, can_disable_reasoning: true },
        },
      },
      {
        slug: "openai",
        name: "OpenAI",
        models: ["gpt-5", "gpt-4.1"],
        authenticated: true,
        capabilities: {
          "gpt-5": { fast: true, reasoning: true, can_disable_reasoning: false },
          "gpt-4.1": { fast: false, reasoning: false },
        },
      },
    ],
  };
}

const DAY = 86_400;
const MiB = 1024 * 1024;
const now = () => Date.now() / 1000;

/** A stored session `daysAgo` days old, unpinned and from this app unless overridden. */
export function row(id: string, daysAgo: number, over: Partial<SessionRow> = {}): SessionRow {
  const at = now() - daysAgo * DAY;
  return { id, source: "hermes-chat", title: `Chat ${id}`, preview: "", started_at: at, last_active: at, message_count: 2, pinned: false, archived: false, last_read_at: null, ...over };
}

/** A session edit's body without the request id and revision every edit carries. */
export function editFlags(body: Record<string, unknown> | undefined) {
  const { request_id: _id, expected_revision: _revision, ...flags } = body ?? {};
  return flags;
}

export class FakeHermes {
  /** Every request the client sent, in order. */
  readonly requests: Request[] = [];
  readonly restRequests: RestRequest[] = [];
  readyPayload: Record<string, unknown> = { skin: {}, change_events: true, heartbeat: true, replay_epoch: "e1" };
  /** How the pipe reaches this server, as the Rust side reports it. */
  route: Route = { kind: "ssh", target: "liam@hermes" };
  /** While set, opening a pipe fails with this message, as the Rust side does when the server can't be reached. */
  refuse?: string;
  /** While set, a frame sent rejects with this message and never arrives, as when the Rust side's outgoing queue has
   * closed (`TransportError::Closed`). */
  failSend?: string;
  /** How many pipes have been opened. */
  opened = 0;
  /** The `default` profile's stored sessions. A chat started over the WS gets a row on its first prompt. */
  sessions: SessionRow[] = [];
  /** Every other profile's stored sessions, by profile name. Each profile has its own store (research doc §5). */
  otherProfiles: Record<string, SessionRow[]> = {};
  /** The `?profile=` each `/api/ws` connection was opened with, in order. */
  readonly wsProfiles: string[] = [];
  /** Stored session id -> its history, as `session.resume` projects it (`_history_to_messages`). */
  transcripts: Record<string, TranscriptMessage[]> = {};
  /** The stored row id `prompt.submit` reports for the message (`user_row_id`, `tui_gateway/methods_prompt.py` at
   * `bf0203a`). Unset, it reports none, though the message is stored with a row of its own. */
  userRowId?: number;
  /** While set, `prompt.submit` is refused with this error and nothing is stored, as Hermes answers a busy session. */
  rejectPrompt?: { code: number; message: string };
  /**
   * The next `prompt.submit` drops the connection before Hermes answers it. `stored`: Hermes got the message and stored
   * it first, so its history has it. `lost`: the frame never reached Hermes. Applies once.
   */
  dropOnPrompt?: "stored" | "lost";
  /** What the model answers every `llm.oneshot` call with, unless `oneshotFailure` says why it failed. */
  oneshotAnswer = "A new title";
  oneshotFailure?: string;
  /** The owner's local disk, by path, for attachments. */
  files: Record<string, FakeFile> = {};
  /** Whether this connection sent `client.capabilities {server_requests: true}`. */
  answersRequests = false;
  /** Server→client requests nobody has answered yet, by id. */
  readonly openRequests = new Map<string, OpenRequest>();
  /** The client's answers to server→client requests, in order. */
  readonly responses: Response[] = [];
  /**
   * What `model.options` answers. Undefined answers JSON-RPC "method not found", as a server without the method would.
   * `model` and `provider` in it are the profile's default.
   */
  modelOptionsResult?: Record<string, unknown> = modelOptions();
  /** What dashboard REST `GET /api/model/options` answers; undefined is a 404. */
  restModelOptions?: Record<string, unknown>;
  /**
   * Each profile's default model, reasoning effort and fast mode, in its config.yaml. `config.set` writes here only
   * when sent without a session, as Hermes does (`tui_gateway/methods_config_set.py` at upstream `c419cf7`).
   */
  profileModel: Record<string, ModelInfo> = {};
  /** Stored session id -> the model it runs on, kept across resumes (`_persist_live_session_runtime`). */
  readonly sessionModel = new Map<string, ModelInfo>();
  /** runtime session id -> stored session id, for every session.create / session.resume. */
  readonly runtime = new Map<string, string>();
  private created = new Map<string, { source: string; profile?: string }>(); // runtime id, until the first prompt stores it

  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    "session.create": (r) => {
      const n = this.requests.filter((q) => q.method === "session.create").length;
      const runtimeId = `rt-${n}`;
      const stored = `20261031_12000${n}_abc123`;
      this.runtime.set(runtimeId, stored);
      this.created.set(runtimeId, { source: String(r.params.source ?? "tui"), profile: r.params.profile as string | undefined });
      // `SessionCreateParams` `model` / `provider` / `reasoning_effort` / `fast`: the session's own overrides.
      const base = this.defaultModel(r.params.profile as string | undefined);
      const p = r.params;
      const info: ModelInfo = {
        model: typeof p.model === "string" ? p.model : base.model,
        provider: typeof p.provider === "string" ? p.provider : base.provider,
        reasoning_effort: typeof p.reasoning_effort === "string" ? p.reasoning_effort : base.reasoning_effort,
        fast: typeof p.fast === "boolean" ? p.fast : base.fast,
      };
      this.sessionModel.set(stored, info);
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 0, messages: [], info });
    },
    "session.resume": (r) => {
      const stored = String(r.params.session_id);
      if (!this.store(r.params.profile as string | undefined)?.some((s) => s.id === stored)) return this.fail(r.id, 4007, `session not found: ${stored}`);
      // A session waiting on the owner is still live after its connection dropped: the resume reattaches it, with
      // the requests still open (`_resume_reuse_live`, `_live_session_payload` at the deployed `bf0203a`).
      const open = [...this.openRequests].filter(([, q]) => q.stored === stored);
      if (open.length) {
        const sid = open[0][1].sid;
        this.runtime.set(sid, stored);
        const messages = this.transcripts[stored] ?? [];
        const open_requests = open.map(([id, q]) => ({ id, method: q.method, params: { session_id: sid, ...q.params } }));
        return this.respond(r.id, { session_id: sid, stored_session_id: stored, message_count: messages.length, messages, info: {}, running: true, open_requests });
      }
      const runtimeId = `rt-r${++this.resumed}`;
      this.runtime.set(runtimeId, stored);
      const messages = this.transcripts[stored] ?? [];
      const info = this.sessionModel.get(stored) ?? {};
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: messages.length, messages, info, running: false });
    },
    // The message is stored as its turn starts (`user_row_id` is the staged row), so the history read back has it.
    "prompt.submit": (r) => {
      const drop = this.dropOnPrompt;
      this.dropOnPrompt = undefined;
      if (drop === "lost") return this.drop();
      if (this.rejectPrompt) return this.fail(r.id, this.rejectPrompt.code, this.rejectPrompt.message);
      const runtimeId = String(r.params.session_id);
      const created = this.created.get(runtimeId);
      if (created) {
        this.created.delete(runtimeId);
        const stored = row(this.runtime.get(runtimeId)!, 0, { source: created.source, title: null, preview: String(r.params.text), message_count: 1 });
        this.store(created.profile)?.push(stored);
      }
      const stored = this.runtime.get(runtimeId);
      if (stored) this.storeMessage(stored, { role: "user", text: String(r.params.text), row_id: this.userRowId });
      if (drop === "stored") return this.drop();
      this.respond(r.id, { status: "streaming", ...(this.userRowId !== undefined && { user_row_id: this.userRowId }) });
    },
    // Attachments stage server-side for the session's next turn (research doc §7; `tui_gateway/methods_prompt.py`
    // at the deployed `bf0203a`). Images join `attached_images`; other files land in the session's
    // `attachments/` and the client puts the `@file:` ref in the prompt text.
    "image.attach_bytes": (r) => {
      const n = ++this.imagesStaged;
      const name = `upload_${n}.png`;
      const bytes = atob(String(r.params.content_base64)).length;
      this.respond(r.id, { attached: true, path: `/hermes/images/${name}`, name, count: n, remainder: "", text: `[User attached image: ${name}]`, bytes });
    },
    "file.attach": (r) => {
      const name = String(r.params.name);
      const refPath = `attachments/${name}`;
      this.respond(r.id, { attached: true, name, path: `/hermes/workspace/${refPath}`, ref_path: refPath, ref_text: `@file:${formatRefValue(refPath)}`, uploaded: true });
    },
    "image.detach": (r) => {
      this.imagesStaged--;
      this.respond(r.id, { detached: true, count: this.imagesStaged });
    },
    // Legacy `session.interrupt` (tui_gateway/methods_session_interrupt.py). The turn then ends with a
    // `message.complete` whose status is "interrupted"; tests send that themselves.
    "session.interrupt": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { status: "interrupted" });
      // The interrupt withdraws whatever the session was waiting on.
      for (const [id, q] of this.openRequests) if (q.sid === sid) this.cancelRequest(id, "interrupted");
    },
    // `tui_gateway/methods_voice.py` at the deployed `bf0203a`: lists the server→client request kinds it knows.
    "client.capabilities": (r) => {
      if ("server_requests" in r.params) this.answersRequests = !!r.params.server_requests;
      this.respond(r.id, { server_requests: ["approval", "clarify", "secret", "sudo"], declines_not_shown: true });
    },
    // `tui_gateway/methods_prompt.py` at the deployed `bf0203a`: records that a client has the card on screen.
    "approval.received": (r) => {
      const pending = [...this.openRequests.values()].some((q) => q.sid === r.params.session_id && q.params.request_id === r.params.request_id);
      this.respond(r.id, { acknowledged: pending });
    },
    // `tui_gateway/methods_session.py` at the deployed `bf0203a`: a stateless model call (default task
    // `title_generation`) that answers `{text}`, or fails 5030 `one-shot generation failed: <why>`.
    "llm.oneshot": (r) => {
      if (!String(r.params.instructions ?? "").trim() && !String(r.params.input ?? "").trim())
        return this.fail(r.id, 4030, "llm.oneshot requires a template or instructions/input");
      if (this.oneshotFailure !== undefined) return this.fail(r.id, 5030, `one-shot generation failed: ${this.oneshotFailure}`);
      this.respond(r.id, { text: this.oneshotAnswer });
    },
    "model.options": (r) => {
      if (!this.modelOptionsResult) return this.fail(r.id, -32601, "Method not found: model.options");
      // Without a session, `model` and `provider` are the profile's own.
      const { model, provider } = this.defaultModel(r.params.profile as string | undefined);
      this.respond(r.id, { ...this.modelOptionsResult, model, provider });
    },
    // `_cfg_get_reasoning`: the session's effort, else the profile's.
    "config.get": (r) => {
      if (r.params.key !== "reasoning") return this.fail(r.id, 4002, `unknown config key: ${r.params.key}`);
      const stored = this.runtime.get(String(r.params.session_id ?? ""));
      const info = (stored && this.sessionModel.get(stored)) || this.defaultModel(r.params.profile as string | undefined);
      this.respond(r.id, { value: info.reasoning_effort || "medium", display: "show" });
    },
    // `config.set` for `model`, `reasoning` and `fast` (`tui_gateway/methods_config_set.py` at upstream `c419cf7`).
    // With a session they change only that session, and `session.info` reports it; a session id the server doesn't
    // hold is refused (4001). Without one they write the profile's config.
    "config.set": (r) => {
      const { key, value, session_id: sid } = r.params as { key: string; value: string; session_id?: string };
      if (!["model", "reasoning", "fast"].includes(key)) return this.fail(r.id, 4002, `unknown config key: ${key}`);
      const stored = sid ? this.runtime.get(sid) : undefined;
      if (sid && !stored) return this.fail(r.id, 4001, "session not found");
      const profile = (r.params.profile as string | undefined) ?? "default";
      const info = stored ? { ...(this.sessionModel.get(stored) ?? this.defaultModel(profile)) } : { ...this.defaultModel(profile) };
      if (key === "model") {
        if (!stored) return this.fail(r.id, 4001, "session not found");
        const [model, ...flags] = String(value).split(/\s+/);
        const at = flags.indexOf("--provider");
        info.model = model;
        if (at >= 0) info.provider = flags[at + 1];
      } else if (key === "reasoning") info.reasoning_effort = String(value);
      else info.fast = value === "fast";
      if (stored) {
        this.sessionModel.set(stored, info);
        this.event(sid!, "session.info", { ...info });
      } else this.profileModel[profile] = info;
      this.respond(r.id, { key, value });
    },
    // Keepalive, answered by the WS layer in either protocol generation (research doc §1).
    "gateway.ping": (r) => this.respond(r.id, { ok: true }),
  };

  /** Per-route REST behaviour, keyed `METHOD /path`. A handler throws to fail the request. */
  readonly rest: Record<string, RestHandler> = {
    "GET /api/sessions": ({ query }) => {
      // order=recent, archived=exclude|only|include, then every pinned row not already on the page, archived or not
      // (list_sessions_rich).
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const visible = this.storeOrFail(query.get("profile")).filter((s) => !excluded.includes(s.source));
      const archived = query.get("archived") ?? "exclude";
      const recent = visible.filter((s) => archived === "include" || s.archived === (archived === "only")).sort((a, b) => (b.last_active ?? b.started_at) - (a.last_active ?? a.started_at));
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      const page = recent.slice(offset, offset + limit);
      const pinned = visible.filter((s) => s.pinned && !page.includes(s));
      return { sessions: [...page, ...pinned].map((s) => ({ ...s, unread: unread(s) })), total: recent.length, limit, offset, storage: {} };
    },
    // `search_sessions` in `hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`: one row per chat, archived
    // ones too. Message hits come first, then title matches. FTS5 matches a message holding every word of the query,
    // each as a prefix; its `snippet()` marks the matched words between `>>>` and `<<<`. Message hits carry the
    // message's `role`.
    "GET /api/sessions/search": ({ query }) => {
      const q = (query.get("q") ?? "").trim();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { results: [] };
      const limit = Math.min(Number(query.get("limit") ?? 20), 100);
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const store = this.storeOrFail(query.get("profile")).filter((s) => !excluded.includes(s.source));
      const hits = (token: string) => words.some((w) => token.toLowerCase().startsWith(w));
      const results = new Map<string, Record<string, unknown>>();
      const add = (s: SessionRow, snippet: string, role: string | null) =>
        results.size < limit && !results.has(s.id) && results.set(s.id, {
          snippet, role, source: s.source, model: null, session_started: s.started_at, session_id: s.id, lineage_root: s.id,
          profile: query.get("profile") ?? "default", id: s.id, title: s.title, started_at: s.started_at,
          last_active: s.last_active ?? s.started_at, message_count: s.message_count, preview: s.preview, archived: s.archived,
        });
      for (const s of store)
        for (const m of this.transcripts[s.id] ?? []) {
          const text = m.text ?? (typeof m.content === "string" ? m.content : "");
          // Odd entries are FTS5 tokens (unicode61: runs of letters and digits), even ones what lies between.
          const parts = text.split(/([\p{L}\p{N}]+)/u);
          const tokens = parts.filter((_, i) => i % 2);
          if (!words.every((w) => tokens.some((t) => t.toLowerCase().startsWith(w)))) continue;
          // snippet(..., '>>>', '<<<', '...', 40): up to 40 tokens from a little before the first match.
          const first = parts.findIndex((t, i) => i % 2 && hits(t));
          const start = Math.max(1, first - 20);
          const end = Math.min(parts.length, start + 79);
          const body = parts.slice(start, end).map((t, i) => (i % 2 === 0 && hits(t) ? `>>>${t}<<<` : t)).join("");
          add(s, `${start > 1 ? "..." : parts[0]}${body}${end < parts.length - 1 ? "..." : (parts[end] ?? "")}`, m.role);
          break;
        }
      for (const s of store) if (s.title?.toLowerCase().includes(q.toLowerCase())) add(s, s.preview || `Session title matched: ${q}`, null);
      return { results: [...results.values()] };
    },
    // `hermes_cli/web_routers/models.py` `get_model_options` at upstream `c419cf7`: the REST twin of `model.options`.
    "GET /api/model/options": () => {
      if (!this.restModelOptions) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
      return this.restModelOptions;
    },
    // `hermes_cli/web_routers/profiles.py` `_profile_to_dict` at the deployed `bf0203a`, trimmed to what matters here.
    "GET /api/profiles": () => ({
      profiles: ["default", ...Object.keys(this.otherProfiles)].map((name) => ({
        name,
        path: name === "default" ? "/home/liam/.hermes" : `/home/liam/.hermes/profiles/${name}`,
        is_default: name === "default",
        model: this.profileModel[name]?.model ?? null,
        provider: this.profileModel[name]?.provider ?? null,
        description: "",
        display_name: "",
      })),
    }),
  };

  private onEvent?: (e: PipeEvent) => void;
  private imagesStaged = 0;
  private resumed = 0;
  private asked = 0;
  closed = false;

  openPipe: OpenPipe = async (onEvent, profile) => {
    if (this.refuse !== undefined) throw new Error(this.refuse);
    this.opened++;
    this.wsProfiles.push(profile);
    this.closed = false;
    // Runtime sessions belong to the connection that started them; closing it detaches them (research doc §5).
    this.runtime.clear();
    this.onEvent = onEvent;
    // The server writes gateway.ready as soon as the socket is accepted.
    this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.readyPayload } });
    // A new connection hasn't said yet whether it answers server→client requests.
    this.answersRequests = false;
    const send = async (text: string) => {
      if (this.failSend !== undefined) throw new Error(this.failSend);
      const req = JSON.parse(text) as Request | Response;
      if (!("method" in req)) {
        this.responses.push(req);
        this.openRequests.delete(req.id);
        return;
      }
      this.requests.push(req);
      this.handlers[req.method]?.(req);
    };
    return {
      route: this.route,
      send,
      // Mirrors the Rust side (src-tauri/src/transport.rs): sizes from the disk, and a size check before sending.
      statFiles: async (paths) => paths.map((path) => this.stat(path)),
      sendFile: async (head, path, tail, maxBytes) => {
        const f = this.stat(path);
        if (f.error) throw new Error(f.error);
        if (f.size! > maxBytes) throw new Error(`it's ${(f.size! / MiB).toFixed(1)} MB now, over the ${maxBytes / MiB} MB limit`);
        const bytes = this.files[path];
        if (typeof bytes !== "string") throw new Error(`the fake has only a size for ${path}, no bytes to send`);
        await send(head + btoa(bytes) + tail);
      },
      request: async (method, pathAndQuery, body) => {
        const url = new URL(pathAndQuery, "http://dashboard/");
        const req: RestRequest = { method, path: url.pathname, query: url.searchParams, body: body === undefined ? undefined : JSON.parse(body) };
        this.restRequests.push(req);
        const patch = /^\/api\/sessions\/([^/]+)$/.exec(req.path);
        const snapshot = /^\/api\/sessions\/([^/]+)\/mutation-snapshot$/.exec(req.path);
        const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(req.path);
        const handler =
          this.rest[`${method} ${req.path}`] ??
          (method === "PATCH" && patch ? () => this.patchSession(patch[1], req.body!) : undefined) ??
          (method === "GET" && patch ? () => this.sessionDetail(decodeURIComponent(patch[1]), req.query.get("profile")) : undefined) ??
          (method === "DELETE" && patch ? () => this.deleteSession(decodeURIComponent(patch[1]), req.query.get("profile")) : undefined) ??
          (method === "GET" && snapshot ? () => this.mutationSnapshot(snapshot[1], req.query.get("profile")) : undefined) ??
          (method === "GET" && messages ? () => this.storedMessages(decodeURIComponent(messages[1]), req.query) : undefined);
        if (!handler) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
        return JSON.stringify(await handler(req));
      },
      close: async () => {
        this.closed = true;
      },
    };
  };

  respond(id: number, result: unknown) {
    this.frame({ jsonrpc: "2.0", id, result });
  }

  fail(id: number, code: number, message: string) {
    this.frame({ jsonrpc: "2.0", id, error: { code, message } });
  }

  event(sessionId: string, type: string, payload: Record<string, unknown> = {}) {
    this.frame({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
  }

  /** A session-less broadcast such as `sessions.changed` (tui_gateway `_broadcast_global_event`). */
  broadcast(type: string, payload: Record<string, unknown> = {}) {
    this.event("", type, payload);
  }

  /**
   * Asks the client something (`server_requests.send_async`) and returns the request's id. A connection that never
   * said it answers such requests is sent nothing, and the request fails at once. A request asked while the
   * connection is down stays open for the next resume.
   */
  ask(sid: string, method: string, params: Record<string, unknown>): string | undefined {
    if (!this.answersRequests) return undefined;
    const id = `srq-${(++this.asked).toString(16).padStart(12, "0")}`;
    this.openRequests.set(id, { sid, stored: this.runtime.get(sid)!, method, params });
    this.frame({ jsonrpc: "2.0", id, method, params: { session_id: sid, ...params } });
    return id;
  }

  /** An `approval` request as `server._approval_request_payload` renders it: the command redacted, the choices set. */
  askApproval(sid: string, over: Record<string, unknown> = {}) {
    const params = {
      request_id: `apr-${this.asked + 1}`,
      command: "rm -rf /var/log/old",
      description: "recursive delete",
      allow_session: true,
      allow_permanent: true,
      tool_name: "terminal",
      choices: ["once", "session", "always", "deny"],
      ...over,
    };
    return { id: this.ask(sid, "approval", params), requestId: params.request_id };
  }

  /** Hermes stops waiting for an answer (timeout, interrupt, answered elsewhere) and withdraws the request. */
  cancelRequest(id: string, reason: string) {
    const q = this.openRequests.get(id);
    if (!q) return;
    this.openRequests.delete(id);
    this.event(q.sid, "request.cancel", { id, method: q.method, reason });
  }

  drop(reason = "closed by the server (1006 )") {
    this.onEvent?.({ kind: "closed", reason });
  }

  last(method: string) {
    return [...this.requests].reverse().find((r) => r.method === method);
  }

  /** A profile's model, effort and fast mode as its config has them: Sonnet at medium effort unless a test set one. */
  defaultModel(profile?: string | null): ModelInfo {
    return this.profileModel[profile || "default"] ?? { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
  }

  /**
   * Stores a message in a session's history, as `session.resume` and the stored rows read it back. It gets the next
   * row id unless it brings one, and the time now.
   */
  storeMessage(stored: string, m: TranscriptMessage) {
    const row_id = m.row_id ?? Math.max(0, ...Object.values(this.transcripts).flat().map((t) => t.row_id ?? 0)) + 1;
    (this.transcripts[stored] ??= []).push({ timestamp: Math.floor(now()), ...m, row_id });
  }

  /** The runtime session id the server handed out for a stored session. */
  runtimeIdOf(stored: string) {
    return [...this.runtime].reverse().find(([, s]) => s === stored)?.[0];
  }

  private stat(path: string): LocalFile {
    const name = path.split("/").pop()!;
    const f = this.files[path];
    if (f === undefined) return { path, name, error: "No such file or directory (os error 2)" };
    if (typeof f === "object" && "dir" in f) return { path, name, error: "it's a folder" };
    return { path, name, size: typeof f === "string" ? f.length : f.size };
  }

  /** A profile's stored sessions; no profile means the default one. Undefined for a profile the server doesn't have. */
  store(profile?: string | null): SessionRow[] | undefined {
    return !profile || profile === "default" ? this.sessions : this.otherProfiles[profile];
  }

  private storeOrFail(profile?: string | null): SessionRow[] {
    const store = this.store(profile);
    if (!store) throw new Error(`The dashboard answered 404: {"detail":"Profile '${profile}' not found"}`);
    return store;
  }

  /**
   * `GET /api/sessions/{id}/messages` (`hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`): stored rows,
   * `SELECT *` from `messages`, oldest first or `order=latest` newest first, a page of `limit` from `offset`. Only rows
   * with a stored id are there: a live session's unstored tail isn't.
   */
  private storedMessages(id: string, query: URLSearchParams) {
    const rows = (this.transcripts[id] ?? [])
      .filter((m) => m.row_id !== undefined)
      .map((m) => ({ id: m.row_id!, session_id: id, role: m.role, content: m.text ?? m.content ?? null, timestamp: m.timestamp ?? null }));
    if (query.get("order") === "latest") rows.reverse();
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 100);
    return { session_id: id, profile: query.get("profile") ?? "default", messages: rows.slice(offset, offset + limit), pagination: {} };
  }

  /** `GET /api/sessions/{id}/mutation-snapshot` (`hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`). */
  private mutationSnapshot(id: string, profile: string | null) {
    const s = this.storeOrFail(profile).find((r) => r.id === id);
    return { session_id: id, exists: !!s, runtime_revision: s?.runtime_revision ?? 0, runtime_generation: s ? 0 : null };
  }

  /** `GET /api/sessions/{id}` (`get_session_detail` at the deployed `bf0203a`): the raw row, its flags stored as 0/1. */
  private sessionDetail(id: string, profile: string | null) {
    const s = this.storeOrFail(profile).find((r) => r.id === id);
    if (!s) throw new Error(`The dashboard answered 404: {"detail":"Session not found"}`);
    return { ...s, archived: s.archived ? 1 : 0, pinned: s.pinned ? 1 : 0, runtime_revision: s.runtime_revision ?? 0, profile: profile ?? "default" };
  }

  /**
   * `PATCH /api/sessions/{id}`, fenced like the deployed `bf0203a` (`_mutate_session_request`, `mutate_runtime_session`):
   * an edit without `request_id` and `expected_revision` is refused, and so is one naming an old revision.
   */
  private patchSession(id: string, body: Record<string, unknown>) {
    if (body.request_id === undefined && body.expected_revision === undefined)
      throw new Error(
        `The dashboard answered 409: {"detail":"client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions"}`,
      );
    if (body.request_id === undefined || body.expected_revision === undefined)
      throw new Error(`The dashboard answered 409: {"detail":"mutation_identity_required"}`);
    const s = this.storeOrFail(body.profile as string | undefined).find((r) => r.id === id);
    if (!s) throw new Error(`The dashboard answered 404: {"detail":"not_found"}`);
    if (body.expected_revision !== (s.runtime_revision ?? 0)) throw new Error(`The dashboard answered 409: {"detail":"revision_conflict"}`);
    s.runtime_revision = (s.runtime_revision ?? 0) + 1;
    if (typeof body.pinned === "boolean") s.pinned = body.pinned;
    if (typeof body.archived === "boolean") s.archived = body.archived;
    if (typeof body.unread === "boolean") s.last_read_at = body.unread ? 0 : now();
    if (typeof body.title === "string") {
      // `set_session_title`: titles are unique in a profile, and a clash is a 400 (`_mutate_session_request`).
      const title = body.title.trim();
      if (title && this.storeOrFail(body.profile as string | undefined).some((r) => r !== s && r.title === title))
        throw new Error(`The dashboard answered 400: {"detail":"Title '${title}' is already in use by session ${id}"}`);
      s.title = title || null;
    }
    return { ok: true };
  }

  /**
   * `delete_session_endpoint` in `hermes_cli/web_routers/sessions.py` at upstream `c419cf7`: the row and its messages
   * go for good. A session already gone counts as deleted.
   */
  private deleteSession(id: string, profile: string | null) {
    const store = this.storeOrFail(profile);
    const i = store.findIndex((r) => r.id === id);
    if (i < 0) return { ok: true, already_absent: true };
    store.splice(i, 1);
    delete this.transcripts[id];
    return { ok: true, deleted_ids: [id] };
  }

  private frame(f: unknown) {
    this.onEvent?.({ kind: "frame", text: JSON.stringify(f) });
  }
}

/** `SessionDB.session_unread`: activity postdates the read watermark, and `null` means read. */
export function unread(s: SessionRow): boolean {
  return s.last_read_at !== null && (s.last_active ?? s.started_at) > s.last_read_at;
}

/** `tui_gateway/prompt_attachments.py::_format_ref_value`: quote a ref with whitespace, brackets or quotes. */
function formatRefValue(value: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(value)) return value;
  const q = ["`", '"', "'"].find((q) => !value.includes(q));
  return q ? `${q}${value}${q}` : value;
}
