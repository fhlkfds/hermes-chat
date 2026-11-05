// The parse + highlight work Markdown does while a reply streams in, timed in Node without React or layout (#224).
// The reply is a sentence plus a 40-line code block, repeated N times, streamed 12 characters at a time. `whole` is
// what Markdown did before #224: every delta runs remark → rehype → highlight over the whole reply.
// Usage: npx rolldown bench/parse.ts --platform node -o <out>.mjs && node <out>.mjs [whole|blocks]
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import { codeReply as reply } from "./fixture";

const highlight = rehypeHighlight({ detect: true });
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkRehype).use(() => highlight);
const whole = (text: string) => processor.runSync(processor.parse(text));

export type Step = (text: string) => void;

export function run(name: string, make: () => Step, blocks: number[] = [1, 3, 6, 10]) {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  // Warm up, so the first row isn't the JIT's.
  for (const tagged of [false, true]) {
    const text = reply(1, tagged);
    const step = make();
    for (let i = 12; i < text.length + 12; i += 12) step(text.slice(0, i));
  }
  console.log(`\n${name}`);
  console.log("| Code blocks | Untagged: last delta | Untagged: worst delta | Untagged: total | Tagged ts: last delta | Tagged: worst delta | Tagged: total |");
  console.log("|---|---|---|---|---|---|---|");
  for (const n of blocks) {
    const cells: string[] = [];
    for (const tagged of [false, true]) {
      const text = reply(n, tagged);
      const step = make();
      let total = 0;
      let last = 0;
      let worst = 0;
      for (let i = 12; i < text.length + 12; i += 12) {
        const t0 = performance.now();
        step(text.slice(0, i));
        last = performance.now() - t0;
        total += last;
        worst = Math.max(worst, last);
      }
      cells.push(`${r1(last)} ms`, `${r1(worst)} ms`, `${r1(total / 1000)} s`);
    }
    console.log(`| ${n} | ${cells.join(" | ")} |`);
  }
}

if (process.argv[2] === "whole") run("whole reply per delta (before #224)", () => whole);
