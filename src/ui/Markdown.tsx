// Markdown with highlighted, copyable code blocks and find-in-chat marks. Ported from the prototype. Single newlines
// are kept as line breaks, since replies often put one item per line. Links open in the preview pane, never in the
// app's own window (previewContext.tsx).
import { Children, isValidElement, memo, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { escapeRe } from "./bits";
import { PreviewLink } from "./previewContext";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/**
 * Rehype plugin: wraps each case-insensitive occurrence of `query` in `<mark class="hit">`. It runs after
 * rehype-highlight, so code blocks are marked too, except where a match spans two highlighted tokens.
 */
function rehypeFind(query: string) {
  return () => (tree: HastNode) => {
    if (!query) return;
    const re = new RegExp(`(${escapeRe(query)})`, "gi");
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        return child.value
          .split(re)
          .flatMap((part, i): HastNode[] =>
            !part ? [] : i % 2 ? [{ type: "element", tagName: "mark", properties: { className: ["hit"] }, children: [{ type: "text", value: part }] }] : [{ type: "text", value: part }],
          );
      });
    };
    walk(tree);
  };
}

/** The language a highlighted `<code>` element names in its class, `language-ts`, or "" for none. */
function codeLanguage(children: ReactNode): string {
  const code = Children.toArray(children).find(isValidElement) as { props: { className?: unknown } } | undefined;
  const className = code?.props.className;
  return (typeof className === "string" && className.match(/language-(\S+)/)?.[1]) || "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code-head">
        <span>{codeLanguage(children)}</span>
        <button
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(ref.current?.innerText ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

// The highlighter is made once: rehype-highlight builds a fresh highlight.js instance, with every grammar to compile
// again, each time the plugin is attached, and ReactMarkdown attaches its plugins on every render.
const highlightCode = rehypeHighlight({ detect: true });

const remarkPlugins = [remarkGfm, remarkBreaks];
const highlightOnly = [() => highlightCode];

// Made once, not on each render: a new `pre` function would be a new component type to React, which would throw away
// every code block's DOM and build it again on each streamed delta (#224).
const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, title, children }) => (
    <PreviewLink href={href} title={title}>
      {children}
    </PreviewLink>
  ),
};

/** `query`: the find-in-chat text to mark. */
export const Markdown = memo(function Markdown({ text, query = "" }: { text: string; query?: string }) {
  const rehypePlugins = useMemo(() => (query ? [() => highlightCode, rehypeFind(query)] : highlightOnly), [query]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
