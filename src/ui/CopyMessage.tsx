// Copy under a message and a reply: puts the message's words on the clipboard, and says so for a moment. It adds no
// copy listener, so selecting part of a message and pressing Ctrl+C works as before.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** How long Copy says Copied, or that it couldn't, before it reads Copy again. */
export const COPIED_MS = 1500;

const THINKING_OPENS = /^ {0,3}<(think|thinking|reasoning)>/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A reply's words as Markdown to paste elsewhere, otherwise exactly as Hermes wrote them. Thinking and tool calls are
 * their own items, so they're never in a reply's text. A model that writes its thinking inline, as a line starting
 * `<think>` (or `<thinking>`, `<reasoning>`) up to its closing tag, has it taken out here too, with the blank lines
 * after it; thinking never closed runs to the end. A tag inside a code block or mid-sentence stays, and so does every
 * other line, blank lines and indentation included. Only blank lines at the very start and the end are dropped.
 */
export function replyMarkdown(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let thinking: RegExp | undefined;
  let afterThinking = false;
  for (const line of text.split("\n")) {
    let rest = line;
    if (thinking) {
      const close = thinking.exec(rest);
      if (!close) continue;
      thinking = undefined;
      rest = rest.slice(close.index + close[0].length);
      if (!rest.trim()) continue;
      rest = rest.trimStart();
    } else if (fence) {
      const m = FENCE.exec(rest);
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && !rest.slice(m[0].length).trim()) fence = undefined;
      kept.push(rest);
      continue;
    } else {
      const open = THINKING_OPENS.exec(rest);
      if (open) {
        const closeTag = new RegExp(`</${open[1]}>`, "i");
        const after = rest.slice(open[0].length);
        const close = closeTag.exec(after);
        afterThinking = true;
        if (!close) {
          thinking = closeTag;
          continue;
        }
        rest = after.slice(close.index + close[0].length);
        if (!rest.trim()) continue;
        rest = rest.trimStart();
      }
    }
    if (afterThinking && !rest.trim()) continue;
    afterThinking = false;
    const m = FENCE.exec(rest);
    if (m) fence = { char: m[1][0], length: m[1].length };
    kept.push(rest);
  }
  return kept.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** Under a message or a reply: copies `text` as it is. */
export function CopyButton({ text, what }: { text: string; what: "message" | "reply" }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (s: "copied" | "failed") => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <button
      className="msg-action"
      title={state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy to the clipboard" : `Copy this ${what}`}
      aria-label={state === "copied" ? "Copied" : "Copy"}
      onClick={(e) => {
        // WebKit doesn't focus a clicked button, and the actions stay shown while one has focus.
        e.currentTarget.focus();
        navigator.clipboard.writeText(text).then(
          () => show("copied"),
          () => show("failed"),
        );
      }}
    >
      {state === "copied" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span role={state === "idle" ? undefined : "status"}>{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}</span>
    </button>
  );
}
