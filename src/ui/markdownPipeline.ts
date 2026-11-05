// The remark and rehype plugins Markdown renders with, apart from React, so the bench (bench/parse.ts) can time the same
// work in Node.
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { toText } from "hast-util-to-text";
import { SKIP, visit } from "unist-util-visit";
import type { Element, ElementContent, Root } from "hast";
import type { VFile } from "vfile";
import { escapeRe } from "./bits";

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

// The highlighter is made once: rehype-highlight builds a fresh highlight.js instance, with every grammar to compile
// again, each time the plugin is attached, and ReactMarkdown attaches its plugins on every render.
const highlightCode = rehypeHighlight({ detect: true });

/**
 * Highlighted code, by its classes (so its language) and text: what highlight.js made of it. A block is highlighted
 * once, however often it renders: as a reply streams in, when find-in-chat marks change, in both panes. Least
 * recently used goes first once the code held passes `CACHE_CHARS`.
 */
const highlighted = new Map<string, { className: unknown; children: ElementContent[] }>();
const CACHE_CHARS = 500_000;
let cachedChars = 0;

/** Code longer than this, such as a whole file in the preview pane, is highlighted each time rather than copied in. */
const CACHE_ONE_CHARS = 50_000;

function highlight(code: Element, pre: Element, file: VFile) {
  // Only this block, on its own; the rest of the tree is not highlight.js's to walk.
  const run = () => highlightCode({ type: "root", children: [{ ...pre, children: [code] }] }, file);
  const key = JSON.stringify(code.properties.className ?? null) + "\n" + toText(code, { whitespace: "pre" });
  if (key.length > CACHE_ONE_CHARS) return run();
  const hit = highlighted.get(key);
  if (!hit) {
    run();
    // A copy, since find-in-chat marks are put into the tree, and the tree's copy is the one marked.
    highlighted.set(key, structuredClone({ className: code.properties.className, children: code.children }));
    cachedChars += key.length;
    for (const [old] of highlighted) {
      if (cachedChars <= CACHE_CHARS) break;
      highlighted.delete(old);
      cachedChars -= old.length;
    }
    return;
  }
  highlighted.delete(key);
  highlighted.set(key, hit);
  const copy = structuredClone(hit);
  code.properties.className = copy.className as Element["properties"]["className"];
  code.children = copy.children;
}

/** Code left plain for now, with the `hljs` class highlighting would give it, so its colours don't jump when it does. */
function plain(code: Element) {
  const className = Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
  if (!className.includes("hljs") && !className.includes("no-highlight") && !className.includes("nohighlight"))
    code.properties.className = ["hljs", ...className];
}

/**
 * Rehype plugin: highlights each code block, guessing the language of untagged ones. `source`: the Markdown being
 * rendered, when it ends in code still coming in (markdownBlocks.ts says which); the code at its very end then stays
 * plain until it is finished, so a streaming reply isn't highlighted again, and its language guessed again, on every
 * delta (ADR 0068).
 */
function rehypeCode(source?: string) {
  return () => (tree: Root, file: VFile) =>
    visit(tree, "element", (node, _, parent) => {
      if (node.tagName !== "code" || parent?.type !== "element" || parent.tagName !== "pre") return;
      if (source === undefined || source.slice(node.position?.end.offset ?? 0).trim()) highlight(node, parent, file);
      else plain(node);
      return SKIP;
    });
}

export const remarkPlugins = [remarkGfm, remarkBreaks];

const highlightOnly = [rehypeCode()];

/**
 * The rehype plugins for Markdown marking `query`. `growingIn`: the Markdown, when it is the end of a reply still
 * streaming in.
 */
export const rehypePlugins = (query: string, growingIn?: string) =>
  query || growingIn !== undefined ? [rehypeCode(growingIn), ...(query ? [rehypeFind(query)] : [])] : highlightOnly;
