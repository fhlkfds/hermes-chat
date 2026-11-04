// Copy under a message and a reply: puts the message's words on the clipboard, and says so for a moment. It adds no
// copy listener, so selecting part of a message and pressing Ctrl+C works as before.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** How long Copy says Copied, or that it couldn't, before it reads Copy again. */
export const COPIED_MS = 1500;

/**
 * A reply's words as Markdown to paste elsewhere. Thinking and tool calls are their own items, so they're never in a
 * reply's text; a model that writes its thinking inline as `<think>…</think>` (or `<thinking>`, `<reasoning>`) at the start
 * of a line has it taken out here too, as is thinking left open at the start. A tag named mid-sentence stays. The
 * blank lines left behind are closed up.
 */
export function replyMarkdown(text: string): string {
  return text
    .replace(/(^|\n)[ \t]*<(think|thinking|reasoning)>[\s\S]*?<\/\2>[ \t]*/gi, "$1")
    .replace(/^\s*<(think|thinking|reasoning)>[\s\S]*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
