// What each kind of chat can do here. Every rule that differs by kind is a column of `CHAT_POLICY`, so a new kind
// answers all of them at once and no screen asks about a chat's source or bot flag itself.
import { isBotChat } from "./bots";
import type { Chat } from "./model";

/**
 * `imported`: an Imported transcript (ADR 0031). `bot`: a bot's Bot Chat (ADR 0066). `jobRun`: the session Hermes ran
 * a Scheduled job in, which Hermes takes no reply in.
 */
export type ChatKind = "ordinary" | "imported" | "bot" | "jobRun";

export type ChatPolicy = {
  /** In the chat list, the unread counts, the list saved on this computer, and reopened at launch. */
  listed: boolean;
  /** Its replies, failures, unread dot and live session can make Inbox entries. */
  inbox: boolean;
  /**
   * `live`: opened as a session on this connection, marked read, kept as a Saved copy, and sent to. `stored`: its
   * stored rows are read each time it opens; nothing is sent, marked or kept.
   */
  session: "live" | "stored";
  /** Which note stands in for the composer; none means the composer. */
  readOnly?: "imported" | "jobRun";
  /** Edit and Regenerate. */
  replay: boolean;
  branch: boolean;
  /** Pin, Settle, Archive, Delete and Rename. */
  manage: boolean;
  /** A chat link opens it by its id. A Bot Chat is found by its title each time, so it has none. */
  link: boolean;
};

export const CHAT_POLICY: Record<ChatKind, ChatPolicy> = {
  ordinary: { listed: true, inbox: true, session: "live", replay: true, branch: true, manage: true, link: true },
  imported: { listed: true, inbox: true, session: "live", readOnly: "imported", replay: false, branch: true, manage: true, link: true },
  bot: { listed: false, inbox: true, session: "live", replay: true, branch: true, manage: false, link: false },
  jobRun: { listed: false, inbox: false, session: "stored", readOnly: "jobRun", replay: false, branch: false, manage: false, link: true },
};

type Kinded = Pick<Chat, "source" | "bot" | "title">;

export const chatKind = (c: Kinded): ChatKind => (isBotChat(c) ? "bot" : c.source === "cron" ? "jobRun" : c.source === "import" ? "imported" : "ordinary");

export const policyOf = (c: Kinded): ChatPolicy => CHAT_POLICY[chatKind(c)];
