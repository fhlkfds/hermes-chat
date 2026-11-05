// A chat as a Markdown file, saved where the owner picks in the native Save dialog (`chat_export` in
// src-tauri/src/lib.rs). The Export dialog (ui/ExportChat.tsx) chooses what goes in and what is redacted, and shows the
// file before it is saved (ADR 0076). Never in it: session ids, connection details, or attachment contents.
import { invoke } from "@tauri-apps/api/core";
import type { ApprovalChoice, Chat, Item } from "./model";
import { findSecrets } from "./secrets";
import { asError } from "./tauriPipe";
import { LOAD_ERROR_ID } from "./transport";

/** Shows the Save dialog and writes `markdown` where the owner picks. The path saved to, or `null` if cancelled. */
export type SaveFile = (markdown: string, fileName: string) => Promise<string | null>;

const saveWithDialog: SaveFile = (markdown, fileName) => invoke<string | null>("chat_export", { markdown, fileName }).catch(asError);

/** Saves an export where the owner picks. The notice to show, or nothing when the owner cancelled. Throws when saving fails. */
export async function saveExport(markdown: string, fileName: string, save = saveWithDialog): Promise<string | undefined> {
  const path = await save(markdown, fileName);
  return path ? `Exported to ${path}. Read it before you share it: redaction can miss a secret.` : undefined;
}

export const exportFileName = (title: string) =>
  `${
    title
      .replace(/[/\\:*?"<>|\x00-\x1f\s]+/g, " ")
      .trim()
      .replace(/^\.+\s*/, "")
      .slice(0, 100)
      .trim() || "Chat"
  }.md`;

/** What stands in the file for redacted text. */
export const REDACTED = "[redacted]";

/** The owner's messages, Hermes's replies and its thinking: picked one by one. Tool calls and Approvals go in all or none. */
export const isMessage = (i: Item) => i.kind === "user" || i.kind === "assistant" || i.kind === "thinking";

/** What goes into an export. */
export type ExportChoice = {
  /** Ids of messages (`isMessage`) left out. */
  leftOut: ReadonlySet<string>;
  /** Tool calls, with their arguments and output, and Approvals with their commands. */
  toolCalls: boolean;
  /** The names of files attached to the owner's messages. Their contents are never in an export. */
  attachments: boolean;
  /** Text replaced with `[redacted]` everywhere in the title and the items, one after another in this order. */
  redact: readonly string[];
};

/** All of the chat, nothing redacted. */
export const WHOLE: ExportChoice = { leftOut: new Set(), toolCalls: true, attachments: true, redact: [] };

/** `chat` as Markdown: the title, notes on what is and isn't in it, then the chosen items, with `choice.redact` replaced. */
export function chatMarkdown(chat: Chat, exportedAt: Date, choice: ExportChoice = WHOLE): string {
  return render(chat, exportedAt, choice).markdown;
}

/** The title line and the chosen items, before any redaction. */
function content(chat: Chat, choice: Omit<ExportChoice, "redact">) {
  const items = chat.items.filter((i) => (isMessage(i) ? !choice.leftOut.has(i.id) : i.kind !== "error" && choice.toolCalls));
  const title = `# ${chat.title.replace(/\s+/g, " ").trim() || "Untitled chat"}`;
  return { items, title, body: items.flatMap((i) => block(i, choice.attachments)).join("\n\n") };
}

/** `chatMarkdown`, and how many places each of `choice.redact` replaced. */
function render(chat: Chat, exportedAt: Date, choice: ExportChoice): { markdown: string; counts: number[] } {
  const { items, ...text } = content(chat, choice);
  const counts = choice.redact.map((r) => {
    if (!r) return 0;
    const n = text.title.split(r).length + text.body.split(r).length - 2;
    text.title = text.title.split(r).join(REDACTED);
    text.body = text.body.split(r).join(REDACTED);
    return n;
  });
  const redacted = counts.reduce((a, b) => a + b, 0);
  const messages = chat.items.filter(isMessage).length;
  const left = chat.items.filter((i) => isMessage(i) && choice.leftOut.has(i.id)).length;
  const iso = exportedAt.toISOString();
  const missing =
    chat.loading ? "was still loading" : chat.items.some((i) => i.id === LOAD_ERROR_ID) ? "couldn't be loaded" : !chat.runtimeId ? "wasn't loaded" : undefined;
  const notes = [
    `Exported from Hermes Chat on ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC.`,
    `Only the history loaded in Hermes Chat is included: what Hermes sent when the chat was opened, and what came after.`,
    missing && `This chat's stored history ${missing}, so earlier messages may be missing.`,
    chat.running && "A reply was still being written; it is here as far as it had got.",
    left > 0 && `${left} of the chat's ${messages} messages ${left === 1 ? "was" : "were"} left out.`,
    !choice.toolCalls && chat.items.some((i) => i.kind === "tool" || i.kind === "approval") && "Tool calls and Approvals were left out.",
    !choice.attachments && items.some((i) => i.kind === "user" && i.attachments?.length) && "The names of attached files were left out.",
    items.some((i) => i.kind === "tool" && i.result === undefined && i.status === "done") &&
      "Hermes keeps the output of most tool calls only while the reply is running, so earlier tool calls have none.",
    chat.items.some((i) => i.kind === "error") && "Hermes Chat's own error notices are left out.",
    "",
    "**This file may contain sensitive information.** It has the chat as written, including anything private pasted " +
      "or printed in it, such as passwords, keys or personal details. Before saving, Hermes Chat flags some kinds of " +
      `secret, and text chosen for redaction is replaced with \`${REDACTED}\` (${redacted === 1 ? "1 place" : `${redacted} places`} in this file). ` +
      "It can miss a secret written another way.",
  ].filter((n) => n !== false && n !== undefined);
  const markdown = [text.title, notes.map((n) => (n ? `> ${n}` : ">")).join("\n"), ...(text.body ? [text.body] : [])].join("\n\n") + "\n";
  return { markdown, counts };
}

/** What the owner is choosing in the Export dialog. Every likely secret found is redacted unless the owner keeps it. */
export type ExportDraft = Omit<ExportChoice, "redact"> & {
  /** Likely secrets (`findSecrets`) the owner chose to keep in the file. */
  kept: ReadonlySet<string>;
  /** Text the owner picked in the preview to redact, in the order picked. */
  picked: readonly string[];
};

/** A new export: every message, but no tool calls, Approvals or attachment names, and every likely secret redacted. */
export const FIRST_DRAFT: ExportDraft = { leftOut: new Set(), toolCalls: false, attachments: false, kept: new Set(), picked: [] };

export type ExportPreview = {
  /** Exactly what Save writes. */
  markdown: string;
  fileName: string;
  /** Each different likely secret in what the draft includes, first found first, and how many times it is there. */
  secrets: { text: string; kind: string; times: number; redacted: boolean }[];
  /** Each picked text and how many places it replaced: 0 when it isn't in what the draft includes now. */
  picked: { text: string; times: number }[];
};

export function exportPreview(chat: Chat, draft: ExportDraft, exportedAt: Date): ExportPreview {
  const { title, body } = content(chat, draft);
  // The title and the items only: the notes are the app's own words.
  const plain = `${title}\n\n${body}`;
  const secrets = new Map<string, ExportPreview["secrets"][number]>();
  for (const s of findSecrets(plain))
    if (!secrets.has(s.text)) secrets.set(s.text, { text: s.text, kind: s.kind, times: plain.split(s.text).length - 1, redacted: !draft.kept.has(s.text) });
  // Longest first, so a secret inside a longer one doesn't leave the rest of the longer one behind.
  const flagged = [...secrets.values()].filter((s) => s.redacted).map((s) => s.text).sort((a, b) => b.length - a.length);
  const redact = [...flagged, ...draft.picked];
  const { markdown, counts } = render(chat, exportedAt, { leftOut: draft.leftOut, toolCalls: draft.toolCalls, attachments: draft.attachments, redact });
  return {
    markdown,
    fileName: exportFileName(redact.reduce((t, r) => (r ? t.split(r).join(REDACTED) : t), chat.title)),
    secrets: [...secrets.values()],
    picked: draft.picked.map((text, i) => ({ text, times: counts[flagged.length + i] })),
  };
}


const ANSWER: Record<ApprovalChoice, string> = { once: "Approved once", session: "Approved for this chat", always: "Always approved", deny: "Denied" };

function block(i: Item, attachments: boolean): string[] {
  switch (i.kind) {
    case "user": {
      const files = attachments && i.attachments?.length ? [`_Attached, not included in this file:_ ${i.attachments.map(code).join(", ")}`] : [];
      return [["**You:**", message(i.text), ...files].filter(Boolean).join("\n\n")];
    }
    case "assistant":
      return [[`**Hermes:**${i.interrupted ? " _(stopped before it finished)_" : ""}`, message(i.text)].filter(Boolean).join("\n\n")];
    case "thinking":
      return [`**Hermes, thinking:**\n\n${fenced(i.text)}`];
    case "tool": {
      const head = [`**Tool:** ${code(i.name)}`, i.preview && code(i.preview), i.summary, i.durationS != null && `(${i.durationS}s)`];
      const output =
        i.result !== undefined
          ? `Output:\n\n${fenced(i.result)}`
          : i.status === "running"
            ? "_Still running when this file was saved; no output yet._"
            : i.status === "stopped"
              ? "_Stopped before it finished; no output._"
              : "_No output: Hermes didn't keep it._";
      const args = i.args && `Arguments:\n\n${fenced(JSON.stringify(i.args, null, 2), "json")}`;
      return [[head.filter(Boolean).join(" "), args, output].filter(Boolean).join("\n\n")];
    }
    case "approval": {
      const outcome = i.answer ? ANSWER[i.answer] : i.ended ? `No answer from here (${i.ended})` : "Waiting for an answer";
      return [`**Approval asked:** ${i.description}\n\n${fenced(i.command)}\n\n_${outcome}_`];
    }
    case "error":
      // The app's own notices, not the conversation; they can name the connection.
      return [];
  }
}

const longestRun = (text: string, char: string) => Math.max(0, ...(text.match(new RegExp(`${char}+`, "g")) ?? []).map((r) => r.length));

/** Verbatim text in a fence longer than any run of backticks in it, so nothing inside can close it. */
function fenced(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Verbatim text as inline code. */
function code(text: string): string {
  const ticks = "`".repeat(longestRun(text, "`") + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * A message's Markdown as written, with a code fence it leaves open closed, so it can't swallow the rest of the file.
 * ponytail: only sees fences at the start of a line; one opened inside a block quote or list item still runs on.
 */
function message(text: string): string {
  const md = text.replace(/^\s*\n/, "").trimEnd();
  let open: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) {
      if (!(m[1][0] === "`" && m[2].includes("`"))) open = m[1];
    } else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = undefined;
  }
  return open ? `${md}\n${open}` : md;
}
