// The notice a chat link shows while it is being opened, and why it couldn't be (ADR 0033). It sits over the top of
// the window and never takes focus, so typing in the composer carries on; nothing in it sends anything.
import { Link2, Loader2, TriangleAlert } from "lucide-react";

export type LinkAction = { label: string; onClick: () => void };

/**
 * `pending`: on its way, with `Cancel`. `confirm`: it needs the owner's yes first, as a profile switch with a reply
 * running does. `error`: it couldn't open, with what to do about it; `Dismiss` closes it.
 */
export type LinkNoticeView = { kind: "pending" | "confirm" | "error"; text: string; actions?: LinkAction[] };

export function ChatLinkNotice({ view, onClose }: { view: LinkNoticeView; onClose: () => void }) {
  const { kind, text, actions = [] } = view;
  return (
    <div className={`link-notice ${kind}`} role={kind === "error" ? "alert" : "status"} aria-label="Chat link">
      <span className="link-notice-icon" aria-hidden>
        {kind === "pending" ? <Loader2 size={16} className="spin" /> : kind === "error" ? <TriangleAlert size={16} /> : <Link2 size={16} />}
      </span>
      <span className="link-notice-text">{text}</span>
      <span className="link-notice-actions">
        {actions.map((a) => (
          <button key={a.label} className="btn small" onClick={a.onClick}>
            {a.label}
          </button>
        ))}
        <button className="btn small ghost" onClick={onClose}>
          {kind === "error" ? "Dismiss" : "Cancel"}
        </button>
      </span>
    </div>
  );
}
