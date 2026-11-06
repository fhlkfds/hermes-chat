// A side question (`/btw`, ADR 0070) in the transcript where it was asked (ADR 0086): the owner's question, then
// Hermes's answer, each marked as outside the conversation. Hermes answers from a snapshot of the chat and adds
// nothing to it, and the question is never one of the chat's items, so nothing here is saved.
import { useRef } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { SideQuestion } from "../hermes/model";
import { CopyButton, replyMarkdown } from "./CopyMessage";
import { Markdown } from "./Markdown";
import { Spinner } from "./bits";

const TAG_TITLE = "Asked with /btw. Hermes answers from a snapshot of this chat; neither the question nor the answer is added to the chat or saved.";

function SideTag() {
  return (
    <span className="side-q-tag" title={TAG_TITLE}>
      <MessageCircleQuestion size={12} aria-hidden /> Side question · not part of the conversation
    </span>
  );
}

export function SideQuestionPair({ question: q, onDismiss }: { question: SideQuestion; onDismiss?: (id: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <article ref={ref} className={`side-q ${q.state}`} aria-label={`Side question: ${q.question}`}>
      <div className="msg user side">
        <SideTag />
        <div className="bubble-text">{q.question}</div>
      </div>
      <div className="msg assistant side">
        <div className="side-q-head">
          <SideTag />
          {onDismiss && (
            <button
              className="icon-btn"
              aria-label="Dismiss side question"
              title="Dismiss"
              onClick={() => {
                const box = ref.current?.closest(".chat")?.querySelector<HTMLTextAreaElement>(".composer textarea");
                onDismiss(q.id);
                box?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {q.state === "asking" && (
          <div className="side-q-body pending" role="status">
            <Spinner /> Hermes is answering from a snapshot of this chat…
          </div>
        )}
        {q.state === "failed" && (
          <div className="side-q-body" role="alert">
            No answer: {q.error}
          </div>
        )}
        {q.state === "answered" && (
          <>
            <div className="side-q-body" role="status">
              <Markdown text={q.answer} />
            </div>
            <div className="msg-actions">
              <CopyButton words={() => replyMarkdown(q.answer)} what="answer" />
            </div>
          </>
        )}
      </div>
    </article>
  );
}
