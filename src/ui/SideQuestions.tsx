// A chat's side questions (`/btw`, ADR 0070): a card each above the composer, newest nearest it, apart from the
// transcript. Hermes answers each from a snapshot of the chat and adds nothing to it, so nothing here is saved.
import { useLayoutEffect, useRef } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { SideQuestion } from "../hermes/model";
import { CopyButton, replyMarkdown } from "./CopyMessage";
import { Markdown } from "./Markdown";
import { Spinner } from "./bits";

export function SideQuestions({ questions, onDismiss }: { questions: SideQuestion[]; onDismiss: (id: string) => void }) {
  // The stack scrolls once it is taller than its share of the window. It stays at the bottom, where the newest question
  // is, as questions come and answers grow, unless the owner has scrolled up; a new question brings it back down.
  const ref = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const newest = useRef<string>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (newest.current !== questions.at(-1)?.id) atBottom.current = true;
    newest.current = questions.at(-1)?.id;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [questions]);
  return (
    <section
      ref={ref}
      className="side-questions"
      aria-label="Side questions"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {questions.map((q) => (
        <article key={q.id} className={`side-q ${q.state}`} aria-label={`Side question: ${q.question}`}>
          <div className="side-q-head">
            <span className="side-q-tag" title="Asked with /btw. Hermes answers from a snapshot of this chat; neither the question nor the answer is added to the chat or saved.">
              <MessageCircleQuestion size={13} aria-hidden /> Side question
            </span>
            <span className="side-q-question" title={q.question}>
              {q.question}
            </span>
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
              <div className="side-q-actions">
                <CopyButton words={() => replyMarkdown(q.answer)} what="answer" />
              </div>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
