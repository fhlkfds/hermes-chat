// The chat's queue of messages waiting to go after its reply (ADR 0013), above the composer. Both panes of a chat show
// the same queue. Each message can be edited, moved and removed; the queue can be paused and resumed.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ListOrdered, Paperclip, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { type Attachment, type Chat, type ChatQueue, type ConnectionStatus, type Queued, isOutgoing, isWaiting } from "../hermes/model";
import { composing } from "./bits";

/** What the queue panel does, for a chat that has started. `add` returns why a message couldn't be queued. */
export type QueueApi = {
  add: (text: string, attachments: Attachment[]) => string | undefined;
  edit: (id: string, text: string) => boolean;
  remove: (id: string) => void;
  move: (id: string, by: number) => void;
  pause: () => void;
  resume: () => void;
  /** Keeps the queue from going while a message in it is edited; call the result when done. */
  hold: () => () => void;
};

/** What the next queued message waits for, when the queue isn't paused. */
function waitingFor(chat: Chat, status: ConnectionStatus): string {
  if (status !== "connected") return "Waits for Hermes to connect.";
  if (chat.items.some(isOutgoing)) return "Waits until the message above is sent, retried or dismissed.";
  if (chat.items.some(isWaiting)) return "Waits for your answer to the Approval above.";
  if (chat.running) return "The next one goes when this reply finishes.";
  return "Sending the next one…";
}

export function QueuePanel({ chat, queue, status, api }: { chat: Chat; queue?: ChatQueue; status: ConnectionStatus; api: QueueApi }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // After a move or removal, focus stays with the message moved, or goes to the one now in the removed one's place.
  const [focus, setFocus] = useState<{ id?: string; index: number; button?: string }>();
  const items = queue?.items ?? [];
  useEffect(() => {
    if (!focus) return;
    setFocus(undefined);
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".queue-item") ?? []);
    const row = rows.find((r) => r.dataset.queued === focus.id) ?? rows[Math.min(focus.index, rows.length - 1)];
    const target = (focus.button && row?.querySelector<HTMLElement>(`[data-action="${focus.button}"]:not(:disabled)`)) || row;
    if (target) target.focus();
    else rootRef.current?.closest(".chat")?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  });
  // The panel goes with its last message; the wrapper stays, so focus can be put back in the pane.
  if (!items.length) return <div ref={rootRef} />;

  const paused = queue?.paused !== undefined;
  const move = (item: Queued, by: number, button?: string) => {
    api.move(item.id, by);
    setFocus({ id: item.id, index: 0, button });
  };
  const remove = (item: Queued, index: number) => {
    api.remove(item.id);
    setFocus({ index });
  };

  return (
    <div ref={rootRef}>
      <section className={`queue${paused ? " paused" : ""}`} aria-label="Queued messages">
        <div className="queue-head">
          <ListOrdered size={13} aria-hidden />
          <span className="queue-title">Queued · {items.length}</span>
          <span className="queue-state" aria-live="polite">
            {paused ? `Paused. ${queue!.paused}` : waitingFor(chat, status)}
          </span>
          {paused ? (
            <button className="btn queue-toggle" onClick={api.resume}>
              <Play size={12} /> Resume
            </button>
          ) : (
            <button className="btn queue-toggle" onClick={api.pause}>
              <Pause size={12} /> Pause
            </button>
          )}
        </div>
        {queue?.unsaved && (
          <div className="queue-note" role="alert">
            Couldn't save the queue on this computer: its storage is full. It's kept until Hermes Chat closes.
          </div>
        )}
        <ol className="queue-list">
          {items.map((item, i) => (
            <QueueRow
              key={item.id}
              item={item}
              index={i}
              count={items.length}
              state={paused ? "Paused" : i === 0 ? "Next" : "Queued"}
              api={api}
              onMove={(by, button) => move(item, by, button)}
              onRemove={() => remove(item, i)}
            />
          ))}
        </ol>
        <div className="queue-foot">Hermes Chat sends these itself, one after each reply, only while it's open and connected.</div>
      </section>
    </div>
  );
}

function QueueRow({
  item,
  index,
  count,
  state,
  api,
  onMove,
  onRemove,
}: {
  item: Queued;
  index: number;
  count: number;
  state: string;
  api: QueueApi;
  onMove: (by: number, button?: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<string>();
  const [gone, setGone] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const files = item.attachments?.length ?? 0;
  // Nothing in the queue goes while its words are being changed.
  useEffect(() => (editing === undefined ? undefined : api.hold()), [editing === undefined]);

  const close = () => {
    setEditing(undefined);
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('[data-action="edit"]')?.focus());
  };
  const save = () => {
    if (editing === undefined) return;
    if (!api.edit(item.id, editing.trim())) setGone(true);
    close();
  };

  return (
    <li
      ref={rowRef}
      className="queue-item"
      data-queued={item.id}
      tabIndex={0}
      aria-label={`Queued message ${index + 1} of ${count}${files ? `, ${files} ${files === 1 ? "file" : "files"}` : ""}: ${item.text}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || composing(e)) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          onMove(e.key === "ArrowUp" ? -1 : 1);
        } else if (e.key === "Delete") {
          e.preventDefault();
          onRemove();
        }
      }}
    >
      <span className="queue-pos" aria-hidden>
        {index + 1}
      </span>
      <div className="queue-body">
        {editing === undefined ? (
          <span className="queue-text">{item.text || <i>Files only</i>}</span>
        ) : (
          <textarea
            className="queue-edit"
            aria-label={`Edit queued message ${index + 1}`}
            autoFocus
            rows={Math.min(6, editing.split("\n").length + 1)}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
        )}
        <div className="queue-meta">
          <span className={`queue-badge ${state.toLowerCase()}`}>{state}</span>
          {files > 0 && (
            <span className="queue-files">
              <Paperclip size={11} aria-hidden /> {files} {files === 1 ? "file" : "files"}
            </span>
          )}
          {gone && <span className="queue-gone">It had already gone, so the edit wasn't kept.</span>}
          {editing !== undefined && <span className="queue-keys">Enter to save · Esc to cancel</span>}
        </div>
      </div>
      <div className="queue-actions">
        {editing === undefined ? (
          <>
            <button
              className="icon-btn"
              data-action="edit"
              title="Edit"
              aria-label={`Edit queued message ${index + 1}`}
              onClick={() => (setGone(false), setEditing(item.text))}
            >
              <Pencil size={13} />
            </button>
            <button
              className="icon-btn"
              data-action="up"
              title="Move up (Alt+↑)"
              aria-label={`Move queued message ${index + 1} up`}
              disabled={index === 0}
              onClick={() => onMove(-1, "up")}
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="icon-btn"
              data-action="down"
              title="Move down (Alt+↓)"
              aria-label={`Move queued message ${index + 1} down`}
              disabled={index === count - 1}
              onClick={() => onMove(1, "down")}
            >
              <ArrowDown size={13} />
            </button>
            <button className="icon-btn" data-action="remove" title="Remove (Delete)" aria-label={`Remove queued message ${index + 1}`} onClick={onRemove}>
              <Trash2 size={13} />
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={!editing.trim() && !files}>
              Save
            </button>
          </>
        )}
      </div>
    </li>
  );
}
