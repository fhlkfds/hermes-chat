// What the UI renders. Terms follow GLOSSARY.md: a Chat is Active or Settled and has one Source.

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
export type Item =
  /** `attachments`: the names of the files sent with the message. */
  | { kind: "user"; id: string; text: string; attachments?: string[]; at?: number }
  /** `interrupted`: the owner, or another Hermes client, stopped this reply before it finished. */
  | { kind: "assistant"; id: string; text: string; interrupted?: boolean; at?: number }
  /** The model's reasoning before a reply or a tool call, as Hermes streams or stores it. */
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
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
   * was down, or the chat couldn't be loaded again.
   */
  | { kind: "approval"; id: string; requestId: string; command: string; description: string; answer?: ApprovalChoice; ended?: string }
  | { kind: "error"; id: string; text: string };

/** How the owner answers an Approval: run it this once, for the rest of the chat, always, or not at all. */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type ApprovalItem = Extract<Item, { kind: "approval" }>;

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
};

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
export type Found = Pick<Chat, "title" | "source" | "settled" | "updatedAt"> & {
  chatId: string;
  snippet: { text: string; hit?: boolean }[];
  find?: string;
  /** The kind of message that matched. */
  role?: "user" | "assistant";
};
