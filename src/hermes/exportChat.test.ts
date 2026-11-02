import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { chatMarkdown, exportChat, exportFileName } from "./exportChat";
import type { Chat, Item } from "./model";

const AT = new Date("2026-11-02T14:05:00Z");

/** A chat whose stored history has loaded on this connection. */
const chat = (items: Item[], more: Partial<Chat> = {}): Chat => ({
  id: "20261102_140500_abc123",
  runtimeId: "rt-9f8e7d",
  title: "Fix nightly backup cron",
  source: "app",
  settled: false,
  updatedAt: AT.getTime(),
  items,
  ...more,
});

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, null, md));
/** The text of every code block, as a Markdown reader sees it. */
const codeBlocks = (md: string) =>
  [...html(md).matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"),
  );

describe("A chat as Markdown", () => {
  it("has the title, then each message with who wrote it, oldest first", () => {
    const md = chatMarkdown(
      chat([
        { kind: "user", id: "h-0", text: "The nightly backup cron hasn't run since Tuesday.\n\n- check logs\n- check disk" },
        { kind: "assistant", id: "h-1", text: "Found it. The job runs `restic backup`, which **fails**." },
      ]),
      AT,
    );
    expect(md.startsWith("# Fix nightly backup cron\n")).toBe(true);
    expect(md).toContain("**You:**\n\nThe nightly backup cron hasn't run since Tuesday.\n\n- check logs\n- check disk");
    expect(md).toContain("**Hermes:**\n\nFound it. The job runs `restic backup`, which **fails**.");
    expect(md.indexOf("**You:**")).toBeLessThan(md.indexOf("**Hermes:**"));
    expect(md).toContain("2026-11-02 14:05 UTC");
  });

  it("names attachments without their contents, and says they aren't included", () => {
    const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "What's in these?", attachments: ["shot.png", "log_`1`.txt"] }]), AT);
    expect(md).toContain("_Attached, not included in this file:_ `shot.png`, ``log_`1`.txt``");
  });

  it("keeps the model's thinking, an interrupted reply and Approvals", () => {
    const md = chatMarkdown(
      chat([
        { kind: "thinking", id: "r", text: "Check the port first." },
        { kind: "approval", id: "ap", requestId: "req-77", command: "rm -rf /tmp/restic-cache", description: "Delete a folder", answer: "once" },
        { kind: "approval", id: "ap2", requestId: "req-78", command: "reboot", description: "Restart the server", ended: "timeout" },
        { kind: "assistant", id: "a", text: "", interrupted: true },
      ]),
      AT,
    );
    expect(md).toContain("**Hermes, thinking:**\n\n```\nCheck the port first.\n```");
    expect(md).toContain("**Approval asked:** Delete a folder\n\n```\nrm -rf /tmp/restic-cache\n```\n\n_Approved once_");
    expect(md).toContain("_No answer from here (timeout)_");
    expect(md).toContain("**Hermes:** _(stopped before it finished)_");
  });

  it("includes a tool call's output when there is one", () => {
    const md = chatMarkdown(
      chat([{ kind: "tool", id: "t", name: "terminal", args: { command: "systemctl status backup" }, status: "done", durationS: 1.2, result: "inactive (dead)" }]),
      AT,
    );
    expect(md).toContain("**Tool:** `terminal` (1.2s)");
    expect(codeBlocks(md)).toEqual(['{\n  "command": "systemctl status backup"\n}\n', "inactive (dead)\n"]);
  });

  it("says a tool call has no output instead of making one up", () => {
    const md = chatMarkdown(
      chat([
        { kind: "tool", id: "t1", name: "read_file", preview: "/etc/crontab", status: "done" },
        { kind: "tool", id: "t2", name: "terminal", status: "running" },
        { kind: "tool", id: "t3", name: "terminal", status: "stopped" },
        { kind: "tool", id: "t4", name: "patch", status: "done", result: "" },
      ]),
      AT,
    );
    expect(md).toContain("**Tool:** `read_file` `/etc/crontab`\n\n_No output: Hermes didn't keep it._");
    expect(md).toContain("_Still running when this file was saved; no output yet._");
    expect(md).toContain("_Stopped before it finished; no output._");
    expect(md).toMatch(/Hermes keeps the output of most tool calls only while the reply is running/);
    // An empty output is still an output.
    expect(codeBlocks(md)).toEqual([""]);
  });

  it("doesn't explain missing tool output when nothing is missing", () => {
    expect(chatMarkdown(chat([{ kind: "user", id: "u", text: "hi" }]), AT)).not.toMatch(/tool calls/);
  });

  describe("code fences", () => {
    it("keeps fences in a message as written", () => {
      const text = "Run this:\n\n```sh\nrestic backup /srv\n```\n\nThen check.";
      const md = chatMarkdown(chat([{ kind: "assistant", id: "a", text }]), AT);
      expect(md).toContain(text);
      expect(codeBlocks(md)).toEqual(["restic backup /srv\n"]);
    });

    it("fences tool output longer than any fence inside it, so it comes out whole", () => {
      const result = "README.md:\n```js\nconsole.log(1)\n````\n~~~\nend";
      const md = chatMarkdown(chat([{ kind: "tool", id: "t", name: "read_file", status: "done", result }]), AT);
      expect(codeBlocks(md)).toEqual([`${result}\n`]);
    });

    it("closes a fence a message left open, so it can't swallow the rest of the file", () => {
      const md = chatMarkdown(
        chat([
          { kind: "user", id: "u", text: "Here's the log:\n````\nline 1\n```\nstill log" },
          { kind: "assistant", id: "a", text: "That **log** shows the lock." },
        ]),
        AT,
      );
      expect(codeBlocks(md)).toEqual(["line 1\n```\nstill log\n"]);
      expect(html(md)).toContain("<strong>log</strong>");
    });

    it("keeps thinking and commands with fences inside whole", () => {
      const md = chatMarkdown(
        chat([
          { kind: "thinking", id: "r", text: "Maybe:\n```\nls\n```" },
          { kind: "approval", id: "ap", requestId: "r", command: "cat <<'EOF'\n```\nEOF", description: "Write a file" },
        ]),
        AT,
      );
      expect(codeBlocks(md)).toEqual(["Maybe:\n```\nls\n```\n", "cat <<'EOF'\n```\nEOF\n"]);
    });
  });

  describe("saying how complete it is", () => {
    it("says only the history loaded in the app is included", () => {
      const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "hi" }]), AT);
      expect(md).toMatch(/Only the history loaded in Hermes Chat is included/);
      expect(md).not.toMatch(/may be missing/);
    });

    it.each([
      ["still loading", { loading: true }, []],
      ["not loaded on this connection", { runtimeId: undefined }, []],
      ["failed to load", {}, [{ kind: "error", id: "load-error", text: "Couldn't load this chat: timed out" } as Item]],
    ])("warns that earlier messages may be missing when the history is %s", (_, more, items) => {
      const md = chatMarkdown(chat([...items, { kind: "user", id: "u", text: "hi" }], more), AT);
      expect(md).toMatch(/earlier messages may be missing/);
    });

    it("says a reply was still being written", () => {
      expect(chatMarkdown(chat([], { running: true }), AT)).toMatch(/A reply was still being written/);
    });
  });

  it("warns that the content may be sensitive, without claiming to have checked it", () => {
    const md = chatMarkdown(chat([{ kind: "user", id: "u", text: "the password is hunter2" }]), AT);
    expect(md).toMatch(/may contain sensitive information/);
    expect(md).toMatch(/doesn't look for or remove/);
    // Ordinary chat content stays as it was.
    expect(md).toContain("the password is hunter2");
  });

  it("leaves out session ids, the connection and the app's own error notices, and says so", () => {
    const md = chatMarkdown(
      chat([
        { kind: "user", id: "u", text: "hi" },
        { kind: "approval", id: "ap", requestId: "req-secret-77", command: "ls", description: "List" },
        { kind: "error", id: "e-1", text: "Hermes stopped answering at http://127.0.0.1:41234/" },
      ]),
      AT,
    );
    for (const internal of ["20261102_140500_abc123", "rt-9f8e7d", "req-secret-77", "127.0.0.1", "stopped answering"]) expect(md).not.toContain(internal);
    expect(md).toMatch(/Hermes Chat's own error notices are left out/);
  });
});

describe("The suggested file name", () => {
  it("is the title as a Markdown file name", () => {
    expect(exportFileName("Fix nightly backup cron")).toBe("Fix nightly backup cron.md");
  });

  it("drops characters a file name can't hold, and leading dots", () => {
    expect(exportFileName("../etc/passwd: a\nb?")).toBe("etc passwd a b.md");
    expect(exportFileName("  ")).toBe("Chat.md");
  });
});

describe("Exporting a chat", () => {
  const one = chat([{ kind: "user", id: "u", text: "hi" }]);

  it("hands the Markdown and a file name to the Save dialog, and says where it went", async () => {
    const saved: string[][] = [];
    const toast = await exportChat(one, async (md, name) => (saved.push([md, name]), "/home/liam/notes/Fix.md"), AT);
    expect(saved).toEqual([[chatMarkdown(one, AT), "Fix nightly backup cron.md"]]);
    expect(toast).toMatch(/^Exported to \/home\/liam\/notes\/Fix\.md\./);
    expect(toast).toMatch(/sensitive/);
  });

  it("does nothing when the owner cancels", async () => {
    expect(await exportChat(one, async () => null, AT)).toBeUndefined();
  });

  it("says why when saving fails", async () => {
    expect(await exportChat(one, async () => Promise.reject(new Error("Permission denied (os error 13)")), AT)).toBe(
      "Couldn't export: Permission denied (os error 13)",
    );
  });
});
