// A reply split into its top-level Markdown blocks, so that while it streams in, each finished block renders once and
// only the last, still-growing one is parsed again (#224). Blocks are found by the same parser and GFM extensions that
// render them (micromark, through mdast-util-from-markdown), never by hand.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes } from "mdast";

/**
 * One top-level block: its source, from the start of its first line to the end of its last, without the blank lines
 * after it, so a finished block's text stays the same as the next one begins. `refs`: it defines a link reference or
 * footnote. `open`: it ends in code that may still be coming in (`openCode`).
 */
export type Block = { start: number; text: string; refs: boolean; open: boolean };

/**
 * `text` in blocks. `whole`: a block defines a link reference or footnote, which can change how any other block
 * renders, so the text has to be rendered in one piece.
 */
export type Blocks = { text: string; blocks: Block[]; whole: boolean };

const options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

const fence = /^[ \t>]*(`{3,}|~{3,})/;
const closingFence = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Whether the code block from `start` to `end` in `source` may still be coming in, were `source` to grow: nothing but
 * blank space after it, and its fence not closed yet (or no fence: indented code goes on while indented lines come).
 */
export function openCode(source: string, start: number, end: number): boolean {
  if (source.slice(end).trim()) return false;
  const lines = source.slice(start, end).split("\n");
  const open = lines[0].match(fence)?.[1];
  if (!open) return true;
  const close = lines.length > 1 ? lines[lines.length - 1].match(closingFence)?.[1] : undefined;
  return !close || close[0] !== open[0] || close.length < open.length;
}

/** Whether `node`, parsed from `source`, ends in code that may still be coming in. */
function endsInOpenCode(node: Nodes, source: string): boolean {
  for (;;) {
    if (node.type === "code") return openCode(source, node.position?.start.offset ?? 0, node.position?.end.offset ?? source.length);
    if (!("children" in node) || !node.children.length) return false;
    node = node.children[node.children.length - 1];
  }
}

const definesRefs = (node: Nodes): boolean =>
  node.type === "definition" || node.type === "footnoteDefinition" || ("children" in node && node.children.some(definesRefs));

/** The top-level blocks of `text`, each starting at `base` plus where its first line starts in `text`. */
function lex(text: string, base: number): Block[] {
  const starts: number[] = [];
  const refs: boolean[] = [];
  const open: boolean[] = [];
  for (const node of fromMarkdown(text, options).children) {
    const at = node.position?.start.offset ?? 0;
    // From the start of its line: a fence or list indented a little keeps its indentation, which shapes its content.
    const start = starts.length ? text.lastIndexOf("\n", at - 1) + 1 : 0;
    // Two blocks starting on one line would render as one; they can't be told apart by line, so they stay together.
    if (starts.length && start <= starts[starts.length - 1]) {
      refs[refs.length - 1] ||= definesRefs(node);
      open[open.length - 1] = endsInOpenCode(node, text);
      continue;
    }
    starts.push(start);
    refs.push(definesRefs(node));
    open.push(endsInOpenCode(node, text));
  }
  return starts.map((start, i) => ({ start: base + start, text: text.slice(start, starts[i + 1]).replace(/(\n[ \t]*)+$/, ""),
    refs: refs[i],
    open: open[i],
  }));
}

/**
 * `text`'s top-level blocks. With `prev`, the blocks of an earlier `text` that this one continues, only its last two
 * blocks and what follows are parsed again. Text added at the end can grow or end the last block, or turn it into
 * part of the block before (a paragraph "2" becomes item 2 of the list above it once "." comes). It can't change how
 * a block's first line reads, so nothing before the second last block moves. Link reference and footnote definitions
 * can change any block, and make the result `whole`.
 */
export function splitBlocks(text: string, prev?: Blocks): Blocks {
  const from = prev && text.startsWith(prev.text) ? (prev.blocks[prev.blocks.length - 2]?.start ?? 0) : 0;
  const kept = from ? prev!.blocks.slice(0, -2) : [];
  const blocks = [...kept, ...lex(text.slice(from), from)];
  return { text, blocks, whole: blocks.some((b) => b.refs) };
}
