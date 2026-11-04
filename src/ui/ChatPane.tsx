// Transcript, thinking, tool-call groups, Approval cards, find bar, composer and the Settle button, ported from the prototype.
// Dictation and Read aloud come from Voice.tsx.
import { createContext, memo, type ReactNode, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Brain, Camera, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CloudOff, FileDown, FileInput, FileText, Globe, HardDrive, Link2, ListPlus, Paperclip, RotateCcw, Search, Server, Square, Wrench, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ApprovalChoice, AttachCheck, Attachment, Chat, ChatQueue, ConnectionStatus, Item, OutgoingItem, Source } from "../hermes/model";
import { SOURCE_LABEL, isOutgoing, isWaiting } from "../hermes/model";
import type { DeskState, ScreenshotDesk } from "../hermes/screenshots";
import { ApprovalCard } from "./ApprovalCard";
import { QueuePanel, type QueueApi } from "./Queue";
import { Markdown } from "./Markdown";
import { ArchiveButton, SettleButton, SourceIcon, Spinner, StoredTime, composing, highlight } from "./bits";
import { AttachmentChip, Previews, readPreview } from "./previews";
import { Speaker } from "./speaker";
import { DictationNoteView, DictationStrip, ListenButton, MicButton, type VoiceApi, listenBlocked, micBlocked, useDictation, useVoiceSetup } from "./Voice";
import { withTranscript } from "../hermes/voice";
import type { VoiceSetup } from "../hermes/pipe";
import { ChatUsageButton, ReplyUsageLine } from "./Usage";
import { useOpenPreview } from "./previewContext";
import { ShowInChatContext, type ShowInChat } from "./showInChat";
import { previewName, toolTargets, withoutBidi } from "../hermes/preview";
import { type CommandHost, useSlashCommands } from "./SlashCommands";
import { Templates, type TemplateHere } from "./Templates";
import { BranchButton } from "./Branch";

type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;
type Block = { kind: "tools"; id: string; tools: ToolItem[] } | Exclude<Item, ToolItem>;

// Consecutive tool calls collapse into one group so a long run doesn't dominate the transcript.
function toBlocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(it);
      else out.push({ kind: "tools", id: `g-${it.id}`, tools: [it] });
    } else out.push(it);
  }
  return out;
}

// A group is rebuilt on every render, so it counts as unchanged when it holds the same tool calls.
const sameBlock = (a: Block, b: Block) =>
  a === b || (a.kind === "tools" && b.kind === "tools" && a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]));

/**
 * Where the find bar opens when a chat is opened from a search: on `query`, at the first match in the message
 * `itemId`, or at the first match anywhere when the matched message isn't known. `at` tells one pick from the next.
 */
export type FindTarget = { query: string; itemId?: string; at: number };

/**
 * What to go to: a tool call, opened, by its call id (`Item.callId`), or a message by its stored row (`rowId`), as a
 * branch's link back does. `at` tells one request from the next.
 */
export type JumpTarget = { callId: string; rowId?: undefined; at: number } | { rowId: number; callId?: undefined; at: number };
/** The tool call being gone to, for the tool rows and groups that hold it to open themselves. */
const JumpContext = createContext<JumpTarget | undefined>(undefined);

const STATUS_NOTE: Record<ConnectionStatus, string | undefined> = {
  connected: undefined,
  reconnecting: "Reconnecting to Hermes…",
  offline: "Offline. Click the status dot to reconnect.",
};

const NOT_CAPTURING: DeskState = { capturing: false };
const noDesk = () => () => {};
/**
 * The name a pasted file is saved under: its own, or for a screenshot (no name, or the webview's generic `image.png`)
 * a local timestamp like `clipboard-2026-11-02T153000.png`, its extension from the MIME type.
 */
export function pastedName(f: { name: string; type: string }, now = new Date()): string {
  if (f.name && !/^image\.\w+$/.test(f.name)) return f.name;
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replaceAll(":", "");
  return `clipboard-${local}.${/^\w+\/(\w+)$/.exec(f.type)?.[1] ?? "png"}`;
}

/**
 * The images on the clipboard, as files. WebKitGTK leaves a paste event's `files` empty even for a screenshot, but the
 * async clipboard API, asked during the paste, has it. Empty when there are none or the clipboard can't be read.
 */
async function clipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    return await Promise.all(
      items.flatMap((item) => {
        const type = item.types.find((t) => t.startsWith("image/"));
        return type ? [item.getType(type).then((b) => new File([b], "", { type }))] : [];
      }),
    );
  } catch {
    return [];
  }
}

/** When a Saved copy was taken, as the note above it says it. */
const savedWhen = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * `alsoPostsIn`: the Telegram or Discord chat Hermes will also post its replies in. `draft`: the composer's text, kept
 * outside the pane so it survives switching chats. `onAnswer` answers an Approval card. `onSettle`, `onArchive`,
 * `onExport` and `onCopyLink` are left out for a chat not started yet. `notLoaded`: the chat has no Saved copy and can't load until
 * Hermes is connected. `onRetry`, `onEdit` and `onDismiss` act on failed or unconfirmed messages. `modelControls`
 * contains the model picker; `footer` contains the status bar. Only the active pane answers Ctrl+F and takes focus as
 * it opens. Native drops attach to the pane under the pointer. `paneControls` follows the chat's own buttons.
 * `screenshots` attaches captures; `screenshotKeys` names the shortcut.
 * `voice` supplies Dictation and Read aloud. `commands` runs the slash commands typed in the composer. `queue` is the
 * chat's queue of messages waiting to go after its reply, and `queueApi` changes it; it is left out for a chat not
 * started yet, which can't queue. `branch` offers Branch from here under each message with text (ADR 0027): `blocked`
 * says why none can be made now. `branchedFrom` is shown at the top of a branch, where it came from.
 */
export function ChatPane({
  chat,
  notLoaded,
  findTarget,
  jumpTo,
  onJumpMissed,
  status,
  alsoPostsIn,
  draft,
  onDraft,
  onRetry,
  onEdit,
  onDismiss,
  onAttach,
  onSend,
  onStop,
  onAnswer,
  onSettle,
  onArchive,
  onExport,
  onCopyLink,
  modelControls,
  active = true,
  visible = true,
  split = false,
  paneControls,
  voice,
  screenshots,
  screenshotKeys,
  projects,
  notice,
  banner,
  footer,
  onUsage,
  headActions,
  queue,
  queueApi,
  commands,
  templates,
  branch,
  branchedFrom,
}: {
  chat: Chat;
  notLoaded?: boolean;
  findTarget?: FindTarget;
  /** Scroll to this tool call and open it, once the history holding it has loaded (Outputs, "Go to the message"). */
  jumpTo?: JumpTarget;
  /** The history loaded without the tool call `jumpTo` names. */
  onJumpMissed?: () => void;
  status: ConnectionStatus;
  alsoPostsIn?: Source;
  draft: string;
  onDraft: (text: string) => void;
  onRetry: (itemId: string) => void;
  onEdit: (itemId: string) => void;
  onDismiss: (itemId: string) => void;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
  onSettle?: (settled: boolean) => void;
  onArchive?: (archived: boolean) => void;
  onExport?: () => void;
  /** Copies the chat's link (chatLinks.ts). */
  onCopyLink?: () => void;
  modelControls?: ReactNode;
  active?: boolean;
  visible?: boolean;
  split?: boolean;
  paneControls?: ReactNode;
  voice?: VoiceApi;
  screenshots?: ScreenshotDesk;
  screenshotKeys?: string;
  /** The names of the projects the chat is in, or a new chat will be put in. */
  projects?: string[];
  /** Shown at the top of the transcript: what a new chat starts with. */
  notice?: ReactNode;
  /** Shown under the header, outside the transcript's scroll: a question about this chat. */
  banner?: ReactNode;
  footer?: ReactNode;
  onUsage?: () => void;
  headActions?: ReactNode;
  queue?: ChatQueue;
  queueApi?: QueueApi;
  commands?: CommandHost;
  /** Where the composer's Templates are picked from (Templates.tsx). */
  templates?: TemplateHere;
  branch?: { blocked?: string; onBranch: (itemId: string) => void };
  branchedFrom?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const voiceSetup = useVoiceSetup(voice, status === "connected");
  // One reply reads aloud at a time; closing the chat stops it and lets go of its audio.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [speaker, setSpeaker] = useState<Speaker>();
  useEffect(() => {
    if (!voice) return;
    const s = new Speaker((text) => voiceRef.current!.speak(text));
    setSpeaker(s);
    return () => s.dispose();
  }, [!voice]);
  const listen = speaker && { speaker, blocked: listenBlocked(status, voiceSetup) };
  useEffect(() => { if (!active) speaker?.stop(); }, [active, speaker]);
  // The blocks are memoized, so they get one answer handler for the life of the pane.
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const answer = useCallback(
    (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => onAnswerRef.current(approvalId, choice, confirmed),
    [],
  );
  // So do failed messages, one handler for all three actions.
  const outgoingRef = useRef({ retry: onRetry, edit: onEdit, dismiss: onDismiss });
  outgoingRef.current = { retry: onRetry, edit: onEdit, dismiss: onDismiss };
  const onOutgoing = useCallback((itemId: string, action: OutgoingAction) => outgoingRef.current[action](itemId), []);
  // And Branch from here, one handler for every message.
  const branchRef = useRef(branch?.onBranch);
  branchRef.current = branch?.onBranch;
  const onBranch = useCallback((itemId: string) => branchRef.current?.(itemId), []);
  // A failed message can be sent again once Hermes is connected and the chat has no reply running.
  const canRetry = status === "connected" && !chat.loading && !chat.running;
  const findRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  // For the status bar's context inspector: a stored time to the message there, marked as a jump to a tool call is.
  const showInChat = useCallback<ShowInChat>((at) => {
    const msgs = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>(".msg[data-item]") ?? []);
    const el = at === undefined ? msgs[0] : msgs.find((m) => m.dataset.at !== undefined && Number(m.dataset.at) >= at);
    if (!el) return false;
    stickToBottom.current = false;
    el.scrollIntoView?.({ block: "start" });
    el.classList.add("jumped");
    setTimeout(() => el.classList.remove("jumped"), 2500);
    return true;
  }, []);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Which match is the current one, counting from the top of the chat.
  const [matchIndex, setMatchIndex] = useState(0);
  const [count, setCount] = useState(0);
  // A search pick waiting for the chat's history, so the find bar can land on the matched message.
  const [landing, setLanding] = useState(false);
  // The current match should be scrolled to after the next render.
  const scrollToMatch = useRef(false);

  useEffect(() => {
    if (!findTarget) return;
    setFindOpen(true);
    setQuery(findTarget.query);
    setLanding(true);
    stickToBottom.current = false;
  }, [findTarget?.at]);

  const openFind = () => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !composing(e) && activeRef.current) {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The transcript catches up with the find bar in the background, so re-marking a long chat doesn't hold up typing.
  const typed = findOpen ? query : "";
  const q = useDeferredValue(typed);

  // After every render, count the marks and point at the current one. Marks still for an earlier query don't count.
  useLayoutEffect(() => {
    if (q !== typed) return;
    const marks = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("mark.hit") ?? []);
    setCount(marks.length);
    let idx = Math.min(matchIndex, marks.length - 1);
    // Land once the history is in: it has marks, or it has loaded without any (the match was in a tool call, say).
    if (landing && !chat.loading && (marks.length || chat.runtimeId)) {
      setLanding(false);
      const itemId = findTarget?.itemId;
      idx = Math.max(0, itemId ? marks.findIndex((m) => m.closest(`[data-item="${CSS.escape(itemId)}"]`)) : 0);
      setMatchIndex(idx);
      scrollToMatch.current = true;
    }
    marks.forEach((m, i) => m.classList.toggle("current", i === idx));
    if (scrollToMatch.current && marks[idx]) {
      scrollToMatch.current = false;
      marks[idx].scrollIntoView({ block: "center" });
    }
  });

  // Going to a tool call: once its row is on screen, scroll it to the middle, mark it and move focus to it. A history
  // that loaded without it says so; one still loading, or a Saved copy while offline without it, waits.
  const [jumping, setJumping] = useState<JumpTarget>();
  useEffect(() => {
    if (!jumpTo) return;
    stickToBottom.current = false;
    setJumping(jumpTo);
  }, [jumpTo?.at]);
  useLayoutEffect(() => {
    if (!jumping) return;
    let el: HTMLElement | null | undefined;
    if (jumping.rowId !== undefined) {
      const rowId = jumping.rowId;
      const item = chat.items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.rowId === rowId);
      el = item && scrollRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.id)}"]`);
    } else {
      const id = CSS.escape(jumping.callId);
      el = scrollRef.current?.querySelector<HTMLElement>(`[data-call="${id}"]`) ?? scrollRef.current?.querySelector<HTMLElement>(`[data-calls~="${id}"]`);
    }
    if (el) {
      setJumping(undefined);
      el.scrollIntoView?.({ block: "center" });
      el.classList.add("jumped");
      el.focus({ preventScroll: true });
      setTimeout(() => el.classList.remove("jumped"), 2500);
    } else if (!chat.loading && chat.runtimeId) {
      setJumping(undefined);
      onJumpMissed?.();
    }
  });

  // Follow the stream while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && !q) el.scrollTop = el.scrollHeight;
  });

  // Resizing the pane rewraps the transcript without a render; one at the bottom stays there.
  const qRef = useRef(q);
  qRef.current = q;
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current && !qRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const step = (d: number) => {
    if (!count) return;
    setMatchIndex((i) => (Math.min(i, count - 1) + d + count) % count);
    scrollToMatch.current = true;
    stickToBottom.current = false;
  };
  const closeFind = () => {
    setFindOpen(false);
    setLanding(false);
  };

  // Rebuilt only when the chat changes, so a reply streaming in the other pane costs this one little.
  const blocks = useMemo(() => toBlocks(chat.items), [chat.items]);
  // Cards ignore clicks for a moment after the transcript changes, since it may have moved them under the pointer.
  const movedAt = useMemo(() => performance.now(), [chat.items]);
  const last = chat.items[chat.items.length - 1];
  const waiting = chat.items.some(isWaiting);
  // Enter queues while a reply runs, while Hermes isn't connected, and while messages are queued already, so a new one
  // never jumps the queue. The composer's hint says which Enter does.
  const queueing = !!queueApi && (!!chat.running || status !== "connected" || !!queue?.items.length);

  return (
    <div className="chat" ref={rootRef}>
      <header className="chat-head">
        <div className="chat-title">
          {chat.source !== "app" && <SourceIcon source={chat.source} size={13} />}
          <span>{chat.title}</span>
          {chat.settled && <span className="badge">Settled</span>}
          {chat.settled && onSettle && !chat.archived && (
            <SettleButton settled size={12} className="unsettle-btn" labeled onSettle={onSettle} />
          )}
          {chat.archived && <span className="badge">Archived</span>}
          {projects?.map((name) => (
            <span key={name} className="badge project-badge" title={`In the project ${name}`}>
              {name}
            </span>
          ))}
        </div>
        <div className="chat-head-end">
          {/* Outside the actions, whose dimming would show through its breakdown. */}
          {onUsage && <ChatUsageButton chat={chat} onRefresh={onUsage} />}
          <div className="chat-head-actions">
            {headActions}
            <button
              className="icon-btn"
              title="Find in chat (Ctrl+F)"
              onClick={openFind}
            >
              <Search size={16} />
            </button>
            {onExport && (
              <button className="icon-btn" title="Export as Markdown" onClick={onExport}>
                <FileDown size={16} />
              </button>
            )}
            {onCopyLink && (
              <button className="icon-btn" title="Copy chat link" aria-label="Copy chat link" onClick={onCopyLink}>
                <Link2 size={16} />
              </button>
            )}
            {onSettle && !chat.archived && <SettleButton settled={chat.settled} size={16} className="icon-btn" onSettle={onSettle} />}
            {onArchive && !chat.running && <ArchiveButton archived={!!chat.archived} size={16} className="icon-btn" onArchive={onArchive} />}
            {paneControls}
          </div>
        </div>
        {findOpen && (
          <div className="find" role="search">
            <input
              ref={findRef}
              autoFocus
              placeholder="Find in chat"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
                setLanding(false);
                scrollToMatch.current = true;
                stickToBottom.current = false;
              }}
              onKeyDown={(e) => {
                if (composing(e)) return;
                if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
                } else if (e.key === "Escape") closeFind();
              }}
            />
            <span className="find-count" aria-live="polite">
              {query ? `${count ? Math.min(matchIndex, count - 1) + 1 : 0} of ${count}` : ""}
            </span>
            <button className="icon-btn" title="Previous (↑ or Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
              <ChevronUp size={16} />
            </button>
            <button className="icon-btn" title="Next (↓ or Enter)" disabled={!count} onClick={() => step(1)}>
              <ChevronDown size={16} />
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
              <X size={16} />
            </button>
          </div>
        )}
      </header>
      {banner && <div className="chat-banner">{banner}</div>}

      <div
        className="transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <JumpContext.Provider value={jumpTo}>
        <div className="transcript-inner">
          {chat.source !== "app" && (
            <div className="imported-note">
              <SourceIcon source={chat.source} /> Imported from {SOURCE_LABEL[chat.source]}.
              {chat.source === "import"
                ? " Its messages are dated as the file had them; a Markdown export has only the time it was exported."
                : chat.settled && " Replying here moves it to Active."}
            </div>
          )}
          {branchedFrom}
          {chat.savedAt !== undefined && (
            <div className="saved-note" role="note">
              {status === "connected" ? <HardDrive size={13} /> : <CloudOff size={13} />}
              <span>
                <b>Saved copy</b> from {savedWhen(chat.savedAt)}.{" "}
                {status === "connected"
                  ? chat.loading
                    ? "Loading the latest from Hermes…"
                    : "It may be out of date."
                  : "You're offline, so newer messages may be missing."}
              </span>
            </div>
          )}
          {chat.loading && blocks.length === 0 && (
            <div className="loading-chat">
              <Spinner /> Loading chat
            </div>
          )}
          {notLoaded && blocks.every((b) => b.kind === "user" && b.outgoing) && (
            <div className="unloaded-chat">
              <CloudOff size={14} /> This chat isn't saved on this computer. It loads once Hermes is connected.
            </div>
          )}
          {notice}
          {!chat.loading && !notLoaded && blocks.length === 0 && (
            <div className="empty-state">
              <div className="empty-chat">What should Hermes work on?</div>
              <ul className="empty-keys" aria-label="Keyboard shortcuts">
                <li><kbd>Ctrl N</kbd> New chat</li>
                <li><kbd>Ctrl K</kbd> Search chats</li>
                <li><kbd>Alt ↑↓</kbd> Switch chats</li>
                <li><kbd>Ctrl ,</kbd> Settings</li>
              </ul>
            </div>
          )}
          {blocks.map((b) => (
            <BlockView
              key={b.id}
              block={b}
              live={!!chat.running && b === last}
              query={q}
              offline={status !== "connected" || !!chat.loading}
              movedAt={b.kind === "approval" ? movedAt : 0}
              onAnswer={answer}
              listen={b.kind === "assistant" ? listen : undefined}
              canRetry={b.kind === "user" && !!b.outgoing && canRetry}
              onOutgoing={onOutgoing}
              onBranch={branch && (b.kind === "user" || b.kind === "assistant") ? onBranch : undefined}
              branchBlocked={branch && (b.kind === "user" || b.kind === "assistant") ? branch.blocked : undefined}
            />
          ))}
          {/* A reply waiting on the owner isn't thinking, and streamed thinking shows its own row. */}
          {chat.running && last?.kind !== "assistant" && last?.kind !== "thinking" && !(last && isWaiting(last)) && (
            <div className="msg assistant thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        </JumpContext.Provider>
      </div>

      {queueApi && <QueuePanel chat={chat} queue={queue} status={status} api={queueApi} />}
      {chat.source === "import" ? (
        // ADR 0031: an imported transcript is a record, not a session Hermes can carry on as it was.
        <div className="composer-wrap read-only-note" role="note">
          <FileInput size={14} aria-hidden /> This is an imported transcript, so it's read-only here. Hermes has its words, not
          everything the original chat had, so it can't carry on from it. Start a new chat to continue.
        </div>
      ) : (
      <Composer
        offline={status !== "connected"}
        queueing={queueing}
        onQueue={queueApi?.add}
        running={!!chat.running}
        stopping={!!chat.stopping}
        note={STATUS_NOTE[status]}
        hint={waiting ? "Hermes is waiting for your approval above." : undefined}
        alsoPostsIn={alsoPostsIn}
        text={draft}
        onText={onDraft}
        onAttach={onAttach}
        onSend={(t, attachments) => {
          stickToBottom.current = true;
          onSend(t, attachments);
        }}
        onStop={onStop}
        modelControls={modelControls}
        autoFocus={active}
        dropHere={(x, y) => {
          if (!visible) return false;
          if (!split) return true;
          const r = rootRef.current?.getBoundingClientRect();
          return !!r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        }}
        voice={voice}
        voiceSetup={voiceSetup}
        status={status}
        screenshots={screenshots}
        screenshotKeys={screenshotKeys}
        commands={commands}
        templates={templates}
      />
      )}
      <ShowInChatContext.Provider value={showInChat}>{footer}</ShowInChatContext.Provider>
    </div>
  );
}

/** Read aloud for a reply: the chat's speaker, and why it can't be used now. */
type Listen = { speaker: Speaker; blocked?: string };
type OutgoingAction = "retry" | "edit" | "dismiss";

/**
 * One block of the transcript. Memoized, so a streamed delta re-renders only the block it changes. `live`: the reply
 * or thinking is still streaming. `offline` and `movedAt` are for an Approval card; other blocks get `movedAt` 0, so
 * the transcript changing doesn't re-render them. `canRetry` and `onOutgoing` are for a message Hermes didn't take, or
 * may not have; other blocks get `canRetry` false.
 */
const BlockView = memo(
  function BlockView({
    block,
    live,
    query,
    offline,
    movedAt,
    onAnswer,
    listen,
    canRetry,
    onOutgoing,
    onBranch,
    branchBlocked,
  }: {
    block: Block;
    live: boolean;
    query: string;
    offline: boolean;
    movedAt: number;
    onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
    listen?: Listen;
    canRetry: boolean;
    onOutgoing: (itemId: string, action: OutgoingAction) => void;
    onBranch?: (itemId: string) => void;
    branchBlocked?: string;
  }) {
    if (block.kind === "user")
      return (
        <div className={`msg user${block.outgoing ? ` outgoing ${block.outgoing.state}` : ""}`} data-item={block.id} data-at={block.at}>
          {block.attachments && (
            <div className="msg-files">
              {block.attachments.map((name, i) => (
                <span key={i} className="chip">
                  <Paperclip size={12} />
                  <span className="chip-name">{name}</span>
                </span>
              ))}
            </div>
          )}
          {block.text && <div className="bubble-text">{highlight(block.text, query)}</div>}
          <StoredTime at={block.at} />
          {isOutgoing(block) && block.outgoing.state !== "sending" && (
            <SendFailed item={block} canRetry={canRetry} act={(action) => onOutgoing(block.id, action)} />
          )}
          {onBranch && !block.outgoing && block.text.trim() && (
            <div className="msg-actions">
              <BranchButton blocked={branchBlocked} onBranch={() => onBranch(block.id)} />
            </div>
          )}
        </div>
      );
    if (block.kind === "assistant")
      return (
        <div className="msg assistant" data-item={block.id} data-at={block.at}>
          <Markdown text={block.text} query={query} />
          {live && <span className="cursor" />}
          {block.interrupted && <div className="stopped">Stopped</div>}
          {!live && block.text.trim() && (listen || onBranch) && (
            <div className="msg-actions-row">
              {listen && <ListenButton speaker={listen.speaker} itemId={block.id} text={block.text} blocked={listen.blocked} />}
              {onBranch && (
                <div className="msg-actions">
                  <BranchButton blocked={branchBlocked} onBranch={() => onBranch(block.id)} />
                </div>
              )}
            </div>
          )}
          <StoredTime at={block.at} />
          {block.usage && !live && <ReplyUsageLine usage={block.usage} />}
        </div>
      );
    if (block.kind === "error")
      return (
        <div className="msg error" role="alert" data-item={block.id}>
          {block.text}
          {block.usage && <ReplyUsageLine usage={block.usage} />}
        </div>
      );
    if (block.kind === "thinking") return <Thought item={block} live={live} query={query} />;
    if (block.kind === "approval")
      return <ApprovalCard item={block} offline={offline} movedAt={movedAt} onAnswer={(c, confirmed) => onAnswer(block.id, c, confirmed)} />;
    return <ToolGroup tools={block.tools} />;
  },
  (a, b) =>
    sameBlock(a.block, b.block) &&
    a.live === b.live &&
    a.query === b.query &&
    a.offline === b.offline &&
    a.movedAt === b.movedAt &&
    a.onAnswer === b.onAnswer &&
    a.listen?.speaker === b.listen?.speaker &&
    a.listen?.blocked === b.listen?.blocked &&
    a.canRetry === b.canRetry &&
    a.onOutgoing === b.onOutgoing &&
    a.onBranch === b.onBranch &&
    a.branchBlocked === b.branchBlocked,
);

/**
 * Under a message Hermes didn't take, or may not have: why, and Retry, which sends the same words and files again as a
 * new message. One Hermes may have says so, since sending it again could run it twice; reading the chat's history back
 * once Hermes is connected settles it. Edit takes its words back into the composer, and is left out for a message with
 * files, which the composer can't take back.
 */
/** A reason as a sentence: Hermes's own come as lowercase fragments, like "session busy". */
const sentence = (text = "") => (text ? `${text[0].toUpperCase()}${text.slice(1)}${/[.!?)]$/.test(text) ? "" : "."}` : "");

function SendFailed({ item, canRetry, act }: { item: OutgoingItem; canRetry: boolean; act: (action: OutgoingAction) => void }) {
  const unknown = item.outgoing.state === "unknown";
  return (
    <div className={`send-failed ${item.outgoing.state}`} role="alert">
      <div className="send-failed-why">
        <CircleAlert size={13} />
        <span>
          {unknown ? "Hermes may already have this message. " : "Not sent. "}
          {sentence(item.outgoing.reason)}
          {unknown && " It's checked against the chat's history once Hermes is connected."}
        </span>
      </div>
      <div className="send-failed-actions">
        <button className="btn" onClick={() => act("dismiss")}>
          Dismiss
        </button>
        {!item.outgoing.attachments?.length && (
          <button className="btn" onClick={() => act("edit")}>
            Edit
          </button>
        )}
        <button className="btn primary" onClick={() => act("retry")} disabled={!canRetry} title={unknown ? "Send it again: Hermes may run it twice" : "Send it again"}>
          <RotateCcw size={13} /> Retry
        </button>
      </div>
    </div>
  );
}

/**
 * The model's reasoning, folded to one line. `live`: it is still streaming, so the line shows its latest words.
 */
function Thought({ item, live, query }: { item: ThinkingItem; live: boolean; query: string }) {
  const [open, setOpen] = useState(false);
  const latest = item.text.trimEnd().split("\n").pop();
  return (
    <div className="tools" data-item={item.id}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {live ? <Spinner /> : <Brain size={13} />}
        <span className="thought-label">{live ? "Thinking" : "Thought"}</span>
        <span className="tool-preview thought-preview">{live && !open ? latest : ""}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && <div className="thought-body">{highlight(item.text, query)}</div>}
    </div>
  );
}

function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const jump = useContext(JumpContext);
  useEffect(() => {
    if (jump?.callId && t.callId === jump.callId) setOpen(true);
  }, [jump?.at]);
  const summary = t.status === "stopped" ? "stopped" : t.summary;
  return (
    <div className={`tool ${open ? "open" : ""}`} data-call={t.callId} tabIndex={t.callId ? -1 : undefined}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t.status === "running" ? <Spinner /> : <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />}
        <span className="tool-name">{t.name}</span>
        <span className="tool-preview">{t.preview && withoutBidi(t.preview)}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {t.durationS != null && <span className="tool-dur">{t.durationS}s</span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Arguments</div>
          <pre>{withoutBidi(JSON.stringify(t.args ?? {}, null, 2))}</pre>
          {/* Stored history keeps no result for most tools. */}
          {(t.status === "running" || t.result !== undefined) && (
            <>
              <div className="tool-label">Result</div>
              <pre>{t.status === "running" ? "…" : t.result ? withoutBidi(t.result) : "(empty)"}</pre>
            </>
          )}
          <ToolPreviews t={t} />
        </div>
      )}
    </div>
  );
}

/**
 * What an opened tool call can show in the preview pane: the files and pages it names, which are on the Hermes server
 * since that is where tools run, and its output.
 */
function ToolPreviews({ t }: { t: ToolItem }) {
  const open = useOpenPreview();
  if (!open) return null;
  const targets = toolTargets(t, location.origin);
  const output = t.status !== "running" && t.result ? t.result : undefined;
  if (!targets.length && !output) return null;
  return (
    <div className="tool-previews">
      <span className="tool-label">Preview</span>
      {targets.map((x) => (
        <button
          key={x.kind === "server" ? `s:${x.path}` : x.kind === "web" ? `w:${x.url}` : x.kind}
          className="preview-chip"
          title={x.kind === "server" ? `${withoutBidi(x.path)}\nOn the Hermes server` : x.kind === "web" ? x.url : undefined}
          onClick={() => open(x)}
        >
          {x.kind === "server" ? <Server size={12} /> : <Globe size={12} />}
          <span>{withoutBidi(previewName(x))}</span>
        </button>
      ))}
      {output && (
        <button className="preview-chip" title="What the tool call returned" onClick={() => open({ kind: "tool", name: t.name, text: output })}>
          <Wrench size={12} />
          <span>Output</span>
        </button>
      )}
    </div>
  );
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const jump = useContext(JumpContext);
  useEffect(() => {
    if (jump?.callId && tools.some((t) => t.callId === jump.callId)) setOpen(true);
  }, [jump?.at]);
  if (tools.length === 1)
    return (
      <div className="tools">
        <ToolRow t={tools[0]} />
      </div>
    );
  const running = tools.find((t) => t.status === "running");
  const names = [...new Set(tools.map((t) => t.name))].join(", ");
  return (
    <div className="tools" data-calls={tools.flatMap((t) => t.callId ?? []).join(" ") || undefined} tabIndex={-1}>
      <button className="tool-line group" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {running ? <Spinner /> : <Wrench size={13} />}
        <span className="tool-name">{tools.length} tool calls</span>
        <span className="tool-preview">{running ? withoutBidi(`${running.name} · ${running.preview ?? ""}`) : names}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  offline,
  queueing = false,
  onQueue,
  running,
  stopping,
  note,
  hint,
  alsoPostsIn,
  text,
  onText,
  onAttach,
  onSend,
  onStop,
  modelControls,
  autoFocus = true,
  dropHere,
  voice,
  voiceSetup,
  status,
  screenshots,
  screenshotKeys,
  commands,
  templates = NO_PROJECTS,
}: {
  offline: boolean;
  /** Enter, and the Queue button, add the message to the chat's queue (`onQueue`, which says why it couldn't). */
  queueing?: boolean;
  onQueue?: (text: string, attachments: Attachment[]) => string | undefined;
  running: boolean;
  stopping: boolean;
  note?: string;
  hint?: string;
  alsoPostsIn?: Source;
  /** `onSend` empties it. */
  text: string;
  onText: (text: string) => void;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  modelControls?: ReactNode;
  autoFocus?: boolean;
  /** Whether a drop at this point of the window, in CSS pixels, is for this composer. Left out, every drop is. */
  dropHere?: (x: number, y: number) => boolean;
  voice?: VoiceApi;
  voiceSetup?: VoiceSetup;
  status: ConnectionStatus;
  /** Screenshots come from here, and staged ones go back to it to be deleted once sent, removed or left behind. */
  screenshots?: ScreenshotDesk;
  screenshotKeys?: string;
  commands?: CommandHost;
  templates?: TemplateHere;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const focused = useRef(autoFocus);
  focused.current = autoFocus;
  // The transcript joins the text as it is when it arrives, typed meanwhile included.
  const textRef = useRef(text);
  textRef.current = text;
  // Focus goes back to the text once a recording is done with, whichever way, since the controls it was on are gone.
  const wasDictating = useRef(false);
  const dictation = useDictation(voice?.transcribe, (heard) => {
    if (!focused.current) return;
    const next = withTranscript(textRef.current, heard);
    onText(next);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      // After React has put the new text in.
      requestAnimationFrame(() => ta.setSelectionRange(next.length, next.length));
    }
  });
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const previews = useRef<Previews>(null);
  const [, previewed] = useReducer((n: number) => n + 1, 0);

  // Thumbnails follow the staged list, so removing, sending or replacing an image releases its preview.
  useEffect(() => {
    const p = new Previews(readPreview, previewed);
    previews.current = p;
    return () => p.dispose();
  }, []);
  useEffect(() => previews.current?.sync(attachments), [attachments]);
  useEffect(() => {
    if (wasDictating.current && !dictation.active && autoFocus) taRef.current?.focus();
    wasDictating.current = dictation.active;
  }, [dictation.active]);
  // Leaving a pane (including Settings or the narrow switcher) releases its microphone and drops late transcripts.
  useEffect(() => { if (!autoFocus) dictation.cancel(); }, [autoFocus]);

  // Files still being read, saved or checked: sending waits for them, so none misses the message it was added for.
  const [attaching, setAttaching] = useState(0);
  const busy = async <T,>(work: () => Promise<T>): Promise<T> => {
    setAttaching((n) => n + 1);
    try {
      return await work();
    } finally {
      setAttaching((n) => n - 1);
    }
  };

  const add = (paths: string[], stillHere = () => true) => busy(async () => {
    if (!paths.length) return [];
    try {
      const got = await onAttach(paths);
      if (!stillHere()) return [];
      setAttachments((cur) => [...cur, ...got.attachments.filter((a) => !cur.some((x) => x.path === a.path))]);
      setRefused(got.refused);
      return got.attachments.map((a) => a.path);
    } catch (e) {
      if (!stillHere()) return [];
      setRefused([`Couldn't attach files: ${e instanceof Error ? e.message : String(e)}`]);
      return [];
    }
  });
  const addRef = useRef(add);
  addRef.current = add;
  const dropHereRef = useRef(dropHere);
  dropHereRef.current = dropHere;

  // Screenshots attach here while this composer is on screen. Any still staged when it goes (another chat opened,
  // signing out) are deleted: attachments aren't kept in a Draft.
  const shot = useSyncExternalStore(screenshots?.subscribe ?? noDesk, screenshots?.getSnapshot ?? (() => NOT_CAPTURING));
  // A new screenshot replaces the notes about the last thing attached.
  useEffect(() => {
    if (shot.capturing) setRefused([]);
  }, [shot.capturing]);
  const staged = useRef(attachments);
  staged.current = attachments;
  useEffect(() => {
    if (!screenshots || !autoFocus) return;
    let current = true;
    const stop = screenshots.attachTo({
      attach: (paths) => addRef.current(paths, () => current),
      detach: (paths) => setAttachments((cur) => cur.filter((a) => !paths.includes(a.path))),
      restore: (back) => setAttachments((cur) => [...cur, ...back.filter((a) => !cur.some((x) => x.path === a.path))]),
      note: (text) => setRefused((cur) => [...cur, text]),
    });
    return () => {
      current = false;
      stop();
    };
  }, [screenshots, autoFocus]);
  // Focus changes only transfer capture routing. A pane retains its staged attachments until its composer leaves.
  useEffect(() => () => screenshots?.release(staged.current.map((a) => a.path)), [screenshots]);

  // Tauri's native drop event, not HTML5 drops: it gives real file paths, so Rust can read the bytes. Every composer
  // hears every drop; with two panes, the one under the pointer takes it. Tauri gives the point in physical pixels.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      const here = (p: { x: number; y: number }) => {
        const scale = window.devicePixelRatio || 1;
        return dropHereRef.current?.(p.x / scale, p.y / scale) ?? true;
      };
      if (payload.type === "enter" || payload.type === "over") setDragging(here(payload.position));
      else {
        setDragging(false);
        if (payload.type === "drop" && here(payload.position)) void addRef.current(payload.paths);
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  // A pasted screenshot or file has no path of its own: Rust saves it to a temp file, which then attaches like a drop.
  const paste = (pasted: File[] | Promise<File[]>) => busy(async () => {
    try {
      const files = await pasted;
      const paths = await Promise.all(
        files.map(async (f) =>
          invoke<string>("stage_clipboard_file", await f.arrayBuffer(), { headers: { "x-name": encodeURIComponent(pastedName(f)) } }),
        ),
      );
      await add(paths);
    } catch (e) {
      setRefused([`Couldn't attach the pasted files: ${e instanceof Error ? e.message : String(e)}`]);
    }
  });

  const pick = async () => {
    try {
      const paths = await openFileDialog({ multiple: true, directory: false });
      if (paths) await add(paths);
    } catch (e) {
      setRefused([`Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  // The template library; Insert puts its message in the draft, never sends it.
  const [picking, setPicking] = useState(false);

  const sendable = attaching === 0 && (!!text.trim() || attachments.length > 0);
  const slash = useSlashCommands(commands, text, onText, taRef);
  const send = () => {
    if (slash.run()) return;
    if (!sendable) return;
    if (queueing && onQueue) {
      const why = onQueue(text.trim(), attachments);
      if (why) return setRefused([why]);
    } else {
      if (offline || running) return;
      onSend(text.trim(), attachments);
    }
    setAttachments([]);
    setRefused([]);
  };

  return (
    <div
      className="composer-wrap"
      onKeyDown={(e) => {
        if (e.key === "Escape" && dictation.active && !composing(e)) {
          e.preventDefault();
          dictation.cancel();
        }
      }}
    >
      {note && <div className="offline-note">{note}</div>}
      {!note && hint && <div className="composer-hint">{hint}</div>}
      {alsoPostsIn && (
        <div className="platform-note">
          <SourceIcon source={alsoPostsIn} /> Hermes also posts its replies in this {SOURCE_LABEL[alsoPostsIn]} chat.
        </div>
      )}
      <DictationNoteView dictation={dictation} />
      {shot.capturing && (
        <div className="capture-note" role="status">
          Taking a screenshot: select a region or window, or press Esc to cancel.
        </div>
      )}
      {refused.map((r, i) => (
        <div key={i} className="attach-note" role="alert">
          {r}
        </div>
      ))}
      {slash.view}
      <div className={`composer ${dragging ? "dragging" : ""}`}>
        {dragging && <div className="drop-overlay">Drop files to attach</div>}
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((f) => (
              <AttachmentChip
                key={f.path}
                file={f}
                preview={previews.current?.get(f.path)}
                onRemove={() => {
                  setAttachments((cur) => cur.filter((x) => x.path !== f.path));
                  screenshots?.release([f.path]);
                }}
              />
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          autoFocus={autoFocus}
          placeholder="Message Hermes"
          value={text}
          {...slash.inputProps}
          onChange={(e) => onText(e.target.value)}
          onPaste={(e) => {
            // Only files are taken over; text pastes as it always has.
            if (dragging) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void paste(files);
            } else if (!e.clipboardData.getData("text/plain")) void paste(clipboardImages());
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
              e.preventDefault();
              // Enter queues only while the hint below says so; Dictation hides it.
              if (!(queueing && dictation.active)) send();
            }
          }}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach files" onClick={() => void pick()}>
            <Paperclip size={16} />
          </button>
          {voice && !dictation.active && <MicButton dictation={dictation} blocked={micBlocked(status, voiceSetup)} />}
          {screenshots && (
            <button
              className="icon-btn"
              title={screenshotKeys ? `Attach a screenshot (${screenshotKeys})` : "Attach a screenshot"}
              aria-label="Attach a screenshot"
              disabled={shot.capturing}
              onClick={() => void screenshots.capture()}
            >
              <Camera size={16} />
            </button>
          )}
          <button className="icon-btn" title="Templates" aria-label="Templates" aria-haspopup="dialog" onClick={() => setPicking(true)}>
            <FileText size={16} />
          </button>
          {modelControls}
          {!dictation.active && <span className="composer-keys">{queueing ? "Enter to queue" : "Enter to send"} · Shift+Enter for a new line</span>}
          {queueing && onQueue && (
            <button className="send queue-btn" title="Queue: send after the reply (Enter)" aria-label="Queue" disabled={!sendable} onClick={send}>
              <ListPlus size={16} />
            </button>
          )}
          {running ? (
            <button className="send stop" title={stopping ? "Stopping" : "Stop"} disabled={offline || stopping} onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            !(queueing && onQueue) && (
              <button className="send" title="Send" disabled={offline || !sendable} onClick={send}>
                <ArrowUp size={16} />
              </button>
            )
          )}
        </div>
        {dictation.active && <DictationStrip dictation={dictation} />}
      </div>
      {picking && (
        <Templates
          here={templates}
          draft={text}
          returnTo={taRef}
          onClose={() => setPicking(false)}
          onInsert={(next) => {
            onText(next);
            // After React has put the new text in.
            requestAnimationFrame(() => taRef.current?.setSelectionRange(next.length, next.length));
          }}
        />
      )}
    </div>
  );
}

const NO_PROJECTS: TemplateHere = { scope: "", projects: [], here: [] };
