// Copy under a message and a reply: puts the message's words on the clipboard, and says so for a moment. It adds no
// copy listener, so selecting part of a message and pressing Ctrl+C works as before.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/** How long Copy says Copied, or that it couldn't, before it reads Copy again. */
export const COPIED_MS = 1500;

/** Where `text` has code (fenced, indented or inline), as Markdown parses it, the way the transcript renders it. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const walk = (node: Nodes) => {
    if ((node.type === "code" || node.type === "inlineCode") && node.position)
      ranges.push([node.position.start.offset ?? 0, node.position.end.offset ?? text.length]);
    else if ("children" in node) node.children.forEach(walk);
  };
  walk(fromMarkdown(text));
  return ranges;
}

/** From `at`, past spaces, and past the rest of the line and the blank lines after it when the rest is blank. */
function pastBlank(text: string, at: number): number {
  while (text[at] === " " || text[at] === "\t") at++;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    if (text.slice(at, nl < 0 ? undefined : nl).trim()) break;
    at = nl < 0 ? text.length : nl + 1;
  }
  return at;
}

/**
 * A reply's words as Markdown to paste elsewhere, otherwise exactly as Hermes wrote them. Thinking and tool calls are
 * their own items, so they're never in a reply's text. A model that writes its thinking inline, as `<think>` (or
 * `<thinking>`, `<reasoning>`) starting a line, up to its closing tag or else the end, has it taken out here too, with
 * any section straight after it and the blank lines it leaves. A tag in code, as Markdown parses it, or mid-sentence
 * stays, and so does every other line, blank lines and indentation included. Only blank lines at the very start and
 * the end are dropped.
 */
export function replyMarkdown(text: string): string {
  if (!/<(think|thinking|reasoning)>/i.test(text)) return trimBlank(text);
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([start, end]) => i >= start && i < end);
  const opens = /<(think|thinking|reasoning)>/gi;
  let kept = "";
  let from = 0;
  for (let m; (m = opens.exec(text)); ) {
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const startsLine = /^ {0,3}$/.test(text.slice(lineStart, m.index));
    if (inCode(m.index) || !(startsLine || m.index === from)) continue;
    const close = text.slice(opens.lastIndex).search(new RegExp(`</${m[1]}>`, "i"));
    const end = close < 0 ? text.length : opens.lastIndex + close + m[1].length + 3;
    if (m.index !== from) kept += text.slice(from, startsLine ? lineStart : m.index);
    from = opens.lastIndex = pastBlank(text, end);
  }
  return trimBlank(kept + text.slice(from));
}

const trimBlank = (text: string) => text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");

/** Under a message, a reply or a side question's answer: copies what `words` gives, read on each click. */
export function CopyButton({ words, what }: { words: () => string; what: "message" | "reply" | "answer" }) {
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
        navigator.clipboard.writeText(words()).then(
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
