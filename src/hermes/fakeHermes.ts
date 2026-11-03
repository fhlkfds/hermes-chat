// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import type { LocalFile, OpenPipe, PipeEvent, Route, Speech, ToolsetGuards, VoiceSetup } from "./pipe";
import type { SavedKey } from "./setup";
import { FakeServerFiles } from "./fakeServerFiles";
import { ScheduleError, isoIn, parseSchedule, upcomingRuns } from "./schedule";

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
  /**
   * Hermes's stored usage for every model call in the session (`sessions` columns at the deployed `bf0203a`; both list
   * and detail rows carry them). Hermes's helper tasks are kept apart and aren't counted here.
   */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  api_call_count?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  cost_status?: string | null;
  cost_source?: string | null;
  pricing_version?: string | null;
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
  /** A tool row's whole result as Hermes stores it, which `session.resume` leaves out (`content` is only for edit tools). */
  result?: string;
  /** An assistant row's tool calls as stored: `[{id, type, function: {name, arguments}}]`, `arguments` JSON text. */
  tool_calls?: unknown;
};

/** A file on the owner's disk: its bytes as a string, a size alone for a file too big to make, or a folder. */
export type FakeFile = string | { size: number } | { dir: true };

/** A stored project as `Project.to_dict` sends it (`hermes_cli/projects_db.py` at the deployed `bf0203a`). */
export type FakeProject = {
  id: string;
  slug: string;
  name: string;
  primary_path: string | null;
  archived: boolean;
  created_at: number;
  folders: { path: string; label: string | null; is_primary: boolean; added_at: number }[];
};

/** One worktree of a repository on the server, as `GET /api/git/worktrees` lists it (`web_git.worktree_list`). */
export type FakeWorktree = { path: string; branch?: string; detached?: boolean };

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

/** A profile's `GET /api/env`, trimmed: three provider keys (OpenRouter set), a shared key, and rows that aren't provider keys. */
export function fakeEnv(): Record<string, Record<string, unknown>> {
  const key = (provider: string, provider_label: string, url: string, over: Record<string, unknown> = {}) => ({
    is_set: false,
    redacted_value: null,
    url,
    is_password: true,
    channel_managed: false,
    provider,
    provider_label,
    provider_primary: true,
    provider_profiles: [],
    ...over,
  });
  return {
    OPENROUTER_API_KEY: key("openrouter", "OpenRouter", "https://openrouter.ai/keys", { is_set: true, redacted_value: "sk-…f3" }),
    ANTHROPIC_API_KEY: key("anthropic", "Anthropic", "https://console.anthropic.com/settings/keys"),
    ANTHROPIC_TOKEN: key("anthropic", "Anthropic", "", { provider_primary: false }),
    DEEPSEEK_API_KEY: key("deepseek", "DeepSeek", "https://platform.deepseek.com/api_keys"),
    DASHSCOPE_API_KEY: key("alibaba", "Alibaba Cloud (DashScope)", "", {
      provider_profiles: [{ provider: "alibaba-cn", provider_label: "Alibaba Cloud China", url: "", primary: true }],
    }),
    OPENAI_BASE_URL: key("openai-api", "OpenAI", "", { is_password: false }),
    TELEGRAM_BOT_TOKEN: { is_set: true, redacted_value: "12…9", is_password: true, channel_managed: true, provider: "", provider_label: "" },
    MY_CUSTOM_VAR: { is_set: true, redacted_value: "…", is_password: true, channel_managed: false, provider: "", custom: true },
  };
}

const DAY = 86_400;
const MiB = 1024 * 1024;
const now = () => Date.now() / 1000;

/**
 * A memory entry's fingerprint in its node id. Hermes's is the first 12 hex digits of the SHA-256 of the text
 * (`agent/learning_graph.memory_fingerprint`); the client never computes one, so the fake uses a stand-in digest.
 */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 12);
}

/** `_normalize_path`: absolute (a relative path is read from the server's home folder), no trailing slash. */
const serverPath = (path: string) => {
  const p = path.trim().startsWith("/") ? path.trim() : `/home/liam/${path.trim()}`;
  return p.replace(/\/+$/, "") || "/";
};

function setPrimary(p: FakeProject, path: string) {
  for (const f of p.folders) f.is_primary = f.path === path;
  p.primary_path = path;
}

/**
 * The sources whose stored rows the gateway takes a session edit on. A local client's row is owner history only with a
 * source the native resume adopts (`LEGACY_LOCAL_SOURCES` in `hermes_state_local_migration.py`, plus `import`;
 * `authorize_history` at the deployed `bf0203a`); a messaging platform's row is mounted by its route. Any other row,
 * such as one stamped with a custom source, can't be mounted, and the edit is answered 404 `not_found` though the row
 * exists (`restore_api_session`).
 */
const EDITABLE_SOURCES = new Set(["cli", "tui", "gui", "desktop", "oneshot", "tool", "acp", "import", "telegram", "discord", "slack", "whatsapp", "signal", "matrix"]);

/** A stored session `daysAgo` days old, unpinned and from this app unless overridden. */
export function row(id: string, daysAgo: number, over: Partial<SessionRow> = {}): SessionRow {
  const at = now() - daysAgo * DAY;
  return { id, source: "gui", title: `Chat ${id}`, preview: "", started_at: at, last_active: at, message_count: 2, pinned: false, archived: false, last_read_at: null, ...over };
}

/** A session edit's body without the request id and revision every edit carries. */
export function editFlags(body: Record<string, unknown> | undefined) {
  const { request_id: _id, expected_revision: _revision, ...flags } = body ?? {};
  return flags;
}

/** Hermes's `_FS_PREVIEW_LANGUAGE_BY_EXT` and `_fs_mime_type` at `bf0203a`, as far as the tests need them. */
const FS_LANGUAGES: Record<string, string> = { py: "python", md: "markdown", html: "html", ts: "typescript", json: "json", txt: "text", sh: "shell" };
const FS_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", py: "text/x-python", md: "text/markdown", html: "text/html",
  txt: "text/plain", json: "application/json", pdf: "application/pdf", ts: "video/mp2t",
};

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
  /**
   * Each profile's SOUL.md as the file holds it, by profile name; a profile left out has none. Read and written as
   * `GET`/`PUT /api/profiles/{name}/soul` do at the deployed `bf0203a` (persona.ts).
   */
  souls: Record<string, string> = {};
  /** False: the server is older than the persona routes, and answers them as `bf0203a` answers a path it hasn't. */
  soulRoutes = true;
  /** While set, `GET …/soul` fails with this message (e.g. a 500 for a file Hermes may not read). */
  soulReadError?: string;
  /** While set, `PUT …/soul` fails with this message and writes nothing. */
  soulWriteError?: string;
  /** While set, `PUT …/soul` writes the file, then fails with this message, as a connection lost before the answer. */
  soulWriteLost?: string;
  /** Runs as a `PUT …/soul` arrives, before it writes: another client's write in the middle of a Save. */
  beforeSoulWrite?: () => void;
  /** Runs after a `PUT …/soul` wrote: another client writing again before the read-back. */
  afterSoulWrite?: () => void;
  /** Profile distributions, by profile name, as `GET /api/profiles` lists them (`distribution_name`). */
  distributions: Record<string, string> = {};
  /**
   * Scheduled jobs by profile, as `cron/jobs.json` holds them, and how the cron routes behave
   * (`hermes_cli/web_routers/cron.py` at the deployed `bf0203a`, as probed with a throwaway HERMES_HOME).
   */
  cron: FakeCron = new FakeCron(this);
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
  /** The server commands `commands.catalog` lists; undefined for a Hermes without the method. */
  commandCatalog: string[] | undefined = ["steer", "context", "compress", "help"];
  /** The profile's quick commands (`quick_commands` in config.yaml), by name, with their description. */
  quickCommands: Record<string, string> = {};
  /** A `/steer` is queued for the running turn; false answers as Hermes does with no turn running. */
  steerable = true;
  contextOutput = "Context window: 12,400 / 200,000 tokens (6%)\n  System prompt  3,100\n  Messages       9,300";
  oneshotFailure?: string;
  /** The owner's local disk, by path, for attachments. */
  files: Record<string, FakeFile> = {};
  /**
   * The profile's voice set-up as the Rust side reads it (`Dashboard::voice_setup`). With `transcribe` or `speak`
   * false the server has no such route, and calling it fails as Rust reports that.
   */
  voice: VoiceSetup = { transcribe: true, speak: true, sttEnabled: true, sttProvider: "local", ttsProvider: "edge" };
  /** What Hermes hears in every recording (empty for no speech), or why transcribing fails. */
  heard: string | Error = "Check the backup logs";
  /** What reading aloud answers, or why it fails. */
  speech: Speech | Error = { mime: "audio/mpeg", audio: new Uint8Array([0x49, 0x44, 0x33, 4]), provider: "edge" };
  /** While set, transcribing and reading aloud wait for it before they answer. */
  voiceGate?: Promise<void>;
  /** Every recording sent to transcribe, and every text sent to read aloud, in order. */
  readonly recordings: { profile: string; audio: Uint8Array; mime: string }[] = [];
  readonly spoken: { profile: string; text: string }[] = [];
  /**
   * The server's disk, by path, for the preview pane's `GET /api/fs/read-text` and `read-data-url`. A string is the
   * file's text (or bytes, one char per byte); `{ dir: true }` is a folder.
   */
  serverFiles: Record<string, string | { dir: true }> = {};
  /** The server's own disk, for the Server files screen (managed files: `GET /api/files`, `GET /api/files/read`). */
  readonly managedFiles = new FakeServerFiles();
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
  /**
   * What dashboard REST `GET /api/model/options` answers. Undefined serves the catalog in `modelConfig`, as Hermes
   * does; null is a 404, as a dashboard without the route would answer.
   */
  restModelOptions?: Record<string, unknown> | null;
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

  /**
   * The profile's `.env` rows as `GET /api/env` lists them (`hermes_cli/web_routers/config_env.py` at the deployed
   * `bf0203a`), trimmed. Undefined is a 404, as on a server without the route.
   */
  env?: Record<string, Record<string, unknown>> = fakeEnv();
  /** Provider keys saved through `saveProviderKey`, as (profile, env var, key). */
  readonly savedKeys: { profile: string; envVar: string; key: string }[] = [];
  /** What the provider says of a key: `sk-bad` is turned down, `sk-offline` can't be checked, anything else passes. */
  checkKey = (key: string): { ok: boolean; reachable: boolean; message: string } =>
    key === "sk-bad"
      ? { ok: false, reachable: true, message: "That API key was rejected. Double-check it and try again." }
      : key === "sk-offline"
        ? { ok: false, reachable: false, message: "Could not reach the provider to verify the key." }
        : { ok: true, reachable: true, message: "" };
  /** Each profile's projects (`projects.db`), by profile name; a profile the server has but that isn't here has none. */
  projects: Record<string, FakeProject[]> = {};
  /**
   * More of the server's folders, by absolute path without a trailing slash, for `GET /api/fs/list`. That route lists
   * these and `serverFiles` together; a `{ dir: true }` entry there is a folder too.
   */
  serverDirs = new Set<string>();
  /** The server's git repositories, each one's worktrees with its own checkout first (`git worktree list`). */
  repos: FakeWorktree[][] = [];
  private projectSeq = 0;
  /** The `info` session.create and session.resume answer with (`server._session_info`); empty, as from a server
   * that reports none of it, unless a test sets it. */
  sessionInfo: Record<string, unknown> = {};
  /**
   * Each runtime session's working folder. As live at the deployed `bf0203a` (probed 2026-11-02 against a throwaway
   * HERMES_HOME): `session.create` takes a `cwd` that is a folder on the server, and quietly runs in Hermes's own
   * folder (`hermesHome`) when it isn't one.
   */
  readonly sessionCwd = new Map<string, string>();
  hermesHome = "/home/hermes";

  /**
   * Each profile's built-in memory, by profile name: `memory` is MEMORY.md's entries and `profile` USER.md's, as
   * `MemoryStore._parse_entries` reads them (stripped, none empty). A profile not here has none.
   */
  memory: Record<string, { memory: string[]; profile: string[] }> = {};
  /** The profile the dashboard process runs as (`GET /api/profiles/active` → `current`), whose memory `learning.*` reach. */
  servedProfile = "default";
  /** Each memory file's limit in characters (`memory_char_limit`, `user_char_limit` defaults at `bf0203a`). */
  memoryLimit: Record<"memory" | "profile", number> = { memory: 2200, profile: 1375 };
  /** False: a server older than the `learning.*` methods, which answers them "method not found". */
  learningMethods = true;
  /** An external memory provider the profile uses (`GET /api/memory` → `active`); none when empty. */
  memoryProvider = "";
  /** Runs before each `learning.*` request is answered, e.g. to change memory as the agent would meanwhile. */
  beforeLearning?: (method: string, params: Record<string, unknown>) => void;
  /** Answers the next `learning.edit` or `learning.delete` with this JSON-RPC error instead of writing. Applies once. */
  learningError?: { code: number; message: string };
  /**
   * The next `learning.edit` or `learning.delete` drops the connection before Hermes answers. `applied`: Hermes wrote
   * it first. `lost`: the frame never reached Hermes. Applies once.
   */
  dropOnLearning?: "applied" | "lost";
  /**
   * What `session.active_list` lists: the sessions live in the dashboard's process, in every profile, as
   * `_session_live_item` renders them at the deployed `bf0203a` (`tui_gateway/session_registry.py`). Rows carry no
   * profile; `status` is `waiting` while a server→client request is open, else `starting`, `working` or `idle`.
   */
  liveSessions: { id: string; session_key: string; status: string; last_active: number; started_at?: number; title?: string; preview?: string }[] = [];

  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    "session.active_list": (r) => this.respond(r.id, { sessions: this.liveSessions.map((l) => ({ current: false, message_count: 0, model: "", preview: "", title: "", started_at: l.last_active, ...l })) }),
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
      const cwd = typeof p.cwd === "string" && this.serverDirs.has(p.cwd) ? p.cwd : this.hermesHome;
      this.sessionCwd.set(runtimeId, cwd);
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 0, messages: [], info: { ...this.sessionInfo, ...info, cwd } });
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
        return this.respond(r.id, { session_id: sid, stored_session_id: stored, message_count: messages.length, messages, info: this.sessionInfo, running: true, open_requests });
      }
      const runtimeId = `rt-r${++this.resumed}`;
      this.runtime.set(runtimeId, stored);
      const messages = this.transcripts[stored] ?? [];
      const info = { ...this.sessionInfo, ...this.sessionModel.get(stored) };
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
    // `commands.catalog` (tui_gateway/methods_tools.py, `command_discovery.command_catalog`) at the deployed `bf0203a`:
    // `canon` maps every listed name and alias to the command's own name. Older servers have no such method.
    "commands.catalog": (r) => {
      if (!this.commandCatalog) return this.fail(r.id, -32601, "unknown method: commands.catalog");
      const canon = Object.fromEntries(this.commandCatalog.flatMap((n) => [[`/${n}`, `/${n}`], ...(n === "steer" ? [["/s", "/steer"]] : [])]));
      const user = Object.keys(this.quickCommands).map((n) => [`/${n}`, this.quickCommands[n]]);
      this.respond(r.id, {
        pairs: [...this.commandCatalog.map((n) => [`/${n}`, n]), ...user], canon, commands: {},
        categories: [{ name: "Session", pairs: this.commandCatalog.map((n) => [`/${n}`, n]) }, ...(user.length ? [{ name: "User commands", pairs: user }] : [])],
        skills: {}, skill_count: 0, warning: "", plugin_discovery_error: "", plugin_commands: {},
      });
    },
    // `command.dispatch` `_cmd_steer`: queued for a running turn; with none, Hermes asks for it to be sent as a message.
    "command.dispatch": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      if (r.params.name !== "steer") return this.fail(r.id, 4018, `not a quick/plugin/bundle/skill command: ${r.params.name}`);
      const arg = String(r.params.arg ?? "");
      if (!arg) return this.fail(r.id, 4004, "usage: /steer <prompt>");
      if (!this.steerable) return this.respond(r.id, { type: "send", message: arg, notice: `No agent running; sent as next turn: ${arg}` });
      this.respond(r.id, { type: "exec", output: `⏩ Steer queued — arrives after the next tool call: ${arg}` });
    },
    // `slash.exec` for `/context`, answered from the live session.
    "slash.exec": (r) => {
      if (!this.runtime.has(String(r.params.session_id))) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { output: this.contextOutput });
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
    // `tui_gateway/methods_projects.py` at the deployed `bf0203a`, checked live against a throwaway HERMES_HOME
    // (research doc "Projects"): 5062 for an id that resolves to nothing, 5063 for an invalid argument, 4064 for a
    // profile the server doesn't have. Writes answer with the refreshed project; delete with every project.
    "projects.list": (r) => this.projectsOp(r, (list) => ({ projects: list, active_id: null })),
    "projects.create": (r) =>
      this.projectsOp(r, (list) => {
        const name = String(r.params.name ?? "").trim();
        if (!name) throw [5063, "project name must not be empty"];
        const at = Math.floor(now());
        const folders = ((r.params.folders as string[] | undefined) ?? []).map(serverPath);
        const p: FakeProject = {
          id: `p_${(++this.projectSeq).toString(16).padStart(8, "0")}`,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
          name,
          primary_path: folders[0] ?? null,
          archived: false,
          created_at: at,
          folders: folders.map((path, i) => ({ path, label: null, is_primary: i === 0, added_at: at })),
        };
        list.push(p);
        return { project: p };
      }),
    "projects.update": (r) =>
      this.projectOp(r, (p) => {
        if (r.params.name !== undefined && r.params.name !== null) {
          const name = String(r.params.name).trim();
          if (!name) throw [5063, "project name must not be empty"];
          p.name = name;
        }
      }),
    "projects.add_folder": (r) =>
      this.projectOp(r, (p) => {
        const path = serverPath(String(r.params.path ?? ""));
        if (!p.folders.some((f) => f.path === path)) p.folders.push({ path, label: null, is_primary: false, added_at: Math.floor(now()) });
        if (!p.folders.some((f) => f.is_primary)) setPrimary(p, path);
      }),
    "projects.remove_folder": (r) =>
      this.projectOp(r, (p) => {
        const path = serverPath(String(r.params.path ?? ""));
        const was = p.folders.find((f) => f.path === path);
        p.folders = p.folders.filter((f) => f.path !== path);
        if (was?.is_primary) {
          if (p.folders[0]) setPrimary(p, p.folders[0].path);
          else p.primary_path = null;
        }
      }),
    "projects.delete": (r) =>
      this.projectsOp(r, (list) => {
        const at = list.findIndex((p) => p.id === r.params.id);
        if (at < 0) throw [5062, "no such project"];
        list.splice(at, 1);
        return { projects: list, active_id: null };
      }),
    // Keepalive, answered by the WS layer in either protocol generation (research doc §1).
    "gateway.ping": (r) => this.respond(r.id, { ok: true }),
    // Memory (`tui_gateway/methods_tools.py` and `agent/learning_mutations.py` at the deployed `bf0203a`). The calls take
    // no profile and act on the served profile's memory; their contracts refuse any extra param.
    "learning.frames": (r) => this.learning(r, ["cols", "rows", "frames"], () => this.memoryFrames()),
    "learning.detail": (r) =>
      this.learning(r, ["id"], () => {
        const found = this.memoryEntry(String(r.params.id ?? ""));
        if (typeof found === "string") return { ok: false, message: found };
        return { ok: true, kind: "memory", id: r.params.id, label: found.text.split("\n")[0].slice(0, 80), content: found.text };
      }),
    "learning.edit": (r) => this.learning(r, ["id", "content"], () => this.memoryWrite(r, String(r.params.content ?? ""))),
    "learning.delete": (r) => this.learning(r, ["id"], () => this.memoryWrite(r, null)),
    // `session.cwd.set` (`tui_gateway/methods_session.py` at `bf0203a`): only an idle session, only a folder that's there.
    "session.cwd.set": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      const cwd = String(r.params.cwd ?? "");
      if (!this.serverDirs.has(cwd)) return this.fail(r.id, 4017, `working directory does not exist: ${cwd}`);
      this.sessionCwd.set(sid, cwd);
      this.respond(r.id, { ...this.sessionInfo, cwd });
    },
    "session.close": (r) => this.respond(r.id, { closed: true }),
  };

  /** Per-route REST behaviour, keyed `METHOD /path`. A handler throws to fail the request. */
  readonly rest: Record<string, RestHandler> = {
    // `fs_list` (`hermes_cli/web_routers/files.py` at the deployed `bf0203a`): a folder's entries, or none and why.
    "GET /api/fs/list": ({ query }) => {
      const path = query.get("path") ?? "";
      const all = new Set([...this.serverDirs, ...Object.keys(this.serverFiles)]);
      // A folder holding a file or folder is there too, as on a real disk.
      const isDir = (p: string) => this.serverDirs.has(p) || typeof this.serverFiles[p] === "object" || [...all].some((q) => q.startsWith(`${p}/`));
      if (typeof this.serverFiles[path] === "string") return { entries: [], error: "ENOTDIR" };
      if (!isDir(path)) return { entries: [], error: "ENOENT" };
      const inside = [...all].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"));
      return { entries: inside.map((p) => ({ name: p.split("/").pop(), path: p, isDirectory: isDir(p) })) };
    },
    // `git_worktrees_route`: every worktree of the repository the path is in, its own checkout first; none outside one.
    "GET /api/git/worktrees": ({ query }) => {
      const path = query.get("path") ?? "";
      const repo = this.repos.find((trees) => trees.some((t) => path === t.path || path.startsWith(`${t.path}/`)));
      return { worktrees: (repo ?? []).map((t, i) => ({ path: t.path, branch: t.branch ?? null, isMain: i === 0, detached: !!t.detached, locked: false })) };
    },
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
    // `hermes_cli/web_routers/files.py` `fs_read_text` at the deployed `bf0203a`, as probed live: the first 512 KB,
    // binary judged by `_fs_looks_binary`, credential files refused.
    "GET /api/fs/read-text": ({ query }) => {
      const { path, data } = this.serverFile(query);
      const head = data.slice(0, 4096);
      const control = [...head].filter((c) => c.charCodeAt(0) < 32 && !"\t\n\r".includes(c)).length;
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
      return {
        binary: head.includes("\0") || (head.length > 0 && control / head.length > 0.12),
        byteSize: data.length,
        language: FS_LANGUAGES[ext] ?? "text",
        mimeType: FS_MIME[ext] ?? "application/octet-stream",
        path,
        text: data.slice(0, 512 * 1024),
        truncated: data.length > 512 * 1024,
      };
    },
    // `fs_read_data_url`: any regular file as a data URL, up to 16 MB; the MIME type goes by its extension.
    "GET /api/fs/read-data-url": ({ query }) => {
      const { path, data } = this.serverFile(query);
      if (data.length > 16 * 1024 * 1024) throw new Error(`The dashboard answered 413: {"detail":"File too large"}`);
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
      return { dataUrl: `data:${FS_MIME[ext] ?? "application/octet-stream"};base64,${btoa(data)}` };
    },
    "GET /api/env": () => {
      if (!this.env) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
      return this.env;
    },
    // `get_active_profile_endpoint`: the sticky profile, and the one this dashboard process runs as.
    "GET /api/profiles/active": () => ({ active: "default", current: this.servedProfile }),
    // `get_memory_status` (`hermes_cli/web_routers/ops.py`): the provider and the built-in files' sizes in bytes.
    "GET /api/memory": ({ query }) => {
      const profile = query.get("profile") || this.servedProfile;
      if (profile !== "default" && !(profile in this.otherProfiles) && !(profile in this.memory))
        throw new Error(`The dashboard answered 404: {"detail":"Profile '${profile}' does not exist."}`);
      const m = this.memory[profile] ?? { memory: [], profile: [] };
      const bytes = (entries: string[]) => new TextEncoder().encode(entries.join("\n§\n")).length;
      return { active: this.memoryProvider, providers: [], builtin_files: { memory: bytes(m.memory), user: bytes(m.profile) } };
    },
    "GET /api/files": ({ query }) => this.managedFiles.list(query),
    "GET /api/files/read": ({ query }) => this.managedFiles.read(query),
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
        distribution_name: this.distributions[name] ?? null,
      })),
    }),
    // Settings → Model (hermes_cli/web_routers/models.py, config_env.py, delegation.py at the deployed `bf0203a`).
    // `get_model_options` is also the REST twin of `model.options`, which the composer's picker falls back to.
    "GET /api/model/options": () => {
      if (this.restModelOptions === null) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
      return (
        this.restModelOptions ?? {
          model: this.modelConfig.model.default,
          provider: this.modelConfig.model.provider,
          providers: this.modelConfig.catalog.map((p) => ({ ...p, is_current: p.slug === this.modelConfig.model.provider, authenticated: true })),
        }
      );
    },
    "GET /api/model/auxiliary": () => ({
      tasks: Object.entries(this.modelConfig.auxiliary).map(([task, a]) => ({
        task,
        provider: a.provider || "auto",
        model: a.model,
        base_url: a.base_url ?? "",
        reasoning_effort: a.reasoning_effort || null,
        local_endpoint: /^https?:\/\/(127\.|10\.|192\.168\.|localhost)/.test(a.base_url ?? ""),
      })),
      main: { provider: this.modelConfig.model.provider, model: this.modelConfig.model.default },
    }),
    "GET /api/config": () => ({
      model: this.modelConfig.model.default,
      agent: { ...this.modelConfig.agent },
      delegation: { ...this.modelConfig.delegation },
      ...(this.cron.timezone && { timezone: this.cron.timezone }),
    }),
    "GET /api/delegation/routing": () => ({
      configured: "default",
      blocked_reason: null,
      backends: [],
      model_map: { options: this.modelConfig.modelMap, default: null },
      profile_routes: { profiles: [], default: null },
      profiles: ["default"],
    }),
    "POST /api/model/set": ({ body }) => this.setModel(body ?? {}),
    "PUT /api/config": ({ body }) => {
      // `ConfigUpdate` needs `config`; the rest deep-merges over the stored file (`update_config`).
      const config = body?.config;
      if (!config || typeof config !== "object")
        throw new Error(`The dashboard answered 422: {"detail":[{"type":"missing","loc":["body","config"],"msg":"Field required"}]}`);
      const c = config as { agent?: Record<string, string>; delegation?: Record<string, unknown> };
      Object.assign(this.modelConfig.agent, c.agent ?? {});
      Object.assign(this.modelConfig.delegation, c.delegation ?? {});
      return { ok: true };
    },
  };

  /** The profile's model setup, as `config.yaml` holds it, and the catalog `model.options` lists. */
  modelConfig: FakeModelConfig = fakeModelConfig();

  /** The toolsets every profile lists (plugins aside, the catalog is the same for each). */
  toolsetCatalog: FakeToolset[] = fakeToolsets();
  /** Each profile's enabled toolsets, as its config.yaml resolves them; a profile not here has the defaults. */
  toolsetsOn: Record<string, Set<string>> = {};
  /**
   * Which toolset routes this server has: all, `read-only` (a list but no toggle route) or `none` (neither), each
   * missing one answering FastAPI's own 404.
   */
  toolsetRoutes: "all" | "read-only" | "none" = "all";
  /** While set, the toggle route refuses every change with this status and reason, writing nothing. */
  toolsetRefusal?: { status: number; detail: string };
  /** Names `agent.disabled_toolsets` strips through a composite: saving them on still reads back off. */
  toolsetSuppressed = new Set<string>();
  /** While set, the toggle route waits for it after writing and before it answers. */
  toolsetGate?: Promise<void>;
  /** While set, the toggle route waits for it before it writes. */
  toolsetGateBeforeWrite?: Promise<void>;
  /** Platforms whose saved toolset list names `no_mcp`, per profile. Any toggle for that platform clears it. */
  toolsetNoMcp: Record<string, Set<string>> = {};
  /** Platforms whose saved toolset list Rust can't read for certain, per profile. */
  toolsetNoMcpUnclear: Record<string, string[]> = {};
  /** `agent.coding_context` is focus, per profile. */
  codingFocus: Record<string, boolean> = {};
  /** `agent.disabled_toolsets`, per profile: off on every platform. Turning one of these on removes it, as Hermes does. */
  toolsetDisabledEverywhere: Record<string, string[]> = {};
  /** `agent.disabled_toolsets` saved in a form Rust can't read for certain, per profile. */
  toolsetDisabledUnclear: Record<string, boolean> = {};
  /** While set, reading the config for the toolset guards fails with this. */
  toolsetGuardsFailure?: string;
  /**
   * Each toolset's provider rows, as `GET /api/tools/toolsets/{name}/config` answers them (`provider_readiness_status`).
   * A toolset not here has no provider category. Checked live: web's keyless Exa row is ready and its ddgs row isn't.
   */
  toolsetProviders: Record<string, { name: string; post_setup?: string; status: string; is_active: boolean }[]> = {
    web: [
      { name: "Exa · Free (keyless)", status: "ready", is_active: false },
      { name: "DuckDuckGo (ddgs)", post_setup: "ddgs", status: "needs_setup", is_active: false },
    ],
    computer_use: [{ name: "cua-driver (background)", post_setup: "cua_driver", status: "needs_setup", is_active: false }],
    stt: [{ name: "Local Whisper", status: "ready", is_active: true }],
  };
  /** While set, the next toolset list read waits for it (once). */
  toolsetListGateOnce?: Promise<void>;
  /** While set, `GET /api/tools/toolsets/{name}/config` for that name waits for it. */
  toolsetConfigGate: Record<string, Promise<void>> = {};
  /** While set, `GET /api/tools/toolsets/{name}/config` fails with this. */
  toolsetConfigFailure?: string;
  /** The next toggle writes, then answers with this error anyway (a failure after the save, such as a 500). */
  failAfterToolsetWrite?: { status: number; detail: string };
  /** After the next toggle, every toolset list read fails with a 500. */
  toolsetReadsFailAfterWrite = false;
  private toolsetReadsFailing = false;
  /** The next toggle drops the connection before Hermes answers: `stored` wrote it first, `lost` never arrived. */
  dropOnToolsetWrite?: "stored" | "lost";
  /** Every toggle the route took, after validation: profile, name and value. */
  readonly toolsetWrites: { profile: string; name: string; enabled: boolean }[] = [];

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
      // Mirror `Dashboard::transcribe`, `speak` and `voice_setup` in src-tauri/src/transport.rs.
      transcribe: async (profile, audio, mime) => {
        this.recordings.push({ profile, audio, mime });
        await this.voiceGate;
        if (!this.voice.transcribe) throw new Error("This Hermes server can't transcribe recordings: it has no /api/audio/transcribe route. Updating Hermes adds it.");
        if (this.heard instanceof Error) throw this.heard;
        return { text: this.heard.trim(), provider: this.voice.sttProvider };
      },
      speak: async (profile, text) => {
        this.spoken.push({ profile, text });
        await this.voiceGate;
        if (!this.voice.speak) throw new Error("This Hermes server can't read replies aloud: it has no /api/audio/speak route. Updating Hermes adds it.");
        if (this.speech instanceof Error) throw this.speech;
        return this.speech;
      },
      voiceSetup: async () => ({ ...this.voice }),
      // Mirrors `Dashboard::toolset_guards`: only these two facts of the config.
      toolsetGuards: async (profile): Promise<ToolsetGuards> => {
        if (this.toolsetGuardsFailure) throw new Error(this.toolsetGuardsFailure);
        return {
          noMcp: [...(this.toolsetNoMcp[profile] ?? [])].sort(),
          noMcpUnclear: [...(this.toolsetNoMcpUnclear[profile] ?? [])],
          codingFocus: !!this.codingFocus[profile],
          disabledEverywhere: [...(this.toolsetDisabledEverywhere[profile] ?? [])],
          disabledUnclear: !!this.toolsetDisabledUnclear[profile],
        };
      },
      request: async (method, pathAndQuery, body) => {
        const url = new URL(pathAndQuery, "http://dashboard/");
        const req: RestRequest = { method, path: url.pathname, query: url.searchParams, body: body === undefined ? undefined : JSON.parse(body) };
        this.restRequests.push(req);
        const patch = /^\/api\/sessions\/([^/]+)$/.exec(req.path);
        const snapshot = /^\/api\/sessions\/([^/]+)\/mutation-snapshot$/.exec(req.path);
        const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(req.path);
        const soul = /^\/api\/profiles\/([^/]+)\/soul$/.exec(req.path);
        const handler =
          this.rest[`${method} ${req.path}`] ??
          (method === "PATCH" && patch ? () => this.patchSession(patch[1], req.body!) : undefined) ??
          (method === "GET" && patch ? () => this.sessionDetail(decodeURIComponent(patch[1]), req.query.get("profile")) : undefined) ??
          (method === "DELETE" && patch ? () => this.deleteSession(decodeURIComponent(patch[1]), req.query.get("profile")) : undefined) ??
          (method === "GET" && snapshot ? () => this.mutationSnapshot(snapshot[1], req.query.get("profile")) : undefined) ??
          (method === "GET" && messages ? () => this.storedMessages(decodeURIComponent(messages[1]), req.query) : undefined) ??
          (soul && this.soulRoutes && (method === "GET" || method === "PUT") ? () => this.soul(method, decodeURIComponent(soul[1]), req.body) : undefined) ??
          this.cron.route(req);
        const toolset = /^\/api\/tools\/toolsets(?:\/([^/]+)(\/config)?)?$/.exec(req.path);
        if (!handler && toolset) return JSON.stringify(await this.toolsetRoute(req, toolset[1], !!toolset[2]));
        if (soul && this.soulRoutes && method !== "GET" && method !== "PUT") throw new Error(`The dashboard answered 405: {"detail":"Method Not Allowed"}`);
        if (soul && !this.soulRoutes) throw new Error(`The dashboard answered 404: {"detail":"No such API endpoint: ${req.path}"}`);
        if (!handler) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
        return JSON.stringify(await handler(req));
      },
      // Mirrors the Rust side's `Dashboard::save_provider_key`: only a listed provider secret, checked, then saved.
      saveProviderKey: async (profile, envVar, key) => this.saveProviderKey(profile, envVar, key),
      // Mirrors `Dashboard::get_limited`: refused once the answer passes the limit.
      getLimited: async (pathAndQuery, maxBytes) => {
        const url = new URL(pathAndQuery, "http://dashboard/");
        const req: RestRequest = { method: "GET", path: url.pathname, query: url.searchParams };
        this.restRequests.push(req);
        const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(req.path);
        const handler = this.rest[`GET ${req.path}`] ?? (messages ? () => this.storedMessages(decodeURIComponent(messages[1]), req.query) : undefined);
        if (!handler) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
        const body = JSON.stringify(await handler(req));
        if (body.length > maxBytes) throw new Error(`it's ${(body.length / MiB).toFixed(1)} MB now, over the ${Math.floor(maxBytes / MiB)} MB limit`);
        return body;
      },
      close: async () => {
        this.closed = true;
      },
    };
  };

  /** A profile's enabled toolsets, its defaults when it has saved none: every listed one but `discord` and `image_gen`. */
  enabledToolsets(profile: string): Set<string> {
    return (this.toolsetsOn[profile] ??= new Set(this.toolsetCatalog.filter((t) => !["discord", "image_gen", "computer_use"].includes(t.name)).map((t) => t.name)));
  }

  /** `hermes_cli/web_routers/tools.py` at the deployed `bf0203a`: the list, one toolset's config, and the toggle. */
  private async toolsetRoute(req: RestRequest, rawName: string | undefined, config: boolean): Promise<unknown> {
    const notFound = () => new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
    if (this.toolsetRoutes === "none") throw notFound();
    const profile = req.query.get("profile") ?? "default";
    if (profile !== "default" && !(profile in this.otherProfiles))
      throw new Error(`The dashboard answered 404: {"detail":"Profile '${profile}' does not exist"}`);
    const name = rawName === undefined ? undefined : decodeURIComponent(rawName);
    const on = this.enabledToolsets(profile);
    const known = (n: string) => this.toolsetCatalog.find((t) => t.name === n);
    if (req.method === "GET" && name === undefined && this.toolsetListGateOnce) {
      const gate = this.toolsetListGateOnce;
      this.toolsetListGateOnce = undefined;
      await gate;
    }
    if (req.method === "GET" && name === undefined && this.toolsetReadsFailing)
      throw new Error(`The dashboard answered 500: {"detail":"Internal Server Error"}`);
    if (req.method === "GET" && name === undefined)
      return this.toolsetCatalog.map(({ installs: _i, ...t }) => {
        const enabled = on.has(t.name) && !this.toolsetSuppressed.has(t.name) && !this.toolsetDisabledEverywhere[profile]?.includes(t.name);
        return { ...t, enabled, available: enabled };
      });
    if (req.method === "GET" && name !== undefined && config) {
      const t = known(name);
      if (!t) throw new Error(`The dashboard answered 400: {"detail":"Unknown toolset: ${name}"}`);
      if (this.toolsetConfigFailure) throw new Error(this.toolsetConfigFailure);
      const gate = this.toolsetConfigGate[name];
      const providersNow = (this.toolsetProviders[name] ?? []).map((p) => ({ ...p }));
      if (gate) {
        delete this.toolsetConfigGate[name];
        await gate;
        const providers = providersNow.map((p) => ({ env_vars: [], post_setup: null, ...p }));
        return { name, has_category: providers.length > 0, providers, active_provider: providers.find((p) => p.is_active)?.name ?? null };
      }
      const providers = (this.toolsetProviders[name] ?? []).map((p) => ({ env_vars: [], post_setup: null, ...p }));
      const active = providers.find((p) => p.is_active)?.name ?? null;
      return { name, has_category: providers.length > 0, providers, active_provider: active };
    }
    if (req.method === "PUT" && name !== undefined && !config) {
      if (this.toolsetRoutes === "read-only") throw notFound();
      // `ToolsetToggle`: FastAPI checks the body before the route runs.
      if (typeof req.body?.enabled !== "boolean")
        throw new Error(`The dashboard answered 422: {"detail":[{"type":"bool_parsing","loc":["body","enabled"],"msg":"Input should be a valid boolean"}]}`);
      if (!known(name)) throw new Error(`The dashboard answered 400: {"detail":"Unknown toolset: ${name}"}`);
      if (this.toolsetRefusal) throw new Error(`The dashboard answered ${this.toolsetRefusal.status}: ${JSON.stringify({ detail: this.toolsetRefusal.detail })}`);
      await this.toolsetGateBeforeWrite;
      const drop = this.dropOnToolsetWrite;
      this.dropOnToolsetWrite = undefined;
      if (drop === "lost") throw new Error("Can't reach the Hermes dashboard: connection reset");
      const enabled = req.body.enabled;
      this.toolsetWrites.push({ profile, name, enabled });
      if (enabled) on.add(name);
      else on.delete(name);
      // `_save_platform_tools` drops the `no_mcp` sentinel from the platform's list; `stt` writes its own section.
      if (name !== "stt") this.toolsetNoMcp[profile]?.delete(known(name)!.platform);
      // And clears a toolset just turned on from `agent.disabled_toolsets`, on every platform (#49995).
      const everywhere = this.toolsetDisabledEverywhere[profile];
      if (enabled && name !== "stt" && everywhere) this.toolsetDisabledEverywhere[profile] = everywhere.filter((n) => n !== name);
      if (drop === "stored") throw new Error("Can't reach the Hermes dashboard: connection reset");
      if (this.toolsetReadsFailAfterWrite) this.toolsetReadsFailing = true;
      const late = this.failAfterToolsetWrite;
      this.failAfterToolsetWrite = undefined;
      if (late) throw new Error(`The dashboard answered ${late.status}: ${JSON.stringify({ detail: late.detail })}`);
      await this.toolsetGate;
      const installs = enabled && this.toolsetProviders[name]?.some((p) => p.post_setup === known(name)?.installs && p.status === "needs_setup") ? known(name)?.installs : undefined;
      return { ok: true, name, platform: known(name)!.platform, enabled, post_setup_started: installs ?? null };
    }
    throw notFound();
  }

  private saveProviderKey(profile: string, envVar: string, key: string): SavedKey {
    const row = this.env?.[envVar];
    if (!row || !row.provider || row.is_password !== true || row.channel_managed === true)
      throw new Error(`Hermes Chat doesn't relay ${envVar}: Hermes doesn't list it as a model provider's key.`);
    const value = key.trim();
    if (!value || /[\u0000-\u001f]/.test(value)) throw new Error("Paste the key on one line, without spaces around it.");
    const checked = this.checkKey(value);
    // As Rust does, the provider's own message isn't passed on: it can quote part of the key.
    if (!checked.ok && checked.reachable) throw new Error("The provider turned the key down. Check that you copied all of it, and that it's for this provider.");
    this.savedKeys.push({ profile, envVar, key: value });
    this.env![envVar] = { ...row, is_set: true, redacted_value: `${value.slice(0, 3)}…${value.slice(-2)}` };
    return { verified: checked.ok && checked.reachable };
  }

  /**
   * One `learning.*` request: "method not found" on a server without them, 4000 for a param the contract doesn't
   * have (pydantic `extra="forbid"`), else `answer`'s result.
   */
  private learning(r: Request, allowed: string[], answer: () => unknown) {
    if (!this.learningMethods) return this.fail(r.id, -32601, `unknown method: ${r.method}`);
    const extra = Object.keys(r.params ?? {}).find((k) => !allowed.includes(k));
    if (extra) return this.fail(r.id, 4000, `invalid params for ${r.method}: ${extra}: Extra inputs are not permitted`);
    this.beforeLearning?.(r.method, r.params);
    const result = answer();
    if (result !== undefined) this.respond(r.id, result);
  }

  /** The served profile's memory cards, MEMORY.md's first (`agent/learning_graph._memory_cards`). */
  private memoryCards(): { source: "memory" | "profile"; text: string; id: string }[] {
    const m = this.memory[this.servedProfile] ?? { memory: [], profile: [] };
    const cards = [...m.memory.map((text) => ({ source: "memory" as const, text })), ...m.profile.map((text) => ({ source: "profile" as const, text }))];
    return cards.map((c, i) => ({ ...c, id: `memory:${c.source}:${i}:${fingerprint(c.text)}` }));
  }

  /** `learning.frames`, trimmed to the parts that carry nodes: every card in one day's bucket. */
  private memoryFrames() {
    const cards = this.memoryCards();
    const nodes = cards.map((c) => ({ id: c.id, glyph: "◆", label: c.text.slice(0, 40), fullLabel: c.text.split("\n")[0], meta: "memory", body: c.text.slice(0, 1200), style: "memory" }));
    return {
      frames: [],
      legend: [],
      categories: [],
      buckets: cards.length ? [{ index: 0, label: "2 Nov", date: "2 Nov 2026", skills: 0, memories: cards.length, total: cards.length, nodes }] : [],
      summary: [],
      axis: { start: "", end: "" },
      count: cards.length,
      cols: 20,
      rows: 10,
    };
  }

  /** The entry a memory node id names, found by its fingerprint as `_locate_memory` does, or why it can't be. */
  private memoryEntry(id: string): { source: "memory" | "profile"; text: string } | string {
    const parts = id.split(":");
    if (parts.length !== 4 || parts[0] !== "memory" || (parts[1] !== "memory" && parts[1] !== "profile")) return `bad memory node id: '${id}'`;
    const found = this.memoryCards().find((c) => c.source === parts[1] && fingerprint(c.text) === parts[3]);
    return found ?? "memory node id is stale — refresh the graph";
  }

  /** `learning.edit` (`content`) or `learning.delete` (null), under the same refusals as `_mutate_memory`. */
  private memoryWrite(r: Request, content: string | null): unknown {
    if (this.learningError) {
      const { code, message } = this.learningError;
      this.learningError = undefined;
      return this.fail(r.id, code, message);
    }
    const found = this.memoryEntry(String(r.params.id ?? ""));
    const body = content?.trim();
    if (content !== null && !body) return { ok: false, message: "empty memory — use delete to remove it" };
    if (typeof found === "string") return { ok: false, message: found };
    const m = (this.memory[this.servedProfile] ??= { memory: [], profile: [] });
    const entries = m[found.source];
    const next = entries.flatMap((e) => (e === found.text ? (body === undefined ? [] : [body]) : [e]));
    const total = [...next.join("\n§\n")].length;
    const limit = this.memoryLimit[found.source];
    if (body !== undefined && total > limit)
      return { ok: false, message: `Replacement would put memory at ${total.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars. Shorten the new content.` };
    const drop = this.dropOnLearning;
    this.dropOnLearning = undefined;
    if (drop !== "lost") m[found.source] = [...new Set(next)];
    if (drop) {
      this.drop();
      return undefined;
    }
    const name = found.source === "memory" ? "MEMORY.md" : "USER.md";
    return { ok: true, message: body === undefined ? `deleted memory from ${name}` : `updated memory in ${name}` };
  }

  /**
   * `GET`/`PUT /api/profiles/{name}/soul` at `bf0203a`: `_resolve_profile_dir` (400 bad name, 404 no profile), then a
   * read with `encoding="utf-8-sig"` and universal newlines, or an unconditional whole-file write that creates it.
   */
  private soul(method: string, name: string, body?: Record<string, unknown>): unknown {
    if (name !== "default" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`The dashboard answered 400: {"detail":"Invalid profile name '${name}'"}`);
    if (name !== "default" && !(name in this.otherProfiles)) throw new Error(`The dashboard answered 404: {"detail":"Profile '${name}' does not exist."}`);
    if (method === "GET") {
      if (this.soulReadError) throw new Error(this.soulReadError);
      const file = this.souls[name];
      return file === undefined ? { content: "", exists: false } : { content: file.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), exists: true };
    }
    if (typeof body?.content !== "string")
      throw new Error(`The dashboard answered 422: {"detail":[{"type":"missing","loc":["body","content"],"msg":"Field required"}]}`);
    this.beforeSoulWrite?.();
    if (this.soulWriteError) throw new Error(this.soulWriteError);
    this.souls[name] = body.content;
    this.afterSoulWrite?.();
    if (this.soulWriteLost) throw new Error(this.soulWriteLost);
    return { ok: true };
  }

  /** A Server file for `/api/fs/*`, failing the way `_fs_regular_file` and `_is_sensitive_path` do at `bf0203a`. */
  private serverFile(query: URLSearchParams): { path: string; data: string } {
    const profile = query.get("profile");
    if (profile && profile !== "default" && !(profile in this.otherProfiles))
      throw new Error(`The dashboard answered 404: {"detail":"Profile '${profile}' does not exist."}`);
    const path = query.get("path") ?? "";
    const name = path.split("/").pop() ?? "";
    if (/^\.env(\..*)?$|^auth\.json$|^config\.yaml$/i.test(name))
      throw new Error(`The dashboard answered 403: {"detail":"Access to sensitive files is not allowed"}`);
    const f = this.serverFiles[path];
    if (f === undefined) throw new Error(`The dashboard answered 404: {"detail":"File not found"}`);
    if (typeof f !== "string") throw new Error(`The dashboard answered 400: {"detail":"Path points to a directory"}`);
    return { path, data: f };
  }

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

  /** Runs a projects method on the profile's projects; `fn` throws `[code, message]` to fail it. */
  private projectsOp(r: Request, fn: (list: FakeProject[]) => unknown) {
    const profile = (r.params.profile as string | undefined) || "default";
    if (!this.store(profile)) return this.fail(r.id, 4064, `Profile '${profile}' does not exist.`);
    try {
      this.respond(r.id, structuredClone(fn((this.projects[profile] ??= []))));
    } catch (e) {
      if (!Array.isArray(e)) throw e;
      this.fail(r.id, e[0], e[1]);
    }
  }

  /** A projects method on the one project `params.id` names, answering with it refreshed. */
  private projectOp(r: Request, fn: (p: FakeProject) => void) {
    this.projectsOp(r, (list) => {
      const p = list.find((q) => q.id === r.params.id || q.slug === r.params.id);
      if (!p) throw [5062, "no such project"];
      fn(p);
      return { project: p };
    });
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
      .map((m) => ({
        id: m.row_id!,
        session_id: id,
        role: m.role,
        content: m.role === "tool" ? (m.result ?? m.content ?? null) : (m.text ?? m.content ?? null),
        tool_name: m.role === "tool" ? (m.name ?? null) : null,
        tool_call_id: m.tool_call_id ?? null,
        tool_calls: m.tool_calls === undefined ? null : JSON.stringify(m.tool_calls),
        timestamp: m.timestamp ?? null,
      }));
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
    if (!s || !EDITABLE_SOURCES.has(s.source)) throw new Error(`The dashboard answered 404: {"detail":"not_found"}`);
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

  /**
   * `POST /api/model/set` (`set_model_assignment`, `_apply_model_assignment_sync` at the deployed `bf0203a`). A main
   * model Hermes prices above its safety threshold isn't written: it answers `confirm_required` until the request
   * carries `confirm_expensive_model`.
   */
  private setModel(body: Record<string, unknown>) {
    const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const [scope, provider, model, task] = [text("scope").toLowerCase(), text("provider"), text("model"), text("task")];
    if (scope !== "main" && scope !== "auxiliary") throw new Error(`The dashboard answered 400: {"detail":"scope must be 'main' or 'auxiliary'"}`);
    const priced = this.modelConfig.expensive[`${provider}/${model}`];
    if (model && priced && body.confirm_expensive_model !== true)
      return {
        ok: false,
        scope,
        provider,
        model,
        confirm_required: true,
        confirm_message: [`${model} has known pricing above Hermes' safety threshold.`, `Input tokens: $${priced[0].toFixed(2)}/M`, `Output tokens: $${priced[1].toFixed(2)}/M`, "Pricing source: models.dev."].join("\n"),
      };
    if (scope === "main") {
      if (!provider || !model) throw new Error(`The dashboard answered 400: {"detail":"provider and model required for main"}`);
      this.modelConfig.model = { provider, default: model };
      return { ok: true, scope, provider, model, base_url: "", gateway_tools: [], stale_aux: [] };
    }
    if (!provider) throw new Error(`The dashboard answered 400: {"detail":"provider required for auxiliary"}`);
    const slot = this.modelConfig.auxiliary[task];
    if (!slot) throw new Error(`The dashboard answered 400: {"detail":"unknown auxiliary task: ${task}"}`);
    const effort = body.reasoning_effort;
    if (typeof effort === "string" && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
      throw new Error(`The dashboard answered 400: {"detail":"reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max, ultra"}`);
    if (provider.toLowerCase() !== slot.provider.toLowerCase()) delete slot.base_url;
    slot.provider = provider;
    slot.model = model;
    if (effort === null) delete slot.reasoning_effort;
    else if (typeof effort === "string") slot.reasoning_effort = effort;
    return { ok: true, scope, tasks: [task], provider, model, ...("reasoning_effort" in body ? { reasoning_effort: effort } : {}) };
  }

  private frame(f: unknown) {
    this.onEvent?.({ kind: "frame", text: JSON.stringify(f) });
  }
}

/** A model catalog row (`model.options` → `providers[]`), trimmed to what Settings → Model reads. */
export type FakeProvider = { slug: string; name: string; models: string[]; capabilities: Record<string, { fast: boolean; reasoning: boolean }>; api_url?: string };
export type FakeAuxSlot = { provider: string; model: string; base_url?: string; reasoning_effort?: string };
export type FakeModelConfig = {
  model: { provider: string; default: string };
  agent: { reasoning_effort: string; service_tier: string };
  /** `delegation` as `GET /api/config` returns it, defaults filled in. */
  delegation: Record<string, unknown>;
  auxiliary: Record<string, FakeAuxSlot>;
  catalog: FakeProvider[];
  /** "provider/model" -> [input, output] $ per million tokens, for models priced above Hermes's threshold. */
  expensive: Record<string, [number, number]>;
  /** `delegation.backends.model_map.options`. */
  modelMap: Record<string, unknown>[];
};

const caps = (models: string[], fast: string[] = []) => Object.fromEntries(models.map((m) => [m, { fast: fast.includes(m), reasoning: true }]));

/** A profile set up like the owner's: OpenRouter for the main model, helper tasks pinned to cheap OpenRouter models. */
export function fakeModelConfig(): FakeModelConfig {
  const openrouter = ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "google/gemini-3.7-flash", "anthropic/claude-fable-5.1"];
  const nous = ["hermes-5-405b", "hermes-5-70b", "anthropic/claude-fable-5.1"];
  const codex = ["gpt-6.1-sol", "gpt-6.1-mini"];
  return {
    model: { provider: "openrouter", default: "z-ai/glm-5.3-flash" },
    agent: { reasoning_effort: "high", service_tier: "normal" },
    delegation: { provider: "", model: "", base_url: "", max_iterations: 50, max_concurrent_children: 3, child_timeout_seconds: 0, reasoning_effort: "" },
    auxiliary: {
      title_generation: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      compression: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      vision: { provider: "openrouter", model: "google/gemini-3.7-flash" },
      approval: { provider: "auto", model: "", reasoning_effort: "none" },
      review: { provider: "auto", model: "" },
    },
    catalog: [
      { slug: "openrouter", name: "OpenRouter", models: openrouter, capabilities: caps(openrouter) },
      { slug: "nous", name: "Nous Portal", models: nous, capabilities: caps(nous) },
      { slug: "openai-codex", name: "ChatGPT or Codex Subscription", models: codex, capabilities: caps(codex, ["gpt-6.1-sol"]) },
    ],
    expensive: { "openrouter/anthropic/claude-fable-5.1": [30, 150], "nous/anthropic/claude-fable-5.1": [30, 150] },
    modelMap: [],
  };
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

/**
 * A configurable toolset as `GET /api/tools/toolsets` lists it at the deployed `bf0203a` (`CONFIGURABLE_TOOLSETS`,
 * labels through `gui_toolset_label`). `installs`: a provider `post_setup` the toolset still needs, which turning it on
 * starts in the background (`toggle_toolset`'s install-on-enable).
 */
export type FakeToolset = {
  name: string;
  label: string;
  description: string;
  platform: string;
  platform_label: string;
  configured: boolean;
  tools: string[];
  installs?: string;
};

export function fakeToolsets(): FakeToolset[] {
  const cli = { platform: "cli", platform_label: "CLI", configured: true };
  return [
    { name: "web", label: "Web Search & Scraping", description: "web_search, web_extract", ...cli, tools: ["web_extract", "web_search"] },
    { name: "terminal", label: "Terminal & Processes", description: "terminal, process", ...cli, tools: ["process", "terminal"] },
    { name: "file", label: "File Operations", description: "read, write, patch, search", ...cli, tools: ["patch", "read_file", "search_files", "write_file"] },
    { name: "image_gen", label: "Image Generation", description: "image_generate", ...cli, configured: false, tools: ["image_generate"] },
    { name: "stt", label: "Speech-to-Text", description: "voice transcription (gateway voice messages + voice mode)", ...cli, tools: [] },
    { name: "discord", label: "Discord (read/participate)", description: "fetch messages, search members, create thread", platform: "discord", platform_label: "Discord", configured: true, tools: ["discord_fetch"] },
    { name: "computer_use", label: "Computer Use (macOS/Windows/Linux)", description: "background desktop control via cua-driver", ...cli, tools: ["computer_use"], installs: "cua_driver" },
  ];
}

/** A job row in a fake `jobs.json`, in the shape the dashboard sends. */
export type CronRow = Record<string, unknown> & { id: string; enabled: boolean; state: string };

/**
 * The fake's scheduled jobs. Like Hermes, a per-job route given a profile that doesn't hold the job acts on the
 * profile that does (`_job_owner_profile`), a paused job keeps its stale `next_run_at`, and running a paused job
 * resumes it. `failNext` makes the next matching write fail the way a lost answer does: before Hermes saw it, or after
 * it saved.
 */
export class FakeCron {
  jobs: Record<string, CronRow[]> = { default: [] };
  timezone = "America/Chicago";
  targets = [
    { id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
    { id: "telegram", name: "Telegram", home_target_set: true, home_env_var: "TELEGRAM_HOME_CHANNEL" },
    { id: "discord", name: "Discord", home_target_set: false, home_env_var: "DISCORD_HOME_CHANNEL" },
  ];
  runs: Record<string, Record<string, unknown>[]> = {};
  /** No session store yet: the runs route answers 503, as on a profile whose gateway never started. */
  runsUnavailable = false;
  heartbeat: number | null = 14;
  /** `last_status` a manual run ends with. */
  runStatus = "ok";
  /** No `/api/cron/*` routes at all, as on an old server. */
  missing = false;
  now = () => Date.now();
  /** The next write whose "METHOD /path" matches fails: `before` it reaches Hermes, or `after` Hermes saved it. */
  failNext?: { match: RegExp; when: "before" | "after"; message?: string };
  /** Reads of the job list that fail from now on, as a dropped connection does. */
  failLists = 0;
  /** Calls the next write waits for before it is handled. */
  gate?: Promise<void>;
  private seq = 0;

  constructor(private server: FakeHermes) {}

  /** A job in `profile`, made the way `create_job` does from these fields. */
  add(profile: string, fields: Record<string, unknown> & { schedule: string }): CronRow {
    const zone = this.zoneOf(profile);
    const now = this.now();
    const s = parseSchedule(fields.schedule, zone, now);
    const paused = fields.paused === true;
    const id = (fields.id as string) ?? `${(++this.seq).toString(16).padStart(4, "0")}feed0000`.slice(0, 12);
    const stamp = isoIn(zone, now);
    const row: CronRow = {
      id,
      name: (fields.name as string) || String(fields.prompt ?? "").slice(0, 50).trim(),
      prompt: fields.prompt ?? "",
      skills: [],
      skill: null,
      model: null,
      provider: null,
      script: fields.script ?? null,
      no_agent: fields.no_agent === true,
      schedule: s.kind === "cron" ? { kind: "cron", expr: s.expr, display: s.display } : s.kind === "interval" ? { kind: "interval", minutes: s.minutes, display: s.display } : { kind: "once", run_at: isoIn(zone, s.runAt), display: s.display },
      schedule_display: s.display,
      repeat: { times: typeof fields.repeat === "number" ? fields.repeat : s.kind === "once" ? 1 : null, completed: 0 },
      enabled: !paused,
      state: paused ? "paused" : "scheduled",
      paused_at: paused ? stamp : null,
      paused_reason: paused ? "Created paused; awaiting operator approval." : null,
      created_at: stamp,
      next_run_at: paused ? null : this.next(s, zone, now),
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_delivery_error: null,
      deliver: (fields.deliver as string) || "local",
      origin: null,
      enabled_toolsets: null,
      workdir: fields.workdir ?? null,
      ...Object.fromEntries(Object.entries(fields).filter(([k]) => ["model", "provider", "skills"].includes(k))),
    };
    (this.jobs[profile] ??= []).push(row);
    return row;
  }

  private zoneOf(_profile: string) {
    return this.timezone || "UTC";
  }

  private next(s: ReturnType<typeof parseSchedule>, zone: string, from: number): string | null {
    const at = upcomingRuns(s, zone, from, 1)?.[0];
    return at === undefined ? null : isoIn(zone, at);
  }

  private stamp(profile: string, row: CronRow) {
    return { ...structuredClone(row), profile, profile_name: profile, hermes_home: `/home/liam/.hermes${profile === "default" ? "" : `/profiles/${profile}`}`, is_default_profile: profile === "default", scheduler_heartbeat_age_s: this.heartbeat, latest_execution: null };
  }

  private refuse(status: number, detail: unknown): never {
    throw new Error(`The dashboard answered ${status}: ${JSON.stringify({ detail })}`);
  }

  private profile(query: URLSearchParams): string {
    const p = query.get("profile") ?? "default";
    if (!(p in this.jobs) && p !== "default" && !(p in this.server.otherProfiles)) this.refuse(404, `Profile '${p}' does not exist.`);
    return p;
  }

  /** `_job_owner_profile`: the named profile if it holds the job, else whichever profile does. */
  private owner(id: string, hint: string): [string, CronRow] {
    for (const p of [hint, ...Object.keys(this.jobs)]) {
      const row = this.jobs[p]?.find((j) => j.id === id);
      if (row) return [p, row];
    }
    this.refuse(404, "Job not found");
  }

  /** A cron route's handler for `req`, or undefined if it isn't one. */
  route(req: RestRequest): (() => unknown) | undefined {
    const m = /^\/api\/cron\/(jobs|delivery-targets)(?:\/([^/]+))?(?:\/(runs|pause|resume|trigger))?$/.exec(req.path);
    if (!m) return undefined;
    if (this.missing) return () => this.refuse(404, "Not Found");
    const [, what, rawId, action] = m;
    const id = rawId && decodeURIComponent(rawId);
    const key = `${req.method} ${what}${id ? "/:id" : ""}${action ? `/${action}` : ""}`;
    const write = req.method !== "GET";
    return async () => {
      if (write) await this.gate;
      const fail = write && this.failNext?.match.test(`${req.method} ${req.path}`) ? this.failNext : undefined;
      if (fail) this.failNext = undefined;
      if (fail?.when === "before") throw new Error(fail.message ?? "Can't reach the Hermes dashboard: error sending request");
      if (!write && what === "jobs" && !id && this.failLists > 0) {
        this.failLists--;
        throw new Error("Can't reach the Hermes dashboard: connection reset");
      }
      const answer = this.handle(key, req, id);
      if (fail) throw new Error(fail.message ?? "Can't reach the Hermes dashboard: connection closed before message completed");
      return answer;
    };
  }

  private handle(key: string, req: RestRequest, id?: string): unknown {
    const profile = this.profile(req.query);
    const zone = this.zoneOf(profile);
    const now = this.now();
    switch (key) {
      case "GET jobs":
        return (this.jobs[profile] ?? []).map((j) => this.stamp(profile, j));
      case "GET delivery-targets":
        return { targets: this.targets };
      case "POST jobs": {
        const body = req.body ?? {};
        if (typeof body.schedule !== "string") this.refuse(422, [{ msg: "Field required" }]);
        if (!String(body.prompt ?? "").trim() && !body.script) this.refuse(400, "A cron job needs a prompt, a script or a skill.");
        try {
          return this.stamp(profile, this.add(profile, body as { schedule: string }));
        } catch (e) {
          if (e instanceof ScheduleError) this.refuse(400, e.message);
          throw e;
        }
      }
    }
    const [owner, row] = this.owner(id!, profile);
    switch (key) {
      case "GET jobs/:id":
        return this.stamp(owner, row);
      case "GET jobs/:id/runs":
        if (this.runsUnavailable) this.refuse(503, "Session store is not initialized. Start this profile's gateway to initialize it.");
        return { runs: this.runs[row.id] ?? [], limit: Number(req.query.get("limit") ?? 20) };
      case "PUT jobs/:id": {
        const updates = (req.body?.updates ?? {}) as Record<string, unknown>;
        if ("schedule" in updates) {
          let s;
          try {
            s = parseSchedule(String(updates.schedule), zone, now);
          } catch (e) {
            this.refuse(400, (e as Error).message);
          }
          row.schedule = s.kind === "cron" ? { kind: "cron", expr: s.expr, display: s.display } : s.kind === "interval" ? { kind: "interval", minutes: s.minutes, display: s.display } : { kind: "once", run_at: isoIn(zone, s.runAt), display: s.display };
          row.schedule_display = s.display;
          if (row.state !== "paused") row.next_run_at = this.next(s, zone, now);
        }
        for (const k of ["name", "prompt", "deliver"]) if (k in updates) row[k] = updates[k];
        if ("repeat" in updates) row.repeat = { times: updates.repeat === "forever" ? null : Number(updates.repeat), completed: (row.repeat as { completed: number }).completed };
        return this.stamp(owner, row);
      }
      case "POST jobs/:id/pause":
        Object.assign(row, { enabled: false, state: "paused", paused_at: isoIn(zone, now) });
        return this.stamp(owner, row);
      case "POST jobs/:id/resume": {
        const s = parseSchedule(String(row.schedule_display), zone, now);
        Object.assign(row, { enabled: true, state: "scheduled", paused_at: null, paused_reason: null, next_run_at: this.next(s, zone, now) });
        return this.stamp(owner, row);
      }
      case "POST jobs/:id/trigger": {
        const stamp = isoIn(zone, now);
        Object.assign(row, { enabled: true, state: "scheduled", paused_at: null, last_run_at: stamp, last_status: this.runStatus, last_error: this.runStatus === "error" ? "The fixture failed." : null });
        return this.stamp(owner, row);
      }
      case "DELETE jobs/:id":
        this.jobs[owner] = this.jobs[owner].filter((j) => j !== row);
        return { ok: true };
    }
    this.refuse(405, "Method Not Allowed");
  }
}

