import { errorText, isObj } from "./values";
import type { AppMethod } from "./canonicalVerbs";
import type { Same } from "./fieldMerge";
// Hermes's Bot Mode (ADR 0066, research doc "Bot Mode"). Each bot is a Hermes profile with a persistent identity, and
// each has one Bot Chat: the profile's session titled exactly "Bot Chat". That title is the chat's only identity. It is
// looked up by title on every open (`session.list {title, include_hidden: true}`), never by a session id kept here,
// and never by which chat is newest. One is created only when the lookup finds none, and the creation looks again
// first, so a second one is never started. `profiles.list` reports each profile's Bot Chat as `canonical_session`,
// found by title on the server, and the Bots view's preview and activity read that row, so what a bot's row describes
// and what clicking it opens are the same chat.

/** The one title a Bot Chat has. Hermes's UNIQUE(title) index makes (profile, this title) a registry of one row. */
export const BOT_CHAT_TITLE = "Bot Chat";

/** How many rows the title lookup asks for. The answer has at most one; Hermes's desktop asks for the same. */
export const BOT_CHAT_LOOKUP_LIMIT = 200;

/** The JSON-RPC code for "method not found". */
const NO_SUCH_METHOD = -32601;
/** `session.title`'s code for a title another session holds (`Title 'Bot Chat' is already in use by session …`). */
const TITLE_IN_USE = 4022;

/** A bot's Bot Chat as `profiles.list` reports it. Times are Unix ms. */
export type BotChatRow = {
  /** The registry row: the stored session titled "Bot Chat". */
  id: string;
  /** Where its compression lineage is now: the session that opens. The same as `id` until Hermes compresses it. */
  resolvedId: string;
  /** Hermes's newest user or assistant message in it, cut to 80 characters. */
  preview: string;
  lastActive: number;
  messageCount: number;
};

/** One bot: a profile on the server, as `profiles.list` reports it. */
export type Bot = {
  /** The profile's name, which is its identity on the server. */
  profile: string;
  /** The name it shows (`botName`). */
  name: string;
  description: string;
  isDefault: boolean;
  hasAvatar: boolean;
  /** Its Bot Mode colour, when one is set. */
  color?: string;
  /** Hidden from Hermes's own bot list by the owner. It keeps working. */
  hidden: boolean;
  pinned: boolean;
  /** Its Bot Chat, or none yet. */
  botChat: BotChatRow | null;
  /** When it last did anything: its Bot Chat or its newest other chat. Unix ms, 0 when never. */
  lastActive: number;
};

/** This Hermes has no Bot Mode: no `profiles.list`, or one whose rows don't report a Bot Chat. */
export class BotModeUnsupportedError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const trimmedOrEmpty = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const codeOf = (e: unknown) => (isObj(e) && typeof e.code === "number" ? e.code : undefined);

/**
 * The name a bot shows, in the order Hermes's desktop uses (`labels.ts` `displayName`): its Bot Mode title, then the
 * profile's display name, then "Hermes" for the default profile, then the profile's own name with `-` and `_` as
 * spaces and each word capitalised.
 */
export function botName(row: { name: string; display_name?: unknown; is_default?: unknown; ui_meta?: unknown }): string {
  const meta = botMeta(row.ui_meta);
  const title = trimmedOrEmpty(meta?.title);
  if (title) return title;
  const display = trimmedOrEmpty(row.display_name);
  if (display) return display;
  if (row.name.trim().toLowerCase() === "default") return "Hermes";
  return row.name.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The Bot Mode block of a profile's `ui_meta`, if it is a mapping. */
function botMeta(uiMeta: unknown): Record<string, unknown> | undefined {
  const meta = isObj(uiMeta) ? uiMeta["hermes-bots"] : undefined;
  return isObj(meta) ? meta : undefined;
}

/** A `canonical_session`, or null for none or one that doesn't name its row. */
function botChatOf(v: unknown): BotChatRow | null {
  if (!isObj(v)) return null;
  const id = trimmedOrEmpty(v.id);
  if (!id) return null;
  return {
    id,
    resolvedId: trimmedOrEmpty(v.resolved_id) || id,
    preview: trimmedOrEmpty(v.preview).replace(/\s+/g, " "),
    lastActive: num(v.last_active || v.started_at) * 1000,
    messageCount: num(typeof v.live_message_count === "number" ? v.live_message_count : v.message_count),
  };
}

/**
 * The bots in a `profiles.list` answer, in Hermes's order. Throws `BotModeUnsupportedError` when its rows don't carry
 * `canonical_session` at all: that Hermes lists profiles but has no Bot Mode. A row whose key is `null` simply has no
 * Bot Chat yet.
 */
export function rosterOf(result: unknown): Bot[] {
  const named = rosterRows(result);
  if (!named) throw new BotModeUnsupportedError("Hermes answered profiles.list without a list of profiles.");
  if (named.some((r) => !("canonical_session" in r)))
    throw new BotModeUnsupportedError("This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode.");
  return named.map((r): Bot => {
    const meta = botMeta(r.ui_meta);
    const botChat = botChatOf(r.canonical_session);
    const last = isObj(r.last_session) ? num(r.last_session.last_active || r.last_session.started_at) * 1000 : 0;
    const color = trimmedOrEmpty(meta?.color);
    return {
      profile: r.name.trim(),
      name: botName(r),
      description: trimmedOrEmpty(r.description).replace(/\s+/g, " "),
      isDefault: r.is_default === true,
      hasAvatar: r.has_avatar === true,
      ...(/^#[0-9a-f]{3,8}$/i.test(color) && { color }),
      hidden: meta?.hidden === true,
      pinned: meta?.pinned === true,
      botChat,
      lastActive: Math.max(botChat?.lastActive ?? 0, last),
    };
  });
}

/** The rows of a `profiles.list` answer that name their profile, as Hermes sent them; none for an answer without a list. */
export function rosterRows(result: unknown): (Record<string, unknown> & { name: string })[] | undefined {
  const rows = isObj(result) && Array.isArray(result.profiles) ? result.profiles : undefined;
  return rows?.filter((r): r is Record<string, unknown> & { name: string } => isObj(r) && !!trimmedOrEmpty(r.name));
}

/**
 * What the app edits of a bot's identity (ADR 0187). `title`, `color`, `pinned` and `hidden` live in the Bot Mode
 * block, written together under its revision. `picture` is the profile's avatar, which Hermes stores without a
 * revision. Values are normalised so they compare plainly: `title` is "" for none (the name then falls back as
 * `botName` says), `color` is lowercase or null for Hermes's own, `picture` is a data URL or null.
 */
export type BotLook = { title: string; color: string | null; pinned: boolean; hidden: boolean; picture: string | null };

/** The look fields that live in the Bot Mode block. */
export const BOT_BLOCK_FIELDS = ["title", "color", "pinned", "hidden"] as const satisfies readonly (keyof BotLook)[];
export type BotBlockLook = Pick<BotLook, (typeof BOT_BLOCK_FIELDS)[number]>;

/** The largest picture Hermes stores (`profiles.set_asset`: 2 MB of image bytes). */
export const BOT_PICTURE_MAX_BYTES = 2_000_000;

/** A data URL's base64, without its label. */
const payloadOf = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

export const BOT_LOOK_SAME: Same<BotLook> = {
  title: (a, b) => a.trim() === b.trim(),
  color: (a, b) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase(),
  pinned: (a, b) => a === b,
  hidden: (a, b) => a === b,
  // By its bytes: Hermes sniffs the format on the way in and labels the data URL it answers with what it found, so
  // a picture sent under another label would never read back equal by its label.
  picture: (a, b) => (a === null || b === null ? a === b : payloadOf(a) === payloadOf(b)),
};

/** The block fields of a bot's look, as one `profiles.list` row has them. Any colour is kept, unlike `rosterOf`, which shows only a hex one. */
export function lookOf(row: Record<string, unknown>): BotBlockLook {
  const meta = botMeta(row.ui_meta);
  return { title: trimmedOrEmpty(meta?.title), color: trimmedOrEmpty(meta?.color).toLowerCase() || null, pinned: meta?.pinned === true, hidden: meta?.hidden === true };
}

/**
 * The Bot Mode block as Hermes holds it, every key kept. Opaque: `blockOf` is its one maker and `blockFor` the one
 * reader of its keys, so the block travels from a read to a write without anything else editing it.
 */
export type BotBlock = Readonly<Record<string, unknown>> & { readonly __brand: "BotBlock" };

/** The block's compare-and-swap revision, as one `profiles.list` row reported it. Only `blockOf` makes one. */
export type Revision = number & { readonly __brand: "Revision" };

/**
 * A row's Bot Mode block and its revision. A block never written is at revision 0. `revision` is undefined when the
 * row reports no revisions at all: that Hermes can't check a write against another client's, so nothing is written.
 */
export function blockOf(row: Record<string, unknown>): { block: BotBlock; revision: Revision | undefined } {
  const revisions = row.ui_meta_revisions;
  const at = isObj(revisions) ? revisions["hermes-bots"] : undefined;
  return {
    block: (botMeta(row.ui_meta) ?? {}) as BotBlock,
    revision: !isObj(revisions) ? undefined : ((typeof at === "number" && Number.isInteger(at) && at >= 0 ? at : 0) as Revision),
  };
}

/** Whether the block lacks what Hermes's desktop needs to show the picture the profile now has (`blockFor`). */
export const lacksPictureKeys = (block: BotBlock, picture: { cleared: boolean }) => block.custom !== true || block.imageKind !== (picture.cleared ? "shape" : "photo");

/**
 * The block to send: Hermes's block as just read, with only the written fields replaced, and the keys Hermes's
 * desktop sets beside them (`edit-profile-look.ts`): a colour or picture change sets `custom: true`, and a picture
 * sets `imageKind` to "photo", or "shape" when cleared. `picture`: the profile's avatar is now the owner's, whether
 * this save stored it or an earlier one did. A title is written trimmed, "" included, and a null colour removes the
 * key. Every other key is sent back exactly as read.
 */
export function blockFor(server: BotBlock, write: Partial<BotBlockLook>, picture?: { cleared: boolean }): Record<string, unknown> {
  const block: Record<string, unknown> = { ...server };
  if (write.title !== undefined) block.title = write.title.trim();
  if (write.color !== undefined) {
    if (write.color === null) delete block.color;
    else block.color = write.color;
    block.custom = true;
  }
  if (write.pinned !== undefined) block.pinned = write.pinned;
  if (write.hidden !== undefined) block.hidden = write.hidden;
  if (picture) {
    block.custom = true;
    block.imageKind = picture.cleared ? "shape" : "photo";
  }
  return block;
}

/**
 * The only builder of `profiles.configure` params. Its revision is required and branded, so a write without an
 * expected revision can't be typed. It sends the Bot Mode key alone, and no param Hermes's contract lacks: `f0d94882`
 * refuses the whole request for one.
 */
export function configureParams(profile: string, block: Record<string, unknown>, revision: Revision): Record<string, unknown> {
  return { name: profile, ui_meta: { "hermes-bots": block }, ui_meta_expected_revisions: { "hermes-bots": revision } };
}

/** Whether a listed or found chat is a Bot Chat, which the chat list and search leave out (ADR 0066). */
export const isBotChatTitle = (title: unknown) => typeof title === "string" && title.trim() === BOT_CHAT_TITLE;

/**
 * Whether a chat this app holds is a Bot Chat: one opened from its bot's row, or any chat with the title, which in
 * Hermes is the profile's Bot Chat whoever named it. Every Bot Chat rule reads this, so a chat renamed to the title
 * elsewhere is treated as one too.
 */
export const isBotChat = (c: { bot?: boolean; title: string }) => !!c.bot || isBotChatTitle(c.title);

/**
 * Whether the chat on screen, by its stored id, is this bot's Bot Chat: its registry row or the lineage's tip, which
 * is what opens once Hermes has compressed it. The `/new` guard reads this (Hermes's `isCanonicalChatOnScreen`).
 */
export function isBotChatOnScreen(bot: Pick<Bot, "botChat"> | undefined, chatId: string | undefined): boolean {
  const row = bot?.botChat;
  return !!row && !!chatId && (chatId === row.id || chatId === row.resolvedId);
}

/** A Bot Chat this app found or created. `openId`: the stored session to open (the lineage tip). */
export type BotChatOpen = { registryId: string; openId: string; created: boolean };

/** One JSON-RPC request on the connection, as the transport sends it. */
export type BotRpc = (method: AppMethod, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Finds and creates Bot Chats over JSON-RPC. `source`: the `source` this app stamps on sessions it starts. No session
 * id is ever kept here: each open looks the chat up by title again.
 */
export class BotChats {
  /** Creations under way, by profile, so a second click while one runs joins it rather than starting another. */
  private flights = new Map<string, Promise<BotChatOpen>>();

  constructor(
    private readonly rpc: BotRpc,
    private readonly source: string,
  ) {}

  /**
   * The profile's Bot Chat, looked up by title, or null when it has none. Fails closed: a lookup that fails throws,
   * and so does one that finds nothing while `expected` (the roster's last report named a Bot Chat), since an answer
   * from a profile mid-restart can come back empty. Either way nothing is created.
   */
  async find(profile: string, name: string, expected: boolean): Promise<{ id: string; resolvedId: string } | null> {
    let res: unknown;
    try {
      res = await this.rpc("session.list", { profile, title: BOT_CHAT_TITLE, include_hidden: true, limit: BOT_CHAT_LOOKUP_LIMIT });
    } catch (e) {
      if (codeOf(e) === NO_SUCH_METHOD) throw new BotModeUnsupportedError("This Hermes can't look a chat up by its title, so it has no Bot Mode.");
      throw new Error(`Couldn't look up ${name}'s Bot Chat, so no new one was started: ${errorText(e)}`);
    }
    // Only an answer that is plainly a title lookup can say there is no Bot Chat: a list of rows, every one of them
    // titled "Bot Chat" with an id. Anything else, such as a Hermes that ignored `title` and listed its newest chats,
    // proves nothing, so nothing is created.
    const rows = isObj(res) && Array.isArray(res.sessions) ? (res.sessions as unknown[]) : undefined;
    if (!rows || rows.some((r) => !isObj(r) || !trimmedOrEmpty(r.id) || !isBotChatTitle(r.title)))
      throw new Error(`Hermes answered the lookup of ${name}'s Bot Chat in a way this app doesn't read, so no new one was started.`);
    const row = rows[0];
    if (isObj(row)) return { id: trimmedOrEmpty(row.id), resolvedId: trimmedOrEmpty(row.resolved_id) || trimmedOrEmpty(row.id) };
    if (expected) throw new Error(`Hermes didn't confirm ${name}'s Bot Chat this time, so no new one was started. Try again.`);
    return null;
  }

  /**
   * Opens the profile's Bot Chat: the one the title lookup finds, or, only when there is none, a new one. `expected`:
   * the roster's last report named one (`find`). The new chat is hidden from chat lists, follows the profile's current
   * model, and is titled at once, which stores it; when another client took the title meanwhile, its chat is opened
   * instead. No message is sent: the owner speaks first.
   */
  open(profile: string, name: string, expected: boolean): Promise<BotChatOpen> {
    const flight = this.flights.get(profile);
    if (flight) return flight;
    const run = this.resolve(profile, name, expected).finally(() => {
      if (this.flights.get(profile) === run) this.flights.delete(profile);
    });
    this.flights.set(profile, run);
    return run;
  }

  private async resolve(profile: string, name: string, expected: boolean): Promise<BotChatOpen> {
    const found = await this.find(profile, name, expected);
    if (found) return { registryId: found.id, openId: found.resolvedId, created: false };
    const made = await this.rpc("session.create", { profile, title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: this.source });
    const runtime = isObj(made) ? trimmedOrEmpty(made.session_id) : "";
    const stored = isObj(made) ? trimmedOrEmpty(made.stored_session_id) : "";
    if (!runtime || !stored) throw new Error(`Hermes didn't say which session it started for ${name}'s Bot Chat.`);
    try {
      // A new session has no row until its first message, and the title alone stays pending. Naming it now stores it
      // under the title, so the next lookup finds it and Hermes's own titling can't rename it.
      await this.rpc("session.title", { session_id: runtime, title: BOT_CHAT_TITLE });
    } catch (e) {
      if (codeOf(e) !== TITLE_IN_USE && !/already in use/i.test(errorText(e))) throw new Error(`Hermes started ${name}'s Bot Chat but didn't name it: ${errorText(e)}`);
      // Another client made it between the lookup and now. Open theirs; the session started here holds nothing, and
      // Hermes prunes it.
      const winner = await this.find(profile, name, true);
      return { registryId: winner!.id, openId: winner!.resolvedId, created: false };
    }
    return { registryId: stored, openId: stored, created: true };
  }
}

/** What a bot is doing in its Bot Chat: replying, or waiting on the owner (an Approval). None when idle. */
export type BotActivity = "replying" | "needs-you" | undefined;

/**
 * A bot's activity, from its Bot Chat only, the chat its row opens (Hermes's `bot-row.tsx`: "Status keys off the
 * canonical Bot Chat"). `live`: the sessions `session.active_list` last reported as working or waiting. `here`: the Bot
 * Chat as this connection holds it, when open here, which is fresher than the last check. `roster`: every bot, for a live
 * session whose profile isn't known: a copied profile keeps the stored ids, so such a session counts only when no
 * other bot's Bot Chat has its id.
 */
export function botActivity(
  bot: Pick<Bot, "botChat" | "profile">,
  live: readonly { chatId: string; status: "working" | "waiting"; profile?: string }[],
  here?: { running?: boolean; waiting?: boolean },
  roster: readonly Pick<Bot, "botChat" | "profile">[] = [],
): BotActivity {
  if (here?.waiting) return "needs-you";
  const row = bot.botChat;
  const ids = (b: Pick<Bot, "botChat">) => (b.botChat ? [b.botChat.id, b.botChat.resolvedId] : []);
  const shared = (id: string) => roster.some((b) => b.profile !== bot.profile && ids(b).includes(id));
  const mine = row
    ? live.filter((s) => (s.chatId === row.id || s.chatId === row.resolvedId) && (s.profile ? s.profile === bot.profile : !shared(s.chatId)))
    : [];
  if (mine.some((s) => s.status === "waiting")) return "needs-you";
  if (here?.running || (here === undefined && mine.some((s) => s.status === "working"))) return "replying";
  return undefined;
}

/**
 * What `/new` typed in a Bot Chat says. A Bot Chat is one continuous conversation, so, as in Hermes's desktop, it is
 * compacted instead of a new chat being started: the model reads a fresh, shorter context, and the chat stays the same.
 */
export function newInBotChatNote(res: { kind: string; message?: string }): string {
  const lead = "A Bot Chat is one continuous conversation, so /new compacts it instead of starting a new chat.";
  if (res.kind === "compacted") return `${lead} Hermes compacted it.`;
  if (res.kind === "nothing") return `${lead} There was nothing to compact yet.`;
  return `${lead} ${res.message ?? ""}`.trim();
}
