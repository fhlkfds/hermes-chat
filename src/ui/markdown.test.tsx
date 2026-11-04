import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";
import { replyMarkdown } from "./CopyMessage";

const render = (text: string, query?: string) => renderToStaticMarkup(<Markdown text={text} query={query} />);

describe("Markdown", () => {
  it("highlights tagged code, and guesses the language of untagged code, on every render", () => {
    const untagged = "```\nfn parse(line: &str) -> Option<u32> {\n    let n: u32 = line.trim().parse().ok()?;\n    Some(n)\n}\n```";
    // The highlighter is shared between renders, so the second must come out the same as the first.
    for (let i = 0; i < 2; i++) {
      expect(render(untagged)).toMatch(/<code class="hljs language-rust">.*<span class="hljs-keyword">fn<\/span>/s);
      expect(render("```python\ndef f():\n    return 1\n```")).toContain('<span class="hljs-keyword">def</span>');
    }
  });

  it("marks find-in-chat matches in text and in highlighted code", () => {
    const html = render("Restart the **gateway**.\n\n```bash\nsystemctl restart gateway\n```", "GATEWAY");
    expect(html.match(/<mark class="hit">gateway<\/mark>/g)).toHaveLength(2);
    expect(render("Restart the gateway.", "")).not.toContain("<mark");
  });
});

describe("A reply's words to copy", () => {
  it("keeps the reply's Markdown as Hermes wrote it", () => {
    const reply = "## Fixed\n\n- Restarted **gateway**\n- See [logs](https://nas/logs)\n\n```bash\nsystemctl status gateway\n```";
    expect(replyMarkdown(reply)).toBe(reply);
  });

  it("leaves out thinking written inline, and closes up the lines it leaves", () => {
    expect(replyMarkdown("<think>The owner wants a yes.\nKeep it short.</think>\n\nYes, it's up.")).toBe("Yes, it's up.");
    expect(replyMarkdown("First.\n\n<THINKING>check the port</THINKING>\n\n\nSecond.")).toBe("First.\n\nSecond.");
    expect(replyMarkdown("<reasoning>still going")).toBe("");
  });

  it("leaves a tag that only mentions thinking in the middle of a reply", () => {
    expect(replyMarkdown("Wrap it in `<think>` tags.")).toBe("Wrap it in `<think>` tags.");
    expect(replyMarkdown("Put `<think>` before and `</think>` after.")).toBe("Put `<think>` before and `</think>` after.");
  });
});
