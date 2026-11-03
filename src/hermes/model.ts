// What the UI renders. Terms follow GLOSSARY.md: a Chat is Active or Settled, may be Archived, and has one Source.
import type { ModelPick } from "./models";
import type { ChatUsage, ReplyUsage } from "./usage";

export type Source = "app" | "telegram" | "discord" | "cli" | "desktop" | "other";

export const SOURCE_LABEL: Record<Source, string> = {
  app: "Hermes Chat",
  telegram: "Telegram",
  discord: "Discord",
  cli: "the command line",
  desktop: "the Hermes desktop app",
  other: "another Hermes platform",
};

/** A local file the owner is sending with a message: an image Hermes looks at, or any other file. */
export type Attachment = { path: string; name: string; size: number; kind: "image" | "file" };

/** Local files checked for attaching: the ones Hermes takes, and why each of the others can't go. */
export type AttachCheck = { attachments: Attachment[]; refused: string[] };

/**
 * `at` on a message or reply: when Hermes stored it (Unix ms), read from its stored row. It is left out until that row
 * is known, never filled in with when this app saw the message.
 */
/**
 * A message sent from this app that Hermes hasn't confirmed. `sending`: on its way. `failed`: Hermes didn't take it,
 * or reading back its history showed it never arrived. `unknown`: it went out and the connection dropped, or the app
 * closed, before Hermes answered, so Hermes may have it; the next read of the chat's history settles it. `reason`:
 * why, for `failed` and `unknown`. `attachments`: the files sent with it, so Retry sends them again. `sent`: set as it
 * goes out, to find it in the history: the prompt as sent, and the newest stored row the chat had then (`after`).
 */
export type Outgoing = {
  state: "sending" | "failed" | "unknown";
  reason?: string;
  attachments?: Attachment[];
  sent?: { prompt: string; after?: number };
};

export type Item =
  /** `attachments`: names sent with the message. `outgoing`: sent from here and not confirmed yet. */
  | { kind: "user"; id: string; text: string; attachments?: string[]; at?: number; outgoing?: Outgoing }
  /**
   * `interrupted`: the owner, or another Hermes client, stopped this reply before it finished. `rowId`: its stored row,
   * once known. `usage`: the tokens its turn took, only for a reply this app watched finish (`usage.ts`).
   */
  | { kind: "assistant"; id: string; text: string; interrupted?: boolean; at?: number; rowId?: number; usage?: ReplyUsage }
  /** The model's reasoning before a reply or a tool call, as Hermes streams or stores it. */
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      /** The tool call's id (`tool_call_id`), the same live and in stored history; Outputs go to the call by it. */
      callId?: string;
      name: string;
      args?: Record<string, unknown>;
      preview?: string;
      /** `stopped`: the reply was interrupted while the tool call was running. */
      status: "running" | "done" | "stopped";
      durationS?: number;
      result?: string;
      summary?: string;
    }
  /**
   * An Approval: Hermes asks before running a command it counts as dangerous. `answer`: the owner's, from this app.
   * `ended`: why Hermes stopped waiting without one: its own reason (`timeout`, `interrupted`, `resolved` when
   * another Hermes client answered), `turn ended`, or `lost` when Hermes let go of the session while the connection
   * was down, or the chat couldn't be loaded again. `choices`: the answers Hermes offers, in its order.
   * `allowSession` / `allowPermanent`: false when Hermes rules out allowing the command for the chat, or always.
   */
  | {
      kind: "approval";
      id: string;
      requestId: string;
      command: string;
      description: string;
      choices: ApprovalChoice[];
      allowSession: boolean;
      allowPermanent: boolean;
      answer?: ApprovalChoice;
      ended?: string;
    }
  /** `usage`: the tokens a failed turn took before it failed, as for a reply. */
  | { kind: "error"; id: string; text: string; usage?: ReplyUsage };

/** How the owner answers an Approval: run it this once, for the rest of the chat, always, or not at all. */
export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export type ApprovalItem = Extract<Item, { kind: "approval" }>;

/** A message sent from here that Hermes hasn't confirmed (`Outgoing`). */
export type OutgoingItem = Extract<Item, { kind: "user" }> & { outgoing: Outgoing };

export const isOutgoing = (i: Item): i is OutgoingItem => i.kind === "user" && i.outgoing !== undefined;

/** The answers the owner can give an Approval: the ones Hermes offers, less the broader grants it rules out. */
export const offeredChoices = (i: ApprovalItem): ApprovalChoice[] =>
  i.choices.filter((c) => (c !== "session" || i.allowSession) && (c !== "always" || i.allowPermanent));

/** Answers that allow the command beyond this once, so the owner confirms them first. */
export const isBroadGrant = (c: ApprovalChoice) => c === "session" || c === "always";

/** An Approval Hermes is still waiting on. */
export const isWaiting = (i: Item): i is ApprovalItem => i.kind === "approval" && !i.answer && !i.ended;

export type Chat = {
  /** The stored Hermes session id, as dashboard REST lists it. */
  id: string;
  /** The legacy WS runtime session id, once this app has started or resumed the chat on this connection. */
  runtimeId?: string;
  title: string;
  source: Source;
  settled: boolean;
  /** Whether it is Active or Settled is kept on this computer, because Hermes won't store it for this chat (ADR 0002). */
  settledHere?: boolean;
  /** Archived in Hermes: hidden in every Hermes client, its history kept. Active or Settled stays as it was. */
  archived?: boolean;
  updatedAt: number;
  /** Something happened in it since the owner last opened it here or in another Hermes client (ADR 0002). */
  unread?: boolean;
  items: Item[];
  /** Its stored history is on the way (`Hermes.open`). */
  loading?: boolean;
  /**
   * The transcript on screen is the Saved copy this computer took at this time, not yet loaded from Hermes on this
   * connection: Hermes can't be reached, or the history is still on the way.
   */
  savedAt?: number;
  running?: boolean;
  /** Stop was asked for; the reply keeps running until Hermes ends the turn (`Hermes.stop`). */
  stopping?: boolean;
  /**
   * The model the chat runs on: as Hermes last reported it for the chat, or as the owner last picked for it here.
   * Unknown until the chat is started or resumed on this connection, or for a server that doesn't say.
   */
  model?: ModelPick;
  /** What Hermes reports about the chat's session on this connection; gone when the connection drops. */
  live?: SessionLive;
  /**
   * Its tokens and cost over its whole life, as Hermes last recorded them (`usage.ts`). Unknown until read from Hermes on
   * this connection. `usageError`: why the latest read failed; `usage` is then the earlier read, if any.
   */
  usage?: ChatUsage;
  usageError?: string;
};

/**
 * A chat's live session as Hermes reports it (`session.info`, `session.usage`, research doc "Status bar"); its model is
 * `Chat.model`.
 * `context`: how full the context window is, only once Hermes has measured it. `yolo`: Hermes runs commands it counts
 * as dangerous without asking; undefined when Hermes doesn't report it. `yoloEverywhere`: on for every chat by Hermes's
 * own settings, so this chat can't turn it off.
 */
export type SessionLive = { context?: ContextUse; yolo?: boolean; yoloEverywhere?: boolean };

/** `used` of `max` tokens, `percent` full. `estimated`: Hermes counted part of it itself, not the provider. */
export type ContextUse = { used: number; max: number; percent: number; estimated: boolean };

/** One part of what fills the context window, as Hermes estimates it (`session.context_breakdown`). */
export type ContextPart = { id: string; label: string; tokens: number; color?: string };

export type ConnectionStatus = "connected" | "reconnecting" | "offline";

/**
 * Unread chats in a profile the app isn't showing, as its latest check found them (`Hermes.checkOtherProfiles`).
 * `unread`: how many chats in the profile's list are Unread. `more`: the check read only the profile's most recent
 * chats and the list holds more, so more of them may be Unread. `checkedAt`: when that was read. `error`: why the
 * latest check failed; the other fields then come from an earlier check, if there was one.
 */
export type OtherProfile = { unread?: number; more?: boolean; checkedAt?: number; error?: string };

/** The profiles the app isn't showing, by name. `error`: why the latest check couldn't list the profiles. */
export type OtherProfiles = { byName: Record<string, OtherProfile>; checkedAt?: number; error?: string };

/**
 * A chat found by searching all chats (`Hermes.search`). `snippet`: the text around the match, with the matched words
 * marked. `find`: what find-in-chat looks for when the chat opens; there is none when only the title matched.
 */
export type Found = Pick<Chat, "title" | "source" | "settled" | "archived" | "updatedAt"> & {
  chatId: string;
  snippet: { text: string; hit?: boolean }[];
  find?: string;
  /** The kind of message that matched. */
  role?: "user" | "assistant";
};
