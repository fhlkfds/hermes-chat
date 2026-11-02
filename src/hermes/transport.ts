// Frontend Hermes transport: speaks the legacy JSON-RPC generation of `/api/ws` over a Pipe and folds
// the server's frames into Chats. Wire shapes: docs/research/hermes-gateway-api.md §3d, §4, §5 and
// "SSH tunnel, Host header and protocol generation". Only the legacy verbs are used (ADR 0003).
// The chat list comes from dashboard REST, because the legacy `session.list` has no last-activity field.
// Attachments: research doc §7. A dropped connection is reconnected on its own; keepalive: research doc §1.
// One profile's chats show at a time; switching opens the connection again for the new profile.
// Search runs on dashboard REST: research doc "Searching chats".
// Approvals come as legacy server→client requests, answered with a response frame: research doc §6 and
// "Approvals on the legacy generation".
// The list holds the past month's chats until the owner pulls older history for the profile; from then on it holds
// them all.
// Pinned and Snoozed chats are kept on this computer, since Hermes's `pinned` flag already stores Active (ADR 0005).
// Renaming and marking unread go to Hermes; a regenerated title comes from legacy `llm.oneshot`.
import { isWaiting, type ApprovalChoice, type ApprovalItem, type AttachCheck, type Attachment, type Chat, type ConnectionStatus, type Found, type Item, type Source } from "./model";
import type { OpenPipe, Pipe, PipeEvent, Route } from "./pipe";
import { isUnsecure } from "./unsecure";

/** The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is. */
export const APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;
/** Waits before each try to reconnect a dropped connection. When the last try fails the app is Offline until the
 * owner asks to reconnect, so a wrong password isn't retried for ever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** A `gateway.ping` goes out this often. A connection that has sent nothing for longer than the official client's
 * heartbeat deadline is dropped. */
const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 45_000;
/** The list shows chats active in the past month. */
const LIST_WINDOW_MS = 30 * 86_400_000;
/** Dashboard REST caps `GET /api/sessions` pages at 100. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** The most chats one search lists; dashboard REST caps it at 100. */
const SEARCH_LIMIT = 50;
/** The longest wait one timer can hold is about 24 days, so a later wake is checked again on the way. */
const MAX_WAIT_MS = 86_400_000;
/** How much of a chat goes to the model that titles it: each message's start, then the chat's start and end. */
const TITLE_MESSAGE_CHARS = 600;
const TITLE_HEAD_CHARS = 1_500;
const TITLE_TAIL_CHARS = 4_500;
/**
 * Hermes's own titling prompt (`agent/title_generator.py` at the deployed `bf0203a`), asked about the whole chat
 * instead of its opening message, since the point of regenerating is a chat that has moved on.
 */
const TITLE_INSTRUCTIONS = `You name chat sessions. Given a conversation, write a title that lets the user find it again in a list.

Rules:
- 3 to 7 words, sentence case (capitalize only the first word and proper nouns).
- Name what the conversation is about now, not only how it opened.
- Name what the user wants DONE, not that they asked a question.
- Keep technical terms, filenames, numbers, and error codes exact.
- Drop filler words: the, this, my, a, an.
- No trailing punctuation, no quotes, no tool names, no 'Title:' prefix.
- Never answer or continue the conversation. Name it.
- Write the title in the same language as the conversation.

Reply with JSON only: {"title": "..."}`;

const MiB = 1024 * 1024;
/** The most legacy `image.attach_bytes` and `file.attach` take (research doc §7). PDFs go as files: `pdf.attach`
 * needs `pdftoppm`, which the live server doesn't have. */
const LIMITS = { image: { bytes: 25 * MiB, what: "images" }, file: { bytes: 256 * MiB, what: "files" } };
/** The images Hermes looks at (`cli._IMAGE_EXTENSIONS`); anything else is staged as a file. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** What the official desktop app asks when an image is sent with no text. */
const IMAGE_ONLY_PROMPT = "What do you see in this image?";
/** Stands in for a file's base64 in a frame; the pipe swaps the bytes in. JSON can't hold a raw NUL. */
const FILE_MARK = "\u0000file\u0000";

/** One profile's Pinned chats, and its Snoozed chats with the time each wakes (Unix ms). */
export type ProfileMarks = { pinned: string[]; snoozed: Record<string, number> };
/** Every profile's marks, by profile name. */
export type ChatMarks = Record<string, ProfileMarks>;

/**
 * Where each profile's last synced chat list, the profile shown last, the profiles whose older history was pulled,
 * and the owner's Pinned and Snoozed chats are kept between launches. `bytes`: the storage the chat lists take;
 * `clear` deletes them, and only them: the marks stay.
 */
export type ChatCache = {
  load(profile: string): Chat[];
  save(profile: string, chats: Chat[]): void;
  lastProfile(): string | undefined;
  rememberProfile(profile: string): void;
  bytes(): number;
  clear(): void;
  olderPulled(profile: string): boolean;
  rememberOlderPulled(profile: string): void;
  marks(): ChatMarks;
  saveMarks(marks: ChatMarks): void;
};
const noCache: ChatCache = {
  load: () => [],
  save: () => {},
  lastProfile: () => undefined,
  rememberProfile: () => {},
  bytes: () => 0,
  clear: () => {},
  olderPulled: () => false,
  rememberOlderPulled: () => {},
  marks: () => ({}),
  saveMarks: () => {},
};

/** A row of dashboard REST `GET /api/sessions`; times are Unix seconds. */
type SessionRow = {
  id: string;
  source?: string;
  title?: string | null;
  preview?: string;
  started_at?: number;
  last_active?: number | null;
  pinned?: boolean;
  archived?: boolean;
  /** Activity postdates the session's shared read watermark (`SessionDB.session_unread`). */
  unread?: boolean;
};
type SessionPage = { sessions: SessionRow[]; total: number };
/** Dashboard REST `GET /api/sessions/{id}`: the whole stored row, as far as this app reads it. */
type SessionDetail = { cwd?: string | null; git_repo_root?: string | null };
/**
 * A row of dashboard REST `GET /api/sessions/search` (research doc "Searching chats"): one per chat, archived ones
 * too. `snippet` is FTS5's, with each matched word `>>>marked<<<`; `role` is the matched message's, and null when the
 * chat's id or title matched instead.
 */
type SearchRow = Pick<SessionRow, "id" | "source" | "title" | "preview" | "started_at" | "last_active" | "archived"> & {
  snippet?: string;
  role?: string | null;
};
/** Dashboard REST `GET /api/profiles` (`web_routers/profiles.py`), as far as this app reads it. */
type ProfileList = { profiles: { name: string }[] };

/** A history row from legacy `session.resume` (research doc §5, `TranscriptMessage`). Tool rows carry the call's
 * name, args and an 80-char `context`; Hermes keeps the result (`content`) only for edit tools. */
type TranscriptMessage = {
  role: string;
  text?: string | null;
  reasoning?: string | null;
  content?: unknown;
  name?: string | null;
  context?: string | null;
  args?: Record<string, unknown> | null;
};

/** Legacy `image.attach_bytes` and `file.attach` results (research doc §7), as far as this app reads them. */
type ImageAttached = { path: string };
type FileAttached = { ref_text: string };

/** Legacy `session.interrupt` result (research doc §8). `not_interrupted` needs `expected_hosted_task_id`. */
type InterruptResult = { status: "interrupted" | "not_interrupted" };

/**
 * A server→client request (`tui_gateway/server_requests.py`), as it arrives or as `session.resume` lists it in
 * `open_requests`. An `approval` one carries `{request_id, command, description, choices, ...}` (research doc §6).
 */
type ServerRequest = { id: string; method: string; params: Record<string, unknown> };

/** JSON-RPC "method not found": what Hermes expects from a client that can't handle a request. */
const NO_SUCH_METHOD = -32601;

type RpcFrame = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export class ProtocolMismatchError extends Error {
  constructor() {
    super("This Hermes server speaks the canonical session protocol, which Hermes Chat doesn't support yet.");
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `profile`: the profile whose chats are shown. `route`: how the latest connection reached the dashboard. `unsecure`:
 * its traffic isn't encrypted (unsecure.ts). `closedReason`: why the connection dropped, or why the last try to
 * reconnect failed. `olderPulled`: the list holds the profile's chats older than a month too (`pullOlderHistory`).
 */
export type Snapshot = {
  profile: string;
  chats: Chat[];
  olderPulled: boolean;
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  syncError?: string;
};

/**
 * Connects to Hermes for `profile`, by default the one shown last; rejects if the first connection fails. Later drops
 * are reconnected by the returned Hermes.
 */
export async function connect(openPipe: OpenPipe, profile?: string, cache: ChatCache = noCache): Promise<Hermes> {
  const hermes = new Hermes(openPipe, profile ?? cache.lastProfile() ?? "default", cache);
  await hermes.dial();
  return hermes;
}

export class Hermes {
  private pipe?: Pipe;
  /** The profile the pipe's `/api/ws` was opened for. */
  private pipeProfile?: string;
  /** Counts pipes opened; events from an older pipe than the current one are ignored. */
  private generation = 0;
  /** The pipe being opened is waiting for `gateway.ready`. */
  private onReady?: (payload: Record<string, unknown>) => void;
  /** Ends the dial under way with this error. */
  private abortDial?: (e: Error) => void;
  /** The dropped pipe, until the Rust side has closed it. Opening the next one waits, because Rust holds a single
   * connection and closing drops whichever it holds. */
  private droppedClosing?: Promise<void>;
  private redialing?: Promise<void>;
  private failedTries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private closing = false;
  /** Chats resumed on a connection that has since dropped: how many of their items the next resume replaces with the
   * stored history. */
  private staleItems = new Map<string, number>();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;
  /** Chats this app moved between Active and Settled that Hermes hasn't stored yet: the `pinned` flag each should
   * have (ADR 0002). While a chat is here, this flag beats the one the server lists. */
  private pinWanted = new Map<string, boolean>();
  /** The latest write of each chat's pinned flag, so a chat's writes go out one at a time, in order. */
  private pinWrites = new Map<string, Promise<void>>();
  /** Chats whose pinned flag was written since the list sync under way read the list, which may predate the write. */
  private pinnedSinceListRead = new Set<string>();
  /** The chat on screen. It is kept read: new activity in it doesn't show the dot. */
  private viewing?: string;
  /** The latest write marking each chat read or unread, while it is under way, and whether it marks it unread. */
  private readWrites = new Map<string, { unread: boolean; write: Promise<void> }>();
  /** Chats marked read (false) or unread (true) since the list sync under way read the list, which may predate the
   * write. */
  private readSinceListRead = new Map<string, boolean>();
  /** Titles the owner gave chats here that Hermes hasn't listed yet. While a chat is here, this title beats the
   * listed one. */
  private titleWanted = new Map<string, string>();
  /** The latest title write for each chat, while it is under way. */
  private titleWrites = new Map<string, Promise<unknown>>();
  /** Chats renamed since the list sync under way read the list, which may predate the write. */
  private retitledSinceListRead = new Set<string>();
  /** The owner's Pinned and Snoozed chats in every profile (ADR 0005). */
  private marks: ChatMarks;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  /** Resumes in flight, so opening a chat and replying in it share one. */
  private resuming = new Map<string, Promise<string>>();
  /** Chats the owner picked from a search though the list doesn't hold them; they stay in it until the profile changes. */
  private revealed = new Set<string>();
  /** Chats the owner deleted here, or is deleting. A list read before the delete can't bring one back. */
  private deleted = new Set<string>();
  /** Chats that had a turn running, or an Approval waiting, when the connection dropped. Reconnecting resumes them,
   * which brings back what Hermes is still waiting on. */
  private resumeOnReconnect = new Set<string>();
  /** Requests for a session no chat holds yet: the resume that reattaches it can answer after Hermes writes them. */
  private earlyRequests = new Map<string, ServerRequest[]>();
  /** Approvals Hermes has been told are on screen (`approval.received`), by request id. */
  private shownApprovals = new Set<string>();
  /** Hermes answered that it has no `approval.received`. */
  private noApprovalReceived = false;
  /** Messages Hermes hasn't accepted yet, so a Stop waits for the turn it stops. */
  private submitting = new Map<string, Promise<unknown>>();
  private syncing?: Promise<Error | undefined>;
  private syncAgain = false;
  private background = new Set<Promise<unknown>>();

  constructor(
    private openPipe: OpenPipe,
    profile: string,
    private cache: ChatCache = noCache,
  ) {
    this.marks = cache.marks();
    this.snapshot = { profile, chats: [], olderPulled: cache.olderPulled(profile), status: "offline", unsecure: false };
    this.update({ chats: cache.load(profile) });
    this.scheduleWake();
  }

  /** The profile whose chats are shown. */
  get profile(): string {
    return this.snapshot.profile;
  }

  /**
   * Opens a pipe and waits for `gateway.ready`. Used by `connect` and to reconnect; on failure the pipe is closed and
   * the error thrown.
   */
  async dial(): Promise<void> {
    await this.droppedClosing;
    const gen = ++this.generation;
    const ready = new Promise<Record<string, unknown>>((resolve) => (this.onReady = resolve));
    // Set as soon as the pipe closes or the app gives up, even after gateway.ready has arrived.
    let failure: Error | undefined;
    const failed = new Promise<never>((_, reject) => (this.abortDial = (e) => reject((failure ??= e))));
    failed.catch(() => {}); // Raced below, once the pipe is open.
    let up = false;
    let pipe: Pipe | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const profile = this.profile;
    try {
      pipe = await this.openPipe((e) => {
        if (gen !== this.generation) return;
        if (e.kind === "closed" && !up) this.abortDial?.(new Error(`The connection closed before Hermes was ready: ${e.reason}`));
        else this.handle(e);
      }, profile);
      const payload = await Promise.race([
        ready,
        failed,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Hermes didn't send gateway.ready in time.")), READY_TIMEOUT_MS);
        }),
      ]);
      if (failure) throw failure;
      if (payload.session_authority) throw new ProtocolMismatchError();
    } catch (e) {
      this.generation++;
      await pipe?.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
      this.onReady = this.abortDial = undefined;
    }
    up = true;
    this.pipe = pipe;
    this.pipeProfile = profile;
    this.lastHeard = Date.now();
    this.heartbeat = setInterval(() => this.beat(), PING_EVERY_MS);
    this.update({ status: "connected", closedReason: undefined, route: pipe.route, unsecure: isUnsecure(pipe.route) });
    // Without this, Hermes never sends this connection an Approval (research doc §6).
    this.track(this.request("client.capabilities", { server_requests: true }));
  }

  /** Tries to connect again now, after a drop or from Offline, and keeps retrying on its own if that fails. */
  reconnect(): Promise<void> {
    if (!this.redialing) this.failedTries = 0;
    return this.redial();
  }

  /** The server's profiles by name, as dashboard REST lists them. One sign-in covers them all (research doc). */
  async profiles(): Promise<string[]> {
    const res = (await this.rest("GET", "api/profiles")) as ProfileList;
    return res.profiles.map((p) => p.name);
  }

  /**
   * Shows another profile's chats: its last synced list at once, then a fresh one once the connection is open again
   * for that profile. The profile is remembered for the next sign-in. Settling or marking read that the owner did in
   * the old profile still goes to it.
   */
  async switchProfile(name: string): Promise<void> {
    if (name === this.profile) return;
    this.viewing = undefined;
    this.staleItems.clear();
    this.resumeOnReconnect.clear();
    this.revealed.clear();
    this.cache.rememberProfile(name);
    this.update({ profile: name, chats: this.cache.load(name), olderPulled: this.cache.olderPulled(name), syncError: undefined });
    // A reconnect under way may be opening the old profile's socket.
    await this.redialing;
    if (this.profile !== name || this.closing) return;
    if (this.pipe && this.pipeProfile === name) return void this.sync();
    if (this.pipe) this.detach(`Switching to the ${name} profile.`);
    await this.reconnect();
  }

  /**
   * Searches the words and titles of every chat in the profile, Active and Settled, however old.
   * Chats archived in another Hermes client are left out, as they are from the list.
   */
  async search(text: string): Promise<Found[]> {
    const q = text.trim();
    if (!q) return [];
    const query = new URLSearchParams({ q, profile: this.profile, limit: String(SEARCH_LIMIT), exclude_sources: "cron" });
    const res = (await this.rest("GET", `api/sessions/search?${query}`)) as { results: SearchRow[] };
    const listed = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    return res.results
      .filter((r) => !r.archived && !this.deleted.has(r.id))
      .map((r): Found => {
        const c = listed.get(r.id);
        const snippet = snippetParts(r.snippet ?? "");
        const role = r.role === "user" || r.role === "assistant" ? r.role : undefined;
        return {
          chatId: r.id,
          title: r.title || r.preview || c?.title || "Untitled chat",
          source: toSource(r.source),
          // Every pinned chat is listed, so one that isn't is Settled.
          settled: c?.settled ?? true,
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
          snippet,
          ...(role && { role, find: findTerm(q, snippet) }),
        };
      });
  }

  /** Puts a found chat in the list, if it isn't there yet, so it can be opened (`open`). */
  reveal(found: Found) {
    if (this.snapshot.chats.some((c) => c.id === found.chatId)) return;
    const { chatId: id, title, source, settled, updatedAt } = found;
    this.revealed.add(id);
    this.update({ chats: [...this.snapshot.chats, { id, title, source, settled, updatedAt, items: [] }] });
  }

  /**
   * The id of the message a search matched in a found chat, once its history has loaded. FTS5 cuts the snippet out of
   * the stored message and puts "..." where it cut, so the longest piece between cuts picks the message out; failing
   * that, the first message of its kind holding the `find` text.
   */
  locate(found: Found): string | undefined {
    const chat = this.snapshot.chats.find((c) => c.id === found.chatId);
    if (!chat || !found.role) return undefined;
    const flat = (t: string) => t.replace(/\s+/g, " ").toLowerCase();
    const pieces = flat(found.snippet.map((p) => p.text).join("")).split("...").map((t) => t.trim());
    const longest = pieces.reduce((a, b) => (b.length > a.length ? b : a), "");
    const messages = chat.items.flatMap((i) => (i.kind === found.role ? [{ id: i.id, text: flat(i.text) }] : []));
    const holding = (t: string) => t && messages.find((m) => m.text.includes(t));
    return (holding(longest) || holding(flat(found.find ?? "")) || undefined)?.id;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /** Starts a Chat in this app. It is Active from the start, and pinned once Hermes has stored it (ADR 0002). */
  async newChat(): Promise<string> {
    const res = (await this.request("session.create", { profile: this.profile, source: APP_SOURCE })) as {
      session_id: string;
      stored_session_id: string;
    };
    const chat: Chat = {
      id: res.stored_session_id,
      runtimeId: res.session_id,
      title: "New chat",
      source: "app",
      settled: false,
      updatedAt: Date.now(),
      items: [],
    };
    this.pinWanted.set(chat.id, true);
    this.update({ chats: [chat, ...this.snapshot.chats] });
    return chat.id;
  }

  /**
   * Opens a chat: one this connection hasn't resumed yet is resumed now and shows its stored history. If that
   * fails the chat shows why, and the next open tries again. The chat is on screen until `leave`: it is marked read
   * on the server, and stays read while the owner is in it. Hermes counts a chat no client has marked as read, and
   * only marking it lets later activity show the dot.
   */
  async open(chatId: string): Promise<void> {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return;
    this.viewing = chatId;
    this.markRead(chatId);
    try {
      await this.resume(chatId);
      if (this.viewing === chatId) this.tellShown(chatId);
    } catch (e) {
      // A reply sent meanwhile shares this resume and reports the failure itself.
      this.patchChat(chatId, (c) =>
        c.running ? c : { ...c, items: [...withoutLoadError(c.items), { kind: "error", id: LOAD_ERROR_ID, text: `Couldn't load this chat: ${(e as Error).message}` }] },
      );
    }
  }

  /** The owner has moved off the chat; new activity in it shows the dot again. */
  leave(chatId: string) {
    if (this.viewing === chatId) this.viewing = undefined;
  }

  /** Checks local files the owner wants to attach: images up to 25 MB, other files up to 256 MB. */
  async checkAttachments(paths: string[]): Promise<AttachCheck> {
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    const attachments: Attachment[] = [];
    const refused: string[] = [];
    for (const f of await this.pipe.statFiles(paths)) {
      if (f.size === undefined) {
        refused.push(`Couldn't attach ${f.name}: ${f.error}`);
        continue;
      }
      const kind = IMAGE_EXTENSIONS.test(f.name) ? "image" : "file";
      const limit = LIMITS[kind];
      if (f.size > limit.bytes)
        refused.push(`${f.name} is ${(f.size / MiB).toFixed(1)} MB. Hermes takes ${limit.what} up to ${limit.bytes / MiB} MB.`);
      else attachments.push({ path: f.path, name: f.name, size: f.size, kind });
    }
    return { attachments, refused };
  }

  /**
   * Sends a message and its attachments. A chat not yet open on this connection is resumed first; a Settled one
   * becomes Active.
   */
  async send(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const profile = this.profile;
    const activating = chat.settled;
    const wantedBefore = this.pinWanted.get(chatId);
    if (activating) {
      this.pinWanted.set(chatId, true);
      this.mark(chatId, { snoozedUntil: undefined });
    }
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      title: c.items.length === 0 && c.runtimeId ? (text || attachments[0]?.name || c.title).slice(0, 48) : c.title,
      items: [
        ...c.items,
        { kind: "user", id: `u-${c.items.length}`, text, ...(attachments.length && { attachments: attachments.map((a) => a.name) }) },
      ],
    }));
    try {
      const submitting = this.resume(chatId).then((runtimeId) => this.submit(runtimeId, text, attachments));
      this.submitting.set(chatId, submitting);
      try {
        await submitting;
      } finally {
        if (this.submitting.get(chatId) === submitting) this.submitting.delete(chatId);
      }
      // Pin now if Hermes has stored the session; a new chat may not have its row yet, so the end of the turn
      // tries again.
      if (this.pinWanted.get(chatId)) this.track(this.writePin(chatId, profile));
    } catch (e) {
      if (activating) {
        if (wantedBefore === undefined) this.pinWanted.delete(chatId);
        else this.pinWanted.set(chatId, wantedBefore);
      }
      this.patchChat(chatId, (c) => ({
        ...c,
        running: false,
        settled: activating || c.settled,
        items: [...c.items, errorItem(c, (e as Error).message)],
      }));
    }
  }

  /** Moves a chat to Settled here at once, and unpins it on the server (ADR 0002). A Pinned chat is unpinned too. `unsettle` undoes it. */
  settle(chatId: string): Promise<void> {
    this.mark(chatId, { pinned: false });
    return this.setSettled(chatId, true);
  }

  /** Moves a chat to Active here at once, and pins it on the server. A Snoozed chat stops snoozing. `settle` undoes it. */
  unsettle(chatId: string): Promise<void> {
    this.mark(chatId, { snoozedUntil: undefined });
    return this.setSettled(chatId, false);
  }

  /**
   * Pins a chat: it sits at the top of the list, above the other Active chats. A Settled or Snoozed chat moves to
   * Active. Pins are kept on this computer (ADR 0005). `unpin` undoes it.
   */
  pin(chatId: string): Promise<void> {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return Promise.resolve();
    this.mark(chatId, { pinned: true, snoozedUntil: undefined });
    return this.setSettled(chatId, false);
  }

  /** Unpins a chat; it stays Active, in its place by last activity. */
  unpin(chatId: string) {
    this.mark(chatId, { pinned: false });
  }

  /**
   * Snoozes a chat until `until` (Unix ms): it is Settled now, in every Hermes client, and moves back to Active,
   * unread, when the time comes. A Pinned chat is unpinned. The wake time is kept on this computer (ADR 0005), so the
   * chat wakes once this app is running and connected at or after that time.
   */
  snooze(chatId: string, until: number): Promise<void> {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return Promise.resolve();
    this.mark(chatId, { pinned: false, snoozedUntil: until });
    return this.setSettled(chatId, true);
  }

  /** Wakes a Snoozed chat now: it moves back to Active, without the unread dot. */
  unsnooze(chatId: string): Promise<void> {
    return this.unsettle(chatId);
  }

  /**
   * Renames a chat in every Hermes client (`PATCH {title}`). The new title shows here at once; if Hermes refuses,
   * for example because another chat has that title, the old one comes back and this rejects with why. An empty
   * title changes nothing.
   */
  async rename(chatId: string, title: string): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const wanted = title.trim();
    if (!chat || !wanted || wanted === chat.title) return;
    const profile = this.profile;
    this.titleWanted.set(chatId, wanted);
    this.patchChat(chatId, (c) => ({ ...c, title: wanted }));
    const write = this.rest("PATCH", `api/sessions/${encodeURIComponent(chatId)}`, { title: wanted, profile });
    this.titleWrites.set(chatId, write);
    try {
      await write;
      this.retitledSinceListRead.add(chatId);
    } catch (e) {
      if (this.titleWanted.get(chatId) === wanted) {
        this.titleWanted.delete(chatId);
        if (this.profile === profile) this.patchChat(chatId, (c) => (c.title === wanted ? { ...c, title: chat.title } : c));
      }
      throw e;
    } finally {
      if (this.titleWrites.get(chatId) === write) this.titleWrites.delete(chatId);
    }
  }

  /**
   * Asks Hermes's model for a new title from the whole chat, then renames the chat to it. The title comes from legacy
   * `llm.oneshot`, which runs outside the chat and adds nothing to it. A chat not yet open on this connection is
   * loaded first. Resolves to the new title.
   */
  async regenerateTitle(chatId: string): Promise<string> {
    const chat = await this.loaded(chatId);
    const input = titleInput(chat.items);
    if (!input) throw new Error("There's nothing in this chat to name yet.");
    const res = (await this.request("llm.oneshot", {
      instructions: TITLE_INSTRUCTIONS,
      input,
      task: "title_generation",
      max_tokens: 256,
      profile: this.profile,
      // Lends the chat's model, as Hermes's own titling does.
      session_id: chat.runtimeId,
    })) as { text?: string };
    const title = parseTitle(res.text ?? "");
    if (!title) throw new Error("Hermes's model didn't come up with a title.");
    await this.rename(chatId, title);
    return title;
  }

  /**
   * Marks a chat unread, or read, in every Hermes client (`PATCH {unread}`). Marking the chat on screen unread means
   * the owner is moving off it, so new activity in it shows the dot again. Rejects with why if Hermes refuses; the
   * next refresh then shows the chat as Hermes has it.
   */
  setUnread(chatId: string, unread: boolean): Promise<void> {
    if (unread && this.viewing === chatId) this.viewing = undefined;
    return this.writeRead(chatId, unread);
  }

  /**
   * The chat as Markdown, to paste somewhere else: its title, then each message the owner sent and each reply, oldest
   * first. Tool calls, Approvals and errors are left out. A chat not yet open on this connection is loaded first.
   */
  async transcript(chatId: string): Promise<string> {
    const chat = await this.loaded(chatId);
    const messages = chat.items.flatMap((i) => {
      if (i.kind === "user") {
        const files = i.attachments?.length ? `\n\n_Attached: ${i.attachments.join(", ")}_` : "";
        return [`**You:** ${i.text.trim()}${files}`];
      }
      return i.kind === "assistant" && i.text.trim() ? [`**Hermes:** ${i.text.trim()}`] : [];
    });
    return [`# ${chat.title}`, ...messages].join("\n\n") + "\n";
  }

  /** The folder Hermes works in for this chat, as it stored it: the session's `cwd`, else its git repository's root. */
  async workingFolder(chatId: string): Promise<string> {
    const query = new URLSearchParams({ profile: this.profile });
    const row = (await this.rest("GET", `api/sessions/${encodeURIComponent(chatId)}?${query}`)) as SessionDetail;
    const folder = row.cwd?.trim() || row.git_repo_root?.trim();
    if (!folder) throw new Error("Hermes hasn't stored a working folder for this chat.");
    return folder;
  }

  /**
   * Deletes a chat from Hermes for good, in every Hermes client (`DELETE /api/sessions/{id}`). It leaves the list here
   * at once; if Hermes refuses, it comes back and the list says why. A chat with a reply running isn't deleted: stop
   * the reply first. `profile` is the chat's, which the owner may switch away from while the delete is under way.
   * Resolves to whether Hermes deleted it.
   */
  async delete(chatId: string): Promise<boolean> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.running) return false;
    const profile = this.profile;
    this.deleted.add(chatId);
    this.pinWanted.delete(chatId);
    this.revealed.delete(chatId);
    this.staleItems.delete(chatId);
    this.resumeOnReconnect.delete(chatId);
    if (this.viewing === chatId) this.viewing = undefined;
    this.update({ chats: this.snapshot.chats.filter((c) => c.id !== chatId) });
    this.saveList(profile, this.snapshot.chats);
    try {
      // A pin write still under way would otherwise land on a deleted session and report a failure.
      await this.pinWrites.get(chatId);
      await this.rest("DELETE", `api/sessions/${encodeURIComponent(chatId)}?${new URLSearchParams({ profile })}`);
      this.mark(chatId, { pinned: false, snoozedUntil: undefined }, profile);
      return true;
    } catch (e) {
      this.deleted.delete(chatId);
      if (this.profile !== profile) return false;
      const chats = this.snapshot.chats.some((c) => c.id === chatId) ? this.snapshot.chats : [...this.snapshot.chats, chat];
      this.update({ chats, syncError: `Couldn't delete "${chat.title}": ${(e as Error).message}` });
      this.saveList(profile, chats);
      return false;
    }
  }

  /**
   * Where else Hermes posts its replies in this chat, besides Hermes clients. On the canonical protocol, a reply in a
   * chat started in Telegram or Discord also goes to that platform chat, unless the platform chat has since moved to
   * another session. This app speaks only the legacy protocol, where replies stay in Hermes clients (research doc
   * §5), so there is nowhere else yet.
   */
  alsoPostsIn(_chatId: string): Source | undefined {
    return undefined;
  }

  /**
   * Stops the chat's reply with legacy `session.interrupt`, once Hermes has accepted the message it answers. Hermes
   * answers before the agent has stopped, so the chat is `stopping` until the turn's `message.complete`, which
   * marks the reply interrupted and its running tool calls stopped. If Hermes can't stop it, the chat says so and
   * the reply keeps running.
   */
  async stop(chatId: string): Promise<void> {
    const stoppable = () => {
      const c = this.snapshot.chats.find((c) => c.id === chatId);
      return c?.running && !c.stopping ? c : undefined;
    };
    if (!stoppable()) return;
    try {
      await this.submitting.get(chatId);
    } catch {
      return; // send() has shown why the message didn't go.
    }
    const chat = stoppable();
    if (!chat?.runtimeId) return;
    this.patchChat(chatId, (c) => ({ ...c, stopping: true }));
    try {
      const res = (await this.request("session.interrupt", { session_id: chat.runtimeId })) as InterruptResult;
      if (res.status !== "interrupted") this.patchChat(chatId, (c) => ({ ...c, stopping: false }));
    } catch (e) {
      // A turn that has already ended, or a dropped connection, needs no error.
      this.patchChat(chatId, (c) =>
        c.stopping ? { ...c, stopping: false, items: [...c.items, errorItem(c, `Couldn't stop the reply: ${(e as Error).message}`)] } : c,
      );
    }
  }

  /**
   * Answers an Approval with the owner's choice, in a response frame to Hermes's request (research doc §6). One
   * already answered, or that Hermes stopped waiting for, is left alone. If the answer can't go, the chat says so
   * and the card stays waiting.
   */
  async answerApproval(chatId: string, approvalId: string, choice: ApprovalChoice): Promise<void> {
    const waiting = this.snapshot.chats.find((c) => c.id === chatId)?.items.some((i) => i.id === approvalId && isWaiting(i));
    if (!waiting) return;
    const answer = (a?: ApprovalChoice) =>
      this.patchChat(chatId, (c) => ({ ...c, items: c.items.map((i) => (i.id === approvalId && i.kind === "approval" ? { ...i, answer: a } : i)) }));
    answer(choice);
    try {
      if (!this.pipe || this.snapshot.status !== "connected") throw new Error("Not connected to Hermes.");
      await this.pipe.send(JSON.stringify({ jsonrpc: "2.0", id: approvalId, result: { choice, all: false } }));
    } catch (e) {
      answer(undefined);
      this.patchChat(chatId, (c) => ({ ...c, items: [...c.items, errorItem(c, `Couldn't answer Hermes: ${(e as Error).message}`)] }));
    }
  }

  /**
   * Refreshes the chat list from dashboard REST: the profile's chats active in the past month, or all of them once
   * older history is pulled, Active when pinned. A call while a sync is running asks for one more pass and resolves
   * with it.
   */
  async sync(): Promise<void> {
    await this.syncList();
  }

  /**
   * Pulls the profile's chats older than a month into the list: from now on it holds all of them, Settled unless
   * pinned (ADR 0002), and the profile remembers it. Resolves to the older chats added. Only reads from Hermes. If
   * the list can't be read, or the owner switches profile first, rejects and leaves the list a month long.
   */
  async pullOlderHistory(): Promise<Chat[]> {
    const profile = this.profile;
    const cutoff = Date.now() - LIST_WINDOW_MS;
    const before = new Set(this.snapshot.chats.map((c) => c.id));
    this.update({ olderPulled: true });
    const failure = await this.syncList();
    // The switch shows the new profile's flag, and this profile's list wasn't read.
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the older chats arrived.`);
    if (failure) {
      this.update({ olderPulled: false });
      throw failure;
    }
    this.cache.rememberOlderPulled(profile);
    return this.snapshot.chats.filter((c) => !before.has(c.id) && c.updatedAt < cutoff);
  }

  /** The storage the chat lists saved on this computer take, in bytes. */
  cacheBytes(): number {
    return this.cache.bytes();
  }

  /**
   * Deletes the chat lists saved on this computer. Nothing is sent to Hermes. The list on screen stays, and the next
   * refresh saves it again.
   */
  clearCache() {
    this.cache.clear();
  }

  /** `sync`, resolving to why the last pass failed, if it did. */
  private syncList(): Promise<Error | undefined> {
    if (this.snapshot.status !== "connected") return Promise.resolve(new Error("Not connected to Hermes.")); // Reconnecting syncs again.
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        let failure: Error | undefined;
        do {
          this.syncAgain = false;
          failure = await this.syncOnce();
        } while (this.syncAgain);
        return failure;
      } finally {
        this.syncing = undefined;
      }
    })();
    this.track(this.syncing);
    return this.syncing;
  }

  /** Resolves once background work (list syncs, pinning) has finished. Tests wait on it; the app doesn't need to. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  async close() {
    this.closing = true;
    this.abortDial?.(new Error("Closed by the app."));
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.wakeTimer);
    clearInterval(this.heartbeat);
    await this.pipe?.close();
  }

  private handle(e: PipeEvent) {
    if (e.kind === "closed") return this.dropped(e.reason);
    this.lastHeard = Date.now();
    let frame: RpcFrame;
    try {
      frame = JSON.parse(e.text);
    } catch {
      return;
    }
    if (frame.method === undefined && typeof frame.id === "number") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new RpcError(frame.error.code, frame.error.message));
      else p.resolve(frame.result);
      return;
    }
    if (typeof frame.id === "string" && frame.method) return this.onServerRequest({ id: frame.id, method: frame.method, params: frame.params ?? {} });
    if (frame.method !== "event" || !frame.params?.type) return;
    const { type, session_id, payload = {} } = frame.params;
    if (type === "gateway.ready") {
      this.onReady?.(payload);
      return;
    }
    // Broadcast when any process changes the session store (tui_gateway/change_watcher.py).
    if (type === "sessions.changed") {
      void this.sync();
      return;
    }
    const chat = session_id ? this.snapshot.chats.find((c) => c.runtimeId === session_id) : undefined;
    if (!chat) return;
    this.patchChat(chat.id, (c) => applyEvent(c, type, payload));
    // By the end of a turn Hermes has stored the session, so a pin that failed earlier can succeed.
    if (type === "message.complete" && this.pinWanted.has(chat.id)) this.track(this.writePin(chat.id));
    // The finished reply is newer than the read watermark, though the owner watched it come in.
    if (type === "message.complete" && chat.id === this.viewing) this.markRead(chat.id);
  }

  /**
   * A question from Hermes. An Approval shows as a card in its chat. Other kinds this app can't show yet are turned
   * down, so the agent doesn't wait out their timeout for an answer that won't come.
   */
  private onServerRequest(req: ServerRequest) {
    if (req.method !== "approval") {
      const error = { code: NO_SUCH_METHOD, message: `Hermes Chat can't answer ${req.method} requests yet.` };
      void this.pipe?.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error })).catch(() => {});
      return;
    }
    const sid = String(req.params.session_id ?? "");
    const chat = this.snapshot.chats.find((c) => c.runtimeId === sid);
    if (chat) this.showApprovals(chat.id, [req]);
    else this.earlyRequests.set(sid, [...(this.earlyRequests.get(sid) ?? []), req]);
  }

  /** Adds a card for each Approval request the chat doesn't show yet. A request can be listed more than once. */
  private showApprovals(chatId: string, reqs: ServerRequest[]) {
    this.patchChat(chatId, (c) => {
      const shown = new Set(c.items.map((i) => i.id));
      const cards = reqs.filter((r) => r.method === "approval" && !shown.has(r.id) && shown.add(r.id)).map(approvalItem);
      return cards.length ? { ...c, items: [...c.items, ...cards] } : c;
    });
    if (chatId === this.viewing) this.tellShown(chatId);
  }

  /**
   * Tells Hermes that the chat's waiting Approvals are on screen (`approval.received`), once each. A server
   * without that method is asked no more.
   */
  private tellShown(chatId: string) {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat?.runtimeId || this.noApprovalReceived) return;
    for (const i of chat.items) {
      if (i.kind !== "approval" || !isWaiting(i) || this.shownApprovals.has(i.requestId)) continue;
      this.shownApprovals.add(i.requestId);
      const told = this.request("approval.received", { session_id: chat.runtimeId, request_id: i.requestId }).catch((e) => {
        this.shownApprovals.delete(i.requestId);
        if (e instanceof RpcError && e.code === NO_SUCH_METHOD) this.noApprovalReceived = true;
      });
      this.track(told);
    }
  }

  /**
   * Resumes the chats that were busy when the connection dropped, so the Approvals Hermes is still waiting on come
   * back, asked before the drop or during it. A waiting card whose chat can't be loaded again is closed.
   */
  private resumeBusyChats() {
    const ids = [...this.resumeOnReconnect].filter((id) => this.snapshot.chats.some((c) => c.id === id));
    this.resumeOnReconnect.clear();
    for (const id of ids)
      this.track(this.resume(id).catch(() => this.patchChat(id, (c) => ({ ...c, items: endWaitingApprovals(c.items, "lost") }))));
  }

  /** The connection has dropped, and reconnecting starts. */
  private dropped(reason: string) {
    this.detach(reason);
    this.retryLater();
  }

  /**
   * Lets go of the connection: requests in flight fail and replies stop running. Closing a connection detaches its
   * runtime sessions, so each chat resumed on it resumes again when next opened.
   */
  private detach(reason: string) {
    const pipe = this.pipe;
    this.pipe = undefined;
    this.generation++;
    clearInterval(this.heartbeat);
    // Lets the Rust side end the tunnel.
    if (pipe) this.droppedClosing = pipe.close().catch(() => {}).finally(() => (this.droppedClosing = undefined));
    for (const p of this.pending.values()) p.reject(new Error(`Connection closed: ${reason}`));
    this.pending.clear();
    this.earlyRequests.clear();
    for (const c of this.snapshot.chats) {
      if (c.runtimeId) this.staleItems.set(c.id, c.items.length);
      if (c.running || c.items.some(isWaiting)) this.resumeOnReconnect.add(c.id);
    }
    this.update({
      status: "reconnecting",
      closedReason: reason,
      chats: this.snapshot.chats.map((c) => (c.runtimeId || c.running ? { ...c, runtimeId: undefined, running: false, stopping: false } : c)),
    });
  }

  private retryLater() {
    const wait = RETRY_DELAYS_MS[this.failedTries];
    if (wait === undefined) return this.update({ status: "offline" });
    this.retryTimer = setTimeout(() => void this.redial(), wait);
  }

  private redial(): Promise<void> {
    if (this.closing || this.snapshot.status === "connected") return Promise.resolve();
    this.redialing ??= (async () => {
      clearTimeout(this.retryTimer);
      this.update({ status: "reconnecting" });
      try {
        await this.dial();
        this.failedTries = 0;
        this.resumeBusyChats();
        void this.sync();
      } catch (e) {
        if (this.closing) return;
        this.failedTries++;
        this.update({ closedReason: (e as Error).message });
        // A server that changed protocol won't change back on its own.
        if (e instanceof ProtocolMismatchError) this.update({ status: "offline" });
        else this.retryLater();
      } finally {
        this.redialing = undefined;
      }
    })();
    return this.redialing;
  }

  /** Pings Hermes, or drops the connection if it has gone quiet; any frame counts as an answer. */
  private beat() {
    if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) return this.dropped("Hermes stopped answering.");
    this.request("gateway.ping", {}).catch(() => {});
  }

  /**
   * Stages the attachments for the session's next turn, then submits the message. Images are queued server-side;
   * other files are staged in the session's workspace and their `@file:` refs go before the text, as the official
   * desktop app does. If anything fails the message isn't sent, and images already queued are taken back so they
   * don't ride along with the next one.
   */
  private async submit(runtimeId: string, text: string, attachments: Attachment[]) {
    const queued: string[] = [];
    const refs: string[] = [];
    try {
      for (const a of attachments) {
        const file = { path: a.path, maxBytes: LIMITS[a.kind].bytes };
        try {
          if (a.kind === "image") {
            const params = { session_id: runtimeId, filename: a.name, content_base64: FILE_MARK };
            queued.push(((await this.request("image.attach_bytes", params, file)) as ImageAttached).path);
          } else {
            const params = { session_id: runtimeId, name: a.name, data_url: `data:application/octet-stream;base64,${FILE_MARK}` };
            refs.push(((await this.request("file.attach", params, file)) as FileAttached).ref_text);
          }
        } catch (e) {
          throw new Error(`Couldn't attach ${a.name}: ${(e as Error).message}`);
        }
      }
      const prompt = [refs.join("\n"), text].filter(Boolean).join("\n\n") || (queued.length ? IMAGE_ONLY_PROMPT : "");
      return await this.request("prompt.submit", { session_id: runtimeId, profile: this.profile, text: prompt });
    } catch (e) {
      for (const path of queued) this.track(this.request("image.detach", { session_id: runtimeId, path }));
      throw e;
    }
  }

  /** The chat's runtime id on this connection, resuming it first if needed. The history goes before anything sent
   * meanwhile. */
  private resume(chatId: string): Promise<string> {
    const known = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (known) return Promise.resolve(known);
    let resuming = this.resuming.get(chatId);
    if (resuming) return resuming;
    this.patchChat(chatId, (c) => ({ ...c, loading: true }));
    resuming = (async () => {
      try {
        const res = (await this.request("session.resume", { session_id: chatId, profile: this.profile, inline_images: false })) as {
          session_id: string;
          messages?: TranscriptMessage[];
          /** A live session's turn is still going. */
          running?: boolean;
          /** What a live session is still waiting on, oldest first. */
          open_requests?: ServerRequest[];
        };
        const history = historyItems(res.messages ?? []);
        const stale = this.staleItems.get(chatId) ?? 0;
        this.staleItems.delete(chatId);
        const early = this.earlyRequests.get(res.session_id) ?? [];
        this.earlyRequests.delete(res.session_id);
        const asking = [...(res.open_requests ?? []), ...early];
        // History has no cards. A card that was waiting when the connection dropped either comes back below, or
        // Hermes let go of the session meanwhile and the card stays, closed.
        const lost = (items: Item[]) => endWaitingApprovals(items.filter((i) => isWaiting(i) && !asking.some((r) => r.id === i.id)), "lost");
        this.patchChat(chatId, (c) => ({
          ...c,
          runtimeId: res.session_id,
          running: c.running || !!res.running,
          items: [...history, ...lost(c.items.slice(0, stale)), ...withoutLoadError(c.items.slice(stale))],
        }));
        this.showApprovals(chatId, asking);
        return res.session_id;
      } finally {
        this.resuming.delete(chatId);
        this.patchChat(chatId, (c) => ({ ...c, loading: false }));
      }
    })();
    this.resuming.set(chatId, resuming);
    return resuming;
  }

  private setSettled(chatId: string, settled: boolean): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.settled === settled) return Promise.resolve();
    this.pinWanted.set(chatId, !settled);
    this.patchChat(chatId, (c) => ({ ...c, settled }));
    return this.writePin(chatId);
  }

  /**
   * Writes the chat's wanted pinned flag once any earlier write for it is done. Each write reads the flag as it goes
   * out, so a quick Undo leaves the server where the owner left the chat. A failed write stays wanted: the chat stays
   * where the owner put it here, and the next finished turn or refresh tries again. A chat with a turn running may
   * not be stored yet, so its failure isn't reported until the end of the turn. `profile` is the chat's, which the
   * owner may have switched away from by the time the write goes out.
   */
  private writePin(chatId: string, profile = this.profile): Promise<void> {
    const write = (this.pinWrites.get(chatId) ?? Promise.resolve()).then(async () => {
      const pinned = this.pinWanted.get(chatId);
      if (pinned === undefined) return;
      const running = this.snapshot.chats.find((c) => c.id === chatId)?.running;
      try {
        await this.rest("PATCH", `api/sessions/${encodeURIComponent(chatId)}`, { pinned, profile });
        this.pinnedSinceListRead.add(chatId);
        if (this.pinWanted.get(chatId) === pinned) this.pinWanted.delete(chatId);
      } catch (e) {
        if (!running) this.update({ syncError: `Couldn't keep a chat ${pinned ? "Active" : "Settled"} on the server: ${(e as Error).message}` });
      }
    });
    this.pinWrites.set(chatId, write);
    void write.finally(() => this.pinWrites.get(chatId) === write && this.pinWrites.delete(chatId));
    return write;
  }

  /**
   * Clears the chat's dot here at once and moves its shared read watermark to now (`PATCH {unread: false}`), so
   * opening it here clears the dot in every Hermes client. A failed write isn't reported: the next refresh shows
   * the dot again.
   */
  private markRead(chatId: string) {
    this.track(this.writeRead(chatId, false));
  }

  /**
   * Shows or clears the chat's dot here at once, and moves its shared read watermark (`PATCH {unread}`): to now for
   * read, back to the start for unread.
   */
  private writeRead(chatId: string, unread: boolean): Promise<void> {
    this.patchChat(chatId, (c) => (!!c.unread === unread ? c : { ...c, unread }));
    const write: Promise<void> = this.rest("PATCH", `api/sessions/${encodeURIComponent(chatId)}`, { unread, profile: this.profile })
      .then(() => void this.readSinceListRead.set(chatId, unread))
      .finally(() => this.readWrites.get(chatId)?.write === write && this.readWrites.delete(chatId));
    this.readWrites.set(chatId, { unread, write });
    return write;
  }

  /** The chat with its whole history, resuming it on this connection first if it isn't yet. */
  private async loaded(chatId: string): Promise<Chat> {
    await this.resume(chatId);
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("The chat isn't in the list any more.");
    return chat;
  }

  /** Changes a chat's Pinned and Snoozed marks in `profile`, keeps them on this computer, and shows them. */
  private mark(chatId: string, change: { pinned?: boolean; snoozedUntil?: number }, profile = this.profile) {
    const was = this.marks[profile] ?? { pinned: [], snoozed: {} };
    let pinned = was.pinned;
    if (change.pinned !== undefined && change.pinned !== pinned.includes(chatId))
      pinned = change.pinned ? [...pinned, chatId] : pinned.filter((id) => id !== chatId);
    let snoozed = was.snoozed;
    if ("snoozedUntil" in change && change.snoozedUntil !== snoozed[chatId]) {
      const { [chatId]: _, ...others } = snoozed;
      snoozed = change.snoozedUntil === undefined ? others : { ...others, [chatId]: change.snoozedUntil };
    }
    if (pinned === was.pinned && snoozed === was.snoozed) return;
    const { [profile]: _, ...others } = this.marks;
    this.marks = pinned.length || Object.keys(snoozed).length ? { ...others, [profile]: { pinned, snoozed } } : others;
    this.cache.saveMarks(this.marks);
    this.update({ chats: this.snapshot.chats });
    this.scheduleWake();
  }

  /** Sets the timer for the next Snoozed chat to wake, in any profile. */
  private scheduleWake() {
    clearTimeout(this.wakeTimer);
    const next = Math.min(...Object.values(this.marks).flatMap((m) => Object.values(m.snoozed)));
    if (this.closing || next === Infinity) return;
    this.wakeTimer = setTimeout(() => this.wake(), Math.min(Math.max(next - Date.now(), 0), MAX_WAIT_MS));
  }

  /**
   * Wakes the Snoozed chats whose time has come, in every profile: each moves to Active, at the top, and is marked
   * unread unless it's on screen. While the app isn't connected they wait: the sync after reconnecting wakes them.
   */
  private wake() {
    if (this.snapshot.status !== "connected") return;
    const now = Date.now();
    let woke = false;
    for (const [profile, { snoozed }] of Object.entries(this.marks))
      for (const [chatId, until] of Object.entries(snoozed)) {
        if (until > now) continue;
        if (profile !== this.profile || !this.snapshot.chats.some((c) => c.id === chatId)) {
          this.track(this.wakeUnlisted(profile, chatId, until));
          continue;
        }
        woke = true;
        this.patchChat(chatId, (c) => ({ ...c, updatedAt: Math.max(c.updatedAt, now) }));
        this.track(this.unsettle(chatId));
        if (chatId !== this.viewing) this.track(this.writeRead(chatId, true));
      }
    if (woke) this.saveList(this.profile, this.snapshot.chats);
    this.scheduleWake();
  }

  /**
   * Wakes a Snoozed chat that isn't in the list on screen: one in another profile, or older than the list goes back.
   * Hermes is told at once; the chat shows when its profile's list is next read. A failed write tries again at the
   * next sync.
   */
  private async wakeUnlisted(profile: string, chatId: string, until: number) {
    await this.rest("PATCH", `api/sessions/${encodeURIComponent(chatId)}`, { pinned: true, unread: true, profile });
    if (this.marks[profile]?.snoozed[chatId] === until) this.mark(chatId, { snoozedUntil: undefined }, profile);
  }

  private async syncOnce(): Promise<Error | undefined> {
    const profile = this.profile;
    const cutoff = this.snapshot.olderPulled ? -Infinity : Date.now() - LIST_WINDOW_MS;
    this.pinnedSinceListRead.clear();
    this.readSinceListRead.clear();
    // A title written before this read is in it.
    for (const id of this.retitledSinceListRead) if (!this.titleWrites.has(id)) this.titleWanted.delete(id);
    this.retitledSinceListRead.clear();
    const rows = new Map<string, SessionRow>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const query = new URLSearchParams({
          profile,
          order: "recent",
          limit: String(PAGE_SIZE),
          offset: String(offset),
          exclude_sources: "cron",
        });
        const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
        for (const r of res.sessions) rows.set(r.id, r);
        // Every page also carries all pinned rows, out of order; the unpinned ones follow recency.
        const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
        if (passedCutoff || res.sessions.length === 0 || offset + PAGE_SIZE >= res.total) break;
      }
    } catch (e) {
      if (this.profile === profile) this.update({ syncError: `Couldn't refresh the chat list: ${(e as Error).message}` });
      return e as Error;
    }
    // The owner switched profile meanwhile; the switch syncs the new one.
    if (this.profile !== profile) return undefined;

    const known = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    const marks = this.marks[profile];
    // A Pinned or Snoozed chat stays however old, and so does one that woke here within the window.
    const recent = (r: SessionRow) =>
      lastActive(r) >= cutoff || (known.get(r.id)?.updatedAt ?? 0) >= cutoff || !!marks?.pinned.includes(r.id) || marks?.snoozed[r.id] !== undefined;
    let readOnScreen = false;
    const listed = [...rows.values()]
      .filter((r) => !r.archived && !this.deleted.has(r.id) && recent(r))
      .map((r): Chat => {
        const c = known.get(r.id);
        // A row read before this app's latest write is stale; the chat stays where the owner put it until the next sync.
        const wanted = this.pinWanted.get(r.id) ?? (c && this.pinnedSinceListRead.has(r.id) ? !c.settled : undefined);
        // A write under way may still change the flag, so only an idle chat's flag can confirm it or need a retry. A
        // message still on the way may fail, and the chat then goes back to Settled, so it isn't pinned before then.
        if (this.pinWanted.has(r.id) && !this.pinWrites.has(r.id) && !this.pinnedSinceListRead.has(r.id)) {
          if (wanted === !!r.pinned) this.pinWanted.delete(r.id);
          else if (!this.submitting.has(r.id)) this.track(this.writePin(r.id));
        }
        // A row read before this app marked the chat read or unread is stale too.
        const unreadHere = this.readWrites.get(r.id)?.unread ?? this.readSinceListRead.get(r.id);
        if (r.id === this.viewing && r.unread && unreadHere === undefined) readOnScreen = true;
        return {
          items: [],
          ...c,
          id: r.id,
          title: this.titleWanted.get(r.id) ?? (r.title || r.preview || c?.title || "Untitled chat"),
          source: toSource(r.source),
          settled: !(wanted ?? r.pinned),
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
          unread: r.id !== this.viewing && (unreadHere ?? !!r.unread),
        };
      });
    // Chats started or resumed on this connection stay even before Hermes stores them (a new chat has no row
    // until its first prompt), and so do chats picked from a search.
    const listedIds = new Set(listed.map((c) => c.id));
    const onThisConnection = this.snapshot.chats.filter((c) => (c.runtimeId || this.revealed.has(c.id)) && !listedIds.has(c.id));
    const chats = [...onThisConnection, ...listed];
    this.update({ chats, syncError: undefined });
    // Moved in another Hermes client: a Pinned chat that is now Settled is unpinned, and a Snoozed one that is now
    // Active stops snoozing.
    for (const c of listed) {
      if (c.settled && marks?.pinned.includes(c.id)) this.mark(c.id, { pinned: false });
      if (!c.settled && marks?.snoozed[c.id] !== undefined) this.mark(c.id, { snoozedUntil: undefined });
    }
    if (readOnScreen) this.markRead(this.viewing!);
    this.saveList(profile, chats);
    this.wake();
    return undefined;
  }

  /** Keeps the profile's list for the next start, without the chats' transcripts. */
  private saveList(profile: string, chats: Chat[]) {
    this.cache.save(
      profile,
      chats.map(({ id, title, source, settled, updatedAt, unread }) => ({ id, title, source, settled, updatedAt, unread, items: [] })),
    );
  }

  private async rest(method: "GET" | "PATCH" | "DELETE", pathAndQuery: string, body?: unknown): Promise<unknown> {
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    return JSON.parse(await this.pipe.request(method, pathAndQuery, body === undefined ? undefined : JSON.stringify(body)));
  }

  private track(p: Promise<unknown>) {
    const done: Promise<unknown> = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** One JSON-RPC request. With a `file`, the pipe swaps its base64 in for the `FILE_MARK` in `params`. */
  private request(method: string, params: Record<string, unknown>, file?: { path: string; maxBytes: number }): Promise<unknown> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const [head, tail, ...rest] = frame.split(JSON.stringify(FILE_MARK).slice(1, -1));
    const sent = !file
      ? pipe.send(frame)
      : rest.length === 0 && tail !== undefined
        ? pipe.sendFile(head, file.path, tail, file.maxBytes)
        : Promise.reject(new Error("the request has no single place for the file"));
    sent.catch((err) => {
      this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.delete(id);
    });
    return done;
  }

  private patchChat(id: string, fn: (c: Chat) => Chat) {
    if (!this.snapshot.chats.some((c) => c.id === id)) return;
    this.update({ chats: this.snapshot.chats.map((c) => (c.id === id ? fn(c) : c)) });
  }

  private update(patch: Partial<Snapshot>) {
    if (patch.chats) patch = { ...patch, chats: this.withMarks(patch.chats, patch.profile ?? this.snapshot.profile) };
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** The chats with their Pinned and Snoozed marks in `profile`. */
  private withMarks(chats: Chat[], profile: string): Chat[] {
    const m = this.marks[profile];
    return chats.map((c) => {
      const pinned = m?.pinned.includes(c.id) || undefined;
      const snoozedUntil = m?.snoozed[c.id];
      return c.pinned === pinned && c.snoozedUntil === snoozedUntil ? c : { ...c, pinned, snoozedUntil };
    });
  }
}

function lastActive(r: Pick<SessionRow, "last_active" | "started_at">): number {
  return (r.last_active ?? r.started_at ?? 0) * 1000;
}

/** An FTS5 snippet as text with the matched words marked, on one line. */
function snippetParts(snippet: string): Found["snippet"] {
  return snippet
    .replace(/\s+/g, " ")
    .split(/>>>(.*?)<<</)
    .flatMap((text, i) => (!text ? [] : i % 2 ? [{ text, hit: true }] : [{ text }]));
}

/**
 * What find-in-chat looks for in a chat found by `q`: a one-word `q` where the snippet holds it, else the first
 * matched word, since Hermes matches each word of `q` on its own and as a prefix. Several words are never looked for
 * together: on screen, a line break or formatting can sit between them.
 */
function findTerm(q: string, snippet: Found["snippet"]): string {
  const plain = snippet.map((p) => p.text).join("");
  if (!/\s/.test(q) && plain.toLowerCase().includes(q.toLowerCase())) return q;
  return snippet.find((p) => p.hit)?.text ?? q;
}

/** A chat's Source from the session's `source` field. This app's own chats, and `gui` ones, show no icon. */
function toSource(source = ""): Source {
  switch (source) {
    case APP_SOURCE:
    case "gui":
      return "app";
    case "telegram":
    case "discord":
    case "desktop":
      return source;
    case "cli":
    case "tui":
      return "cli";
    default:
      return "other";
  }
}

/**
 * What the titling model reads: each message's start, labelled, keeping the chat's start and end when it's long.
 * Empty when the chat has no messages yet.
 */
function titleInput(items: Item[]): string {
  const lines = items.flatMap((i) =>
    (i.kind === "user" || i.kind === "assistant") && i.text.trim()
      ? [`${i.kind === "user" ? "User" : "Assistant"}: ${i.text.trim().slice(0, TITLE_MESSAGE_CHARS)}`]
      : [],
  );
  const text = lines.join("\n\n");
  if (text.length <= TITLE_HEAD_CHARS + TITLE_TAIL_CHARS) return text;
  return `${text.slice(0, TITLE_HEAD_CHARS)}\n\n[…]\n\n${text.slice(-TITLE_TAIL_CHARS)}`;
}

/** The title in the model's reply, `{"title": "..."}` maybe in a code fence, or failing that its first line. */
function parseTitle(reply: string): string {
  const text = reply.replace(/```(?:json)?/gi, "").trim();
  let title = text.split("\n")[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "null");
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") title = parsed.title;
  } catch {
    // Not JSON: the first line stands.
  }
  return title
    .replace(/^title:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.!?;:,]+$/, "")
    .trim()
    .slice(0, 80);
}

const LOAD_ERROR_ID = "load-error";
const withoutLoadError = (items: Item[]) => items.filter((i) => i.id !== LOAD_ERROR_ID);

/**
 * Stored history as transcript items. Hermes doesn't keep tool results, except for edit tools. An assistant row's
 * reasoning shows as thinking before its text.
 */
function historyItems(messages: TranscriptMessage[]): Item[] {
  return messages.flatMap((m, i): Item[] => {
    const id = `h-${i}`;
    const thought: Item[] = m.role === "assistant" && m.reasoning?.trim() ? [{ kind: "thinking", id: `${id}-r`, text: m.reasoning.trim() }] : [];
    if (m.role === "tool")
      return [
        {
          kind: "tool",
          id,
          name: m.name || "tool",
          args: m.args ?? undefined,
          preview: m.context || undefined,
          status: "done",
          result: typeof m.content === "string" ? m.content : undefined,
        },
      ];
    // Assistant rows can be reasoning only; system rows are timeline notes this app doesn't show yet.
    if (!m.text?.trim()) return thought;
    if (m.role === "user" || m.role === "assistant") return [...thought, { kind: m.role, id, text: m.text }];
    return [];
  });
}

function approvalItem(r: ServerRequest): ApprovalItem {
  const p = r.params;
  return { kind: "approval", id: r.id, requestId: String(p.request_id ?? ""), command: String(p.command ?? ""), description: String(p.description ?? "") };
}

const endWaitingApprovals = (items: Item[], ended: string) => items.map((i): Item => (isWaiting(i) ? { ...i, ended } : i));

function errorItem(c: Chat, text: string): Item {
  return { kind: "error", id: `e-${c.items.length}`, text };
}

/** Ends a turn's tool calls that were still running when it ended. */
const endRunningTools = (items: Item[], status: "done" | "stopped") =>
  items.map((i): Item => (i.kind === "tool" && i.status === "running" ? { ...i, status } : i));

/**
 * Marks the last reply interrupted and its running tool calls stopped. A reply stopped before it said anything gets
 * an empty one, so the transcript still shows the stop.
 */
function markInterrupted(items: Item[]): Item[] {
  const out = endRunningTools(items, "stopped");
  const last = out[out.length - 1];
  if (last?.kind === "assistant") out[out.length - 1] = { ...last, interrupted: true };
  else out.push({ kind: "assistant", id: `a-${out.length}`, text: "", interrupted: true });
  return out;
}

// Fold one session event into a chat. Text deltas extend the trailing assistant item, or start a new one
// after a tool call; reasoning deltas do the same with thinking items.
function applyEvent(c: Chat, type: string, p: Record<string, unknown>): Chat {
  const items = [...c.items];
  const last = items[items.length - 1];
  switch (type) {
    case "message.start":
      return { ...c, running: true, updatedAt: Date.now() };
    // `thinking.delta` is Hermes's spinner and wait notices, not reasoning, so it isn't shown.
    case "reasoning.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "thinking") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "thinking", id: `r-${items.length}`, text });
      return { ...c, items, updatedAt: Date.now() };
    }
    // A response's reasoning in one go, up to 500 characters, when the model didn't stream it.
    case "reasoning.available": {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (!text || last?.kind === "thinking") return c;
      items.push({ kind: "thinking", id: `r-${items.length}`, text });
      return { ...c, items };
    }
    case "message.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "assistant") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "assistant", id: `a-${items.length}`, text });
      return { ...c, items, updatedAt: Date.now() };
    }
    case "tool.start":
      items.push({
        kind: "tool",
        id: String(p.tool_id),
        name: String(p.name ?? "tool"),
        args: p.args as Record<string, unknown> | undefined,
        preview: p.preview as string | undefined,
        status: "running",
      });
      return { ...c, items };
    case "tool.complete":
      return {
        ...c,
        items: items.map((i) =>
          i.kind === "tool" && i.id === String(p.tool_id)
            ? {
                ...i,
                status: "done",
                durationS: p.duration_s as number | undefined,
                result: typeof p.result === "string" ? p.result : p.result == null ? undefined : JSON.stringify(p.result, null, 2),
                summary: p.summary as string | undefined,
              }
            : i,
        ),
      };
    case "request.cancel":
      // Hermes stopped waiting: timed out, interrupted, or answered in another Hermes client.
      return { ...c, items: items.map((i) => (isWaiting(i) && i.id === p.id ? { ...i, ended: String(p.reason || "withdrawn") } : i)) };
    case "message.complete": {
      // Providers that don't stream send the whole reply here; a streamed turn repeats text it already sent.
      const lastUser = items.map((i) => i.kind).lastIndexOf("user");
      const answered = items.slice(lastUser + 1).some((i) => i.kind === "assistant");
      // The last response's reasoning, for a turn that showed none: it goes before the reply.
      const reasoning = typeof p.reasoning === "string" ? p.reasoning.trim() : "";
      if (reasoning && !items.slice(lastUser + 1).some((i) => i.kind === "thinking")) {
        const reply = items.map((i) => i.kind).lastIndexOf("assistant");
        items.splice(reply > lastUser ? reply : items.length, 0, { kind: "thinking", id: `r-${items.length}`, text: reasoning });
      }
      if (!answered && typeof p.text === "string" && p.text) items.push({ kind: "assistant", id: `a-${items.length}`, text: p.text });
      const end = { ...c, running: false, stopping: false, updatedAt: Date.now() };
      // Stopped here or from another Hermes client.
      if (p.status === "interrupted") return { ...end, items: markInterrupted(endWaitingApprovals(items, "turn ended")) };
      const failure = p.error ?? (p.status === "error" ? p.failure_reason ?? "The turn failed." : undefined);
      if (failure) items.push(errorItem({ ...c, items }, String(failure)));
      return { ...end, items: endRunningTools(endWaitingApprovals(items, "turn ended"), "done") };
    }
    case "error":
      items.push(errorItem(c, String(p.message ?? "Hermes reported an error.")));
      return { ...c, items: endWaitingApprovals(items, "turn ended"), running: false, stopping: false };
    default:
      return c;
  }
}
