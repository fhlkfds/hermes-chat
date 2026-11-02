// Token usage and cost (ADR 0006): one compact line under each reply this app measured, and a chat's totals beside its
// title. Either opens its breakdown. Counts Hermes didn't report say so; costs say how Hermes got them.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Chat } from "../hermes/model";
import { costLabel, tokens, totalTokens, type ChatUsage, type ReplyUsage } from "../hermes/usage";
import { useReturnFocus } from "./bits";

const full = (n: number | undefined) => (n === undefined ? "Not reported" : n.toLocaleString());

/** One row of a breakdown. `sub`: a part of the row above it. */
function Row({ label, value, sub, note }: { label: string; value: string; sub?: boolean; note?: string }) {
  return (
    <div className={`usage-row ${sub ? "sub" : ""}`} title={note}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The tokens one reply's turn took: a line under the reply, and its breakdown when clicked. */
export function ReplyUsageLine({ usage }: { usage: ReplyUsage }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const parts = [`${tokens(usage.input)} in`, ...(usage.cache ? [`${tokens(usage.cache)} cache`] : []), `${tokens(usage.output)} out`];
  return (
    <div className="reply-usage">
      <button
        className="usage-line"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Tokens for this reply: ${parts.join(", ")}. ${open ? "Hide" : "Show"} breakdown`}
        onClick={() => setOpen((o) => !o)}
      >
        {parts.join(" · ")}
      </button>
      {open && (
        <dl className="usage-table" id={id} ref={(el) => el?.scrollIntoView?.({ block: "nearest" })}>
          <Row label="Input, not cached" value={full(usage.input)} />
          <Row label="Cache read or written" value={full(usage.cache)} note="Hermes's live counts don't tell cache reads from cache writes." />
          <Row label="Output" value={full(usage.output)} />
          <Row label="of which reasoning" value={full(usage.reasoning)} sub />
          <Row label="Model calls" value={full(usage.calls)} />
          {usage.model && <Row label="Model" value={usage.model} />}
          <Row label="Cost" value="Not reported per reply" note="Hermes reports cost only for the whole chat, beside its title." />
        </dl>
      )}
    </div>
  );
}

/**
 * The chat's tokens and cost so far, as Hermes recorded them, beside its title. Clicking shows the breakdown and reads
 * Hermes again (`onRefresh`). Nothing shows until Hermes has been read, unless that failed.
 */
export function ChatUsageButton({ chat, onRefresh }: { chat: Pick<Chat, "usage" | "usageError">; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => wrap.current?.contains(e.target as Node) || close();
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open, close]);
  const { usage, usageError } = chat;
  if (!usage && !usageError) return null;
  const total = usage && totalTokens(usage);
  const cost = usage && costLabel(usage.cost);
  const label = !usage
    ? "Usage unknown"
    : `${total !== undefined ? `${tokens(total)} tokens` : `${tokens(usage.input ?? 0)} in · ${tokens(usage.output ?? 0)} out`} · ${cost!.short}`;
  return (
    <div className="chat-usage" ref={wrap}>
      <button
        className={`usage-pill ${open ? "on" : ""} ${usageError ? "warn" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Usage for this chat: ${label}`}
        onClick={() => {
          if (!open) onRefresh();
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && <ChatUsagePopover usage={usage} error={usageError} onClose={close} />}
    </div>
  );
}

function ChatUsagePopover({ usage, error, onClose }: { usage?: ChatUsage; error?: string; onClose: () => void }) {
  useReturnFocus();
  const cost = usage && costLabel(usage.cost);
  return (
    <div
      className="usage-popover"
      role="dialog"
      aria-label="Usage for this chat"
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="usage-title">Usage for this chat</div>
      {usage && (
        <>
          <dl className="usage-table">
            <Row label="Input, not cached" value={full(usage.input)} />
            <Row label="Cache read" value={full(usage.cacheRead)} />
            <Row label="Cache written" value={full(usage.cacheWrite)} />
            <Row label="Output" value={full(usage.output)} />
            <Row label="of which reasoning" value={full(usage.reasoning)} sub />
            <Row label="Total" value={full(totalTokens(usage))} />
            <Row label="Model calls" value={full(usage.calls)} />
          </dl>
          <div className="usage-cost">
            <span className="usage-cost-value">{cost!.short}</span>
            <span className="usage-cost-detail">{cost!.detail}</span>
          </div>
          <p className="usage-note">
            Hermes's own totals for every model call in this chat, from any client and across model changes. Its helper
            tasks, such as titling, aren't included. Read {new Date(usage.readAt).toLocaleTimeString(undefined, { timeStyle: "short" })}.
          </p>
        </>
      )}
      {error && (
        <p className="usage-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
