// @vitest-environment jsdom
// A reply streaming in through Markdown (#224): each delta must redo only what it changed, and the finished reply must
// come out as it always has.
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

const fence = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```";

describe("A code block while a reply streams in", () => {
  it("keeps its DOM node from delta to delta", () => {
    let text = "Here it is:\n\n" + fence("ts", "const a = 1;") + "\n\nAnd";
    const { container, rerender } = render(<Markdown text={text} />);
    const pre = container.querySelector("pre")!;
    const box = container.querySelector(".code")!;
    for (const more of [" then", " some", " more", "\n\n- a list", "\n- of things"]) {
      rerender(<Markdown text={(text += more)} />);
      expect(container.querySelector("pre")).toBe(pre);
      expect(container.querySelector(".code")).toBe(box);
    }
  });

  it("names its language on the first render, with nothing to read back from the page", () => {
    expect(renderToStaticMarkup(<Markdown text={fence("python", "def f():\n    return 1")} />)).toContain('<div class="code-head"><span>python</span>');
  });
});
